import "dotenv/config";
import pg from "pg";
import {
	dependents,
	explainDependents,
	explainWalkLevel,
	findByName,
	topCalledNodeIds,
} from "../src/modules/graph-query/queries.repo.js";
import { walk } from "../src/modules/graph-query/walk.js";

function parseArgs(argv: string[]): { repoId?: string } {
	let repoId: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg && !arg.startsWith("-")) repoId = arg;
	}
	return { repoId };
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)]!;
}

function sampleMs(fn: () => Promise<unknown>, samples: number): Promise<number[]> {
	return (async () => {
		const times: number[] = [];
		for (let i = 0; i < samples; i++) {
			const t0 = performance.now();
			await fn();
			times.push(performance.now() - t0);
		}
		return times;
	})();
}

function assertNoSeqScan(plan: string, label: string): void {
	if (/Seq Scan on edges/i.test(plan)) {
		console.error(`${label}: plan contains Seq Scan on edges`);
		console.error(plan);
		process.exit(1);
	}
}

const { repoId } = parseArgs(process.argv.slice(2));
if (!repoId) {
	console.error("usage: bench-queries <repoId>");
	process.exit(1);
}

const pooled = process.env.DATABASE_URL;
const direct = process.env.DATABASE_URL_DIRECT;
if (!pooled || !direct) {
	console.error("DATABASE_URL and DATABASE_URL_DIRECT required");
	process.exit(1);
}

const pool = new pg.Pool({ connectionString: pooled, max: 4, connectionTimeoutMillis: 15_000 });
const directPool = new pg.Pool({ connectionString: direct, max: 2, connectionTimeoutMillis: 15_000 });

try {
	await pool.query("select 1");
} catch (err) {
	console.error("DB unreachable", err);
	process.exit(1);
}

const topIds = await topCalledNodeIds(pool, repoId, 10);
if (topIds.length === 0) {
	console.error("no nodes with in_degree > 0 for repo", repoId);
	process.exit(1);
}

const samples = 11;
const depTimes: number[] = [];
const walkInTimes: number[] = [];
const walkOutTimes: number[] = [];
const nameTimes: number[] = [];

for (const nodeId of topIds) {
	const row = await dependents(pool, repoId, nodeId, { types: ["calls"], limit: 500 });
	if (row.length === 0) continue;
	const name = nodeId.split("#").pop() ?? nodeId;

	depTimes.push(...(await sampleMs(() => dependents(pool, repoId, nodeId, { types: ["calls"] }), samples)));
	walkInTimes.push(
		...(await sampleMs(
			() => walk(pool, repoId, [nodeId], { direction: "in", types: ["calls"], maxDepth: 3 }),
			samples,
		)),
	);
	walkOutTimes.push(
		...(await sampleMs(
			() => walk(pool, repoId, [nodeId], { direction: "out", types: ["calls"], maxDepth: 3 }),
			samples,
		)),
	);
	nameTimes.push(...(await sampleMs(() => findByName(pool, repoId, name, { limit: 20 }), samples)));
}

const report = {
	repoId,
	topNodes: topIds.length,
	dependentsMs: {
		p50: Math.round(percentile([...depTimes].sort((a, b) => a - b), 50)),
		p95: Math.round(percentile([...depTimes].sort((a, b) => a - b), 95)),
	},
	walkInDepth3Ms: {
		p50: Math.round(percentile([...walkInTimes].sort((a, b) => a - b), 50)),
		p95: Math.round(percentile([...walkInTimes].sort((a, b) => a - b), 95)),
	},
	walkOutDepth3Ms: {
		p50: Math.round(percentile([...walkOutTimes].sort((a, b) => a - b), 50)),
		p95: Math.round(percentile([...walkOutTimes].sort((a, b) => a - b), 95)),
	},
	findByNameMs: {
		p50: Math.round(percentile([...nameTimes].sort((a, b) => a - b), 50)),
		p95: Math.round(percentile([...nameTimes].sort((a, b) => a - b), 95)),
	},
};

const explainClient = await directPool.connect();
try {
	const depTarget = topIds[0]!;
	const depExplain = await explainDependents(explainClient, repoId, depTarget, ["calls"]);
	assertNoSeqScan(depExplain.plan, "dependents");
	if (depExplain.executionMs >= 50) {
		console.error(`dependents execution ${depExplain.executionMs}ms >= 50ms`);
		process.exit(1);
	}

	const walkExplain = await explainWalkLevel(explainClient, repoId, "in", [depTarget], ["calls"]);
	assertNoSeqScan(walkExplain.plan, "walk level");
	if (walkExplain.executionMs >= 50) {
		console.error(`walk level execution ${walkExplain.executionMs}ms >= 50ms`);
		process.exit(1);
	}

	const topPlanLine =
		depExplain.plan
			.split("\n")
			.find((l) => /Index Scan|Bitmap|Seq Scan/.test(l)) ?? depExplain.plan.split("\n")[1];

	const explain = {
		dependents: { executionMs: depExplain.executionMs, topPlanLine },
		walkLevel: {
			executionMs: walkExplain.executionMs,
			topPlanLine: walkExplain.plan.split("\n")[1],
		},
	};
	console.log(JSON.stringify({ ...report, explain }, null, 2));
} finally {
	explainClient.release();
}

await pool.end();
await directPool.end();
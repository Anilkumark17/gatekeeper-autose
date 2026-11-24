import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { extractFile } from "../src/modules/indexing/extract-file.js";
import { detectLang } from "../src/modules/indexing/lang.js";
import { classifyTestFile } from "../src/modules/test-map/classify.js";
import { testsCoveringNode } from "../src/modules/test-map/graph-query.adapter.js";
import {
	listFileNodePaths,
	outgoingProductEdgeCount,
	PRODUCT_EDGE_TYPES,
	sampleTargetSymbols,
} from "../src/modules/test-map/test-map.repo.js";

function parseArgs(argv: string[]): {
	repoId?: string;
	n: number;
	seed: string;
	depths?: number[];
} {
	let repoId: string | undefined;
	let n = 200;
	let seed = "1";
	let depths: number[] | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--n") {
			const v = argv[++i];
			if (v) n = Number.parseInt(v, 10);
			continue;
		}
		if (arg === "--seed") {
			const v = argv[++i];
			if (v) seed = v;
			continue;
		}
		if (arg === "--depths") {
			const v = argv[++i];
			if (v) {
				depths = v
					.split(/[,\s]+/)
					.map((d) => Number.parseInt(d.trim(), 10))
					.filter(Number.isFinite);
			}
			continue;
		}
		if (arg && !arg.startsWith("-")) repoId = arg;
	}
	return { repoId, n, seed, depths };
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)]!;
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const s = [...values].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function isProductPath(filePath: string): boolean {
	const role = classifyTestFile(filePath);
	return role === null;
}

const { repoId, n, seed, depths: depthSweep } = parseArgs(process.argv.slice(2));
if (!repoId) {
	console.error("usage: bench-testmap <repoId> [--n 200] [--seed 1] [--depths 2,3,4]");
	process.exit(1);
}

const pooled = process.env.DATABASE_URL;
if (!pooled) {
	console.error("DATABASE_URL required");
	process.exit(1);
}

const pool = new pg.Pool({ connectionString: pooled, max: 4, connectionTimeoutMillis: 30_000 });

try {
	await pool.query("select 1");
} catch (err) {
	console.error("DB unreachable", err);
	process.exit(1);
}

const repoRow = await pool.query<{ id: string; root: string; graph_version: string }>(
	`SELECT id, root, graph_version FROM repos WHERE id = $1`,
	[repoId],
);
if (repoRow.rows.length === 0) {
	console.error(
		`repo not found: ${repoId}. Run: pnpm bench:build bench/cal.com --repo-id ${repoId}`,
	);
	await pool.end();
	process.exit(1);
}

const repoRoot = repoRow.rows[0]?.root ?? "";

const filePaths = await listFileNodePaths(pool, repoId);
const classification = { test: 0, e2e: 0, support: 0, null: 0 };
const roleByPath = new Map<string, ReturnType<typeof classifyTestFile>>();

for (const p of filePaths) {
	const role = classifyTestFile(p);
	roleByPath.set(p, role);
	if (role === "test") classification.test++;
	else if (role === "e2e") classification.e2e++;
	else if (role === "support") classification.support++;
	else classification.null++;
}

const unitTestPaths = filePaths.filter((p) => classifyTestFile(p) === "test");
const linkCounts = await outgoingProductEdgeCount(
	pool,
	repoId,
	unitTestPaths,
	PRODUCT_EDGE_TYPES,
	isProductPath,
);

let linked = 0;
const zeroLink: string[] = [];
for (const p of unitTestPaths) {
	if ((linkCounts.get(p) ?? 0) >= 1) linked++;
	else zeroLink.push(p);
}
zeroLink.sort();
const linkPct = unitTestPaths.length === 0 ? 0 : (linked / unitTestPaths.length) * 100;

const symbols = await sampleTargetSymbols(pool, repoId, n, seed, isProductPath);

if (depthSweep && depthSweep.length > 0) {
	const byDepth: Record<
		string,
		{
			p50: number;
			p95: number;
			withCoverPct: number;
			truncatedPct: number;
		}
	> = {};
	for (const maxDepth of depthSweep) {
		const lookupMs: number[] = [];
		let truncatedCount = 0;
		let withCover = 0;
		for (const symbolId of symbols) {
			const t0 = performance.now();
			const result = await testsCoveringNode(pool, repoId, symbolId, { maxDepth });
			lookupMs.push(performance.now() - t0);
			if (result.truncated) truncatedCount++;
			if (result.tests.length >= 1) withCover++;
		}
		const sortedMs = [...lookupMs].sort((a, b) => a - b);
		byDepth[String(maxDepth)] = {
			p50: Math.round(percentile(sortedMs, 50)),
			p95: Math.round(percentile(sortedMs, 95)),
			withCoverPct: Math.round((withCover / symbols.length) * 1000) / 10,
			truncatedPct: Math.round((truncatedCount / symbols.length) * 1000) / 10,
		};
	}
	console.log(
		JSON.stringify(
			{
				repoId,
				seed,
				n,
				symbolsSampled: symbols.length,
				depthSweep: byDepth,
			},
			null,
			2,
		),
	);
	console.log("\n--- depth sweep ---");
	console.table(byDepth);
	await pool.end();
	process.exit(0);
}

const lookupMs: number[] = [];
let truncatedCount = 0;
let withCover = 0;
const testsPerSymbol: number[] = [];
const coverBySymbol = new Map<string, { hops: number; testPath: string }[]>();

for (const symbolId of symbols) {
	const t0 = performance.now();
	const result = await testsCoveringNode(pool, repoId, symbolId);
	lookupMs.push(performance.now() - t0);
	if (result.truncated) truncatedCount++;
	const count = result.tests.length;
	testsPerSymbol.push(count);
	if (count >= 1) withCover++;
	const top = [...result.tests]
		.sort(
			(a, b) => a.hops - b.hops || (a.testPath < b.testPath ? -1 : a.testPath > b.testPath ? 1 : 0),
		)
		.slice(0, 3)
		.map((t) => ({ testPath: t.testPath, hops: t.hops }));
	coverBySymbol.set(symbolId, top);
}

const sortedMs = [...lookupMs].sort((a, b) => a - b);
const coverPct = symbols.length === 0 ? 0 : (withCover / symbols.length) * 100;
const truncatedPct = symbols.length === 0 ? 0 : (truncatedCount / symbols.length) * 100;

const examples: { symbolId: string; tests: { testPath: string; hops: number }[] }[] = [];
for (const sym of symbols) {
	const top = coverBySymbol.get(sym) ?? [];
	if (top.length === 0) continue;
	examples.push({ symbolId: sym, tests: top });
	if (examples.length >= 3) break;
}
while (examples.length < 3 && symbols.length > examples.length) {
	const sym = symbols[examples.length]!;
	examples.push({ symbolId: sym, tests: coverBySymbol.get(sym) ?? [] });
}

const gateB = linkPct >= 80;
const gateLatency = percentile(sortedMs, 95) <= 1000;
const gateTrunc = truncatedPct <= 5;

const report = {
	repoId,
	seed,
	n,
	A_classification: {
		fileNodes: filePaths.length,
		test: classification.test,
		e2e: classification.e2e,
		support: classification.support,
		null: classification.null,
	},
	B_linkHealth: {
		unitTestFiles: unitTestPaths.length,
		linkedToProduct: linked,
		linkedPct: Math.round(linkPct * 10) / 10,
		zeroLinkFirst10: zeroLink.slice(0, 10),
	},
	C_lookup: {
		symbolsSampled: symbols.length,
		withCoveringTestPct: Math.round(coverPct * 10) / 10,
		testsPerSymbolMedian: median(testsPerSymbol),
		testsPerSymbolMax: testsPerSymbol.length === 0 ? 0 : Math.max(...testsPerSymbol),
		truncatedPct: Math.round(truncatedPct * 10) / 10,
		latencyMs: {
			p50: Math.round(percentile(sortedMs, 50)),
			p95: Math.round(percentile(sortedMs, 95)),
			max: Math.round(sortedMs[sortedMs.length - 1] ?? 0),
		},
	},
	D_examples: examples,
	gates: {
		B_link80pct: gateB ? "PASS" : "FAIL",
		C_p95Latency1000ms: gateLatency ? "PASS" : "FAIL",
		C_truncated5pct: gateTrunc ? "PASS" : "FAIL",
	},
};

let B_attribution: unknown;
if (!gateB && zeroLink.length > 0) {
	const pick = zeroLink.slice(0, 3);
	B_attribution = [];
	for (const rel of pick) {
		const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
		let src: string;
		try {
			src = await readFile(abs, "utf8");
		} catch {
			(B_attribution as object[]).push({ file: rel, error: "read failed" });
			continue;
		}
		const lang = detectLang(rel) ?? "ts";
		const facts = extractFile(rel, src, lang);
		const itCalls = facts.calls.filter(
			(c) => c.callee.name === "it" || c.callee.name === "describe" || c.callee.name === "test",
		);
		(B_attribution as object[]).push({
			file: rel,
			itDescribeCallbacks: itCalls.map((c) => ({
				line: c.line,
				callee: c.callee.name,
				fromId: c.fromId,
			})),
			allCallsCount: facts.calls.length,
			sampleCalls: facts.calls.slice(0, 8).map((c) => ({
				line: c.line,
				callee: c.callee.name,
				fromId: c.fromId,
			})),
		});
	}
	if (B_attribution !== undefined) {
		(report as { B_attribution?: unknown }).B_attribution = B_attribution;
	}
}

console.log(JSON.stringify(report, null, 2));

console.log("\n--- gates ---");
console.log(
	`B (>=80% unit tests link to product): ${report.gates.B_link80pct} (${report.B_linkHealth.linkedPct}%)`,
);
console.log(
	`C p95 latency <= 1000ms: ${report.gates.C_p95Latency1000ms} (${report.C_lookup.latencyMs.p95}ms)`,
);
console.log(
	`C truncated <= 5%: ${report.gates.C_truncated5pct} (${report.C_lookup.truncatedPct}%)`,
);

console.log("\n--- A classification ---");
console.table(report.A_classification);

console.log("\n--- B link health ---");
console.log(
	`${report.B_linkHealth.linkedToProduct}/${report.B_linkHealth.unitTestFiles} unit test files link to product`,
);

await pool.end();

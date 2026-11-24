import path from "node:path";
import pino from "pino";
import type { DbBundle } from "../../../db/client.js";
import { discover } from "../discover.js";
import type { FileFacts } from "../extract-file.js";
import { createExtractPool } from "../extract-pool.js";
import { saveDiscovery } from "../files.repo.js";
import { buildEdges } from "../graph/build-edges.js";
import { computeRecency } from "../recency/recency.js";
import { createResolver } from "../resolve/resolve-imports.js";
import { fileRecencyRowsFromResult, fileRecencyToCsv } from "./file-recency.js";
import {
	callBindingReconcile,
	compileGraph,
	countRepoGraph,
	graphDeterminismHash,
	loadAndSwapGraph,
	type TableCounts,
} from "./graph.repo.js";

const log = pino({ level: process.env.LOG_LEVEL ?? "info" });

export interface BuildFullOptions {
	simulateSwapFailure?: boolean;
	/** Test hook: replace computeRecency (default: real implementation). */
	computeRecencyFn?: typeof computeRecency;
}

export interface BuildRecencyResult {
	status: "ok" | "skipped" | "failed";
	reason?: string;
	files: number;
	ms: number;
	boundaryPct?: number;
}

export interface BuildFullStats {
	discoverMs: number;
	saveFilesMs: number;
	extractMs: number;
	resolveMs: number;
	edgesMs: number;
	recencyMs: number;
	recency: BuildRecencyResult;
	copyMs: number;
	swapMs: number;
	totalMs: number;
	counts: TableCounts;
	edgesByType: Record<string, number>;
	callBinding: ReturnType<typeof callBindingReconcile>;
	graphHash: string;
	graphVersion: number;
}

async function graphVersion(db: DbBundle["db"], repoId: string): Promise<number> {
	const { repos } = await import("../../../db/schema.js");
	const { eq } = await import("drizzle-orm");
	const [row] = await db.select({ v: repos.graphVersion }).from(repos).where(eq(repos.id, repoId));
	return Number(row?.v ?? 0);
}

function symbolsByFile(facts: Map<string, FileFacts>): Map<string, FileFacts["symbols"]> {
	const out = new Map<string, FileFacts["symbols"]>();
	for (const [p, f] of facts) out.set(p, f.symbols);
	return out;
}

export async function runFileRecencyStep(
	repoId: string,
	root: string,
	discovery: Awaited<ReturnType<typeof discover>>,
	facts: Map<string, FileFacts>,
	computeFn: typeof computeRecency,
): Promise<{ recency: BuildRecencyResult; fileRecencyCsv: (string | number | boolean)[][] }> {
	if (discovery.mode !== "git") {
		return {
			recency: { status: "skipped", reason: "discovery.mode=walk", files: 0, ms: 0 },
			fileRecencyCsv: [],
		};
	}
	const t0 = performance.now();
	try {
		const result = await computeFn(root, discovery, symbolsByFile(facts), { blame: "none" });
		const indexed = new Set(discovery.files.map((f) => f.path));
		const rows = fileRecencyRowsFromResult(repoId, indexed, result);
		return {
			recency: {
				status: "ok",
				files: rows.length,
				ms: result.stats.ms,
				boundaryPct: result.stats.filesBoundaryPct,
			},
			fileRecencyCsv: fileRecencyToCsv(rows),
		};
	} catch (err) {
		const ms = Math.round(performance.now() - t0);
		const reason = err instanceof Error ? err.message : String(err);
		log.warn({ err: reason }, "file recency failed");
		return {
			recency: { status: "failed", reason, files: 0, ms },
			fileRecencyCsv: [],
		};
	}
}

export async function buildFull(
	repoRoot: string,
	repoId: string,
	db: DbBundle,
	opts: BuildFullOptions = {},
): Promise<BuildFullStats> {
	const t0 = performance.now();
	const root = path.resolve(repoRoot);

	const tDiscover = performance.now();
	const discovery = await discover(root);
	const discoverMs = Math.round(performance.now() - tDiscover);

	const tSave = performance.now();
	const save = await saveDiscovery(db.db, repoId, discovery);
	const saveFilesMs = save.ms || Math.round(performance.now() - tSave);

	const pool = createExtractPool();
	const tasks = discovery.files.map((f) => ({ path: f.path, abs: f.abs, lang: f.lang }));
	const facts = new Map<string, FileFacts>();
	const tExtract = performance.now();
	try {
		for await (const row of pool.run(tasks)) {
			if (row.ok) facts.set(row.path, row.facts);
		}
	} finally {
		await pool.close();
	}
	const extractMs = Math.round(performance.now() - tExtract);

	const tResolve = performance.now();
	const resolver = createResolver(root, discovery);
	for (const f of discovery.files) {
		const fileFacts = facts.get(f.path);
		if (!fileFacts) continue;
		for (const imp of fileFacts.imports) resolver.resolve(f.path, imp);
	}
	const resolveMs = Math.round(performance.now() - tResolve);

	const tEdges = performance.now();
	const graph = buildEdges(facts, resolver);
	const edgesMs = Math.round(performance.now() - tEdges);

	const tRecency = performance.now();
	const computeFn = opts.computeRecencyFn ?? computeRecency;
	const { recency: recencyResult, fileRecencyCsv } = await runFileRecencyStep(
		repoId,
		root,
		discovery,
		facts,
		computeFn,
	);
	const recencyMs = Math.round(performance.now() - tRecency);

	const compiled = compileGraph(repoId, discovery, facts, graph);
	compiled.fileRecencyCsv = fileRecencyCsv;

	const { copyMs, swapMs } = await loadAndSwapGraph(db.direct, repoId, compiled, {
		simulateSwapFailure: opts.simulateSwapFailure,
	});

	const counts = await countRepoGraph(db.db, repoId);
	const graphHash = await graphDeterminismHash(db.db, repoId);
	const version = await graphVersion(db.db, repoId);

	return {
		discoverMs,
		saveFilesMs,
		extractMs,
		resolveMs,
		edgesMs,
		recencyMs,
		recency: recencyResult,
		copyMs,
		swapMs,
		totalMs: Math.round(performance.now() - t0),
		counts,
		edgesByType: graph.edgesByType,
		callBinding: callBindingReconcile(graph),
		graphHash,
		graphVersion: version,
	};
}

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { discover, type DiscoveredFile } from "../src/modules/indexing/discover.js";
import { extractFile, type FileFacts } from "../src/modules/indexing/extract-file.js";
import { createExtractPool } from "../src/modules/indexing/extract-pool.js";
import type { SymbolKind } from "../src/modules/indexing/symbols.js";
import type { RawImport } from "../src/modules/indexing/imports.js";

interface BenchFlags {
	root?: string;
	snapshot?: string;
	against?: string;
	workers?: number;
	compare?: boolean;
}

interface SnapshotRow {
	path: string;
	contentHash: string;
	symbols: number;
	calls: number;
	refs: number;
	renders: number;
}

interface RunMetrics {
	threads: number;
	wallS: number;
	files: number;
	bytes: number;
	extractMs: number[];
	snapshotRows: SnapshotRow[];
	parseErrors: number;
	extractErrors: number;
	extractTimeouts: number;
	totals: {
		symbols: number;
		imports: number;
		exports: number;
		calls: number;
		refs: number;
		renders: number;
	};
	symbolKinds: Record<string, number>;
	importKinds: Record<string, number>;
	zeroSymbolFiles: number;
	peakRssMb: number;
}

function parseCli(argv: string[]): BenchFlags {
	const flags: BenchFlags = {};
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--snapshot") {
			flags.snapshot = argv[++i];
		} else if (arg === "--against") {
			flags.against = argv[++i];
		} else if (arg === "--workers") {
			const next = argv[i + 1];
			if (next && !next.startsWith("-")) {
				flags.workers = Number(next);
				i++;
			} else {
				flags.workers = -1;
			}
		} else if (arg === "--compare") {
			flags.compare = true;
		} else if (!arg.startsWith("-") && !flags.root) {
			flags.root = arg;
		}
	}
	return flags;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)] ?? 0;
}

function snapshotRows(rows: SnapshotRow[]): SnapshotRow[] {
	return [...rows].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function rowsEqual(a: SnapshotRow[], b: SnapshotRow[]): string[] {
	const diffs: string[] = [];
	const byPath = new Map(b.map((r) => [r.path, r]));
	if (a.length !== b.length) diffs.push(`row count ${a.length} vs ${b.length}`);
	for (const row of a) {
		const other = byPath.get(row.path);
		if (!other) {
			diffs.push(`missing in baseline: ${row.path}`);
			continue;
		}
		if (row.contentHash !== other.contentHash) diffs.push(`hash ${row.path}`);
		if (row.symbols !== other.symbols) diffs.push(`symbols ${row.path}: ${row.symbols} vs ${other.symbols}`);
		if (row.calls !== other.calls) diffs.push(`calls ${row.path}: ${row.calls} vs ${other.calls}`);
		if (row.refs !== other.refs) diffs.push(`refs ${row.path}: ${row.refs} vs ${other.refs}`);
		if (row.renders !== other.renders) diffs.push(`renders ${row.path}: ${row.renders} vs ${other.renders}`);
	}
	for (const row of b) {
		if (!a.some((r) => r.path === row.path)) diffs.push(`extra in baseline: ${row.path}`);
	}
	return diffs;
}

function ingestFacts(
	facts: FileFacts,
	ms: number,
	metrics: RunMetrics,
	extractMsByPath: Map<string, number>,
): void {
	extractMsByPath.set(facts.path, ms);
	if (facts.parse.hasError) metrics.parseErrors++;
	if (facts.symbols.length === 0) metrics.zeroSymbolFiles++;
	metrics.totals.symbols += facts.symbols.length;
	metrics.totals.imports += facts.imports.length;
	metrics.totals.exports += facts.exports.length;
	metrics.totals.calls += facts.calls.length;
	metrics.totals.refs += facts.refs.length;
	metrics.totals.renders += facts.renders.length;
	for (const s of facts.symbols) {
		metrics.symbolKinds[s.kind] = (metrics.symbolKinds[s.kind] ?? 0) + 1;
	}
	for (const imp of facts.imports) {
		metrics.importKinds[imp.kind] = (metrics.importKinds[imp.kind] ?? 0) + 1;
	}
	metrics.snapshotRows.push({
		path: facts.path,
		contentHash: facts.contentHash,
		symbols: facts.symbols.length,
		calls: facts.calls.length,
		refs: facts.refs.length,
		renders: facts.renders.length,
	});
}

function summarize(metrics: RunMetrics, files: DiscoveredFile[], extractMsByPath: Map<string, number>): void {
	metrics.extractMs = files.map((f) => extractMsByPath.get(f.path) ?? 0);
	metrics.bytes = files.reduce((sum, f) => sum + f.size, 0);
}

function printSummary(metrics: RunMetrics): void {
	const sorted = [...metrics.extractMs].sort((a, b) => a - b);
	const body = {
		threads: metrics.threads,
		files: metrics.files,
		mb: Number((metrics.bytes / (1024 * 1024)).toFixed(3)),
		wallS: Number(metrics.wallS.toFixed(3)),
		filesPerSec: Number((metrics.files / Math.max(metrics.wallS, 0.001)).toFixed(1)),
		p50Ms: percentile(sorted, 50),
		p95Ms: percentile(sorted, 95),
		p99Ms: percentile(sorted, 99),
		parseErrorRatePct: Number(((metrics.parseErrors / Math.max(1, metrics.files)) * 100).toFixed(2)),
		extract_error: metrics.extractErrors,
		extract_timeout: metrics.extractTimeouts,
		totalSymbols: metrics.totals.symbols,
		totalImports: metrics.totals.imports,
		totalExports: metrics.totals.exports,
		totalCalls: metrics.totals.calls,
		totalRefs: metrics.totals.refs,
		totalRenders: metrics.totals.renders,
		symbolKinds: metrics.symbolKinds,
		importKinds: metrics.importKinds,
		zeroSymbolFilesPct: Number(((metrics.zeroSymbolFiles / Math.max(1, metrics.files)) * 100).toFixed(2)),
		peakRssMb: Number((metrics.peakRssMb / (1024 * 1024)).toFixed(1)),
		slowestMs: sorted.length ? Number(sorted[sorted.length - 1]!.toFixed(3)) : 0,
	};
	console.log(JSON.stringify(body));
}

async function runSequential(files: DiscoveredFile[]): Promise<RunMetrics> {
	const wallStart = performance.now();
	let peakRss = process.memoryUsage().rss;
	const metrics: RunMetrics = {
		threads: 1,
		wallS: 0,
		files: files.length,
		bytes: 0,
		extractMs: [],
		snapshotRows: [],
		parseErrors: 0,
		extractErrors: 0,
		extractTimeouts: 0,
		totals: { symbols: 0, imports: 0, exports: 0, calls: 0, refs: 0, renders: 0 },
		symbolKinds: {},
		importKinds: {},
		zeroSymbolFiles: 0,
		peakRssMb: 0,
	};
	const extractMsByPath = new Map<string, number>();

	for (let i = 0; i < files.length; i++) {
		const file = files[i]!;
		const text = await readFile(file.abs, "utf8");
		const t0 = performance.now();
		const facts = extractFile(file.path, text, file.lang);
		const ms = performance.now() - t0;
		ingestFacts(facts, ms, metrics, extractMsByPath);
		if (i % 500 === 499 || i === files.length - 1) {
			peakRss = Math.max(peakRss, process.memoryUsage().rss);
		}
	}
	summarize(metrics, files, extractMsByPath);
	metrics.wallS = (performance.now() - wallStart) / 1000;
	metrics.peakRssMb = peakRss;
	return metrics;
}

async function runPool(files: DiscoveredFile[], workerThreads?: number): Promise<RunMetrics> {
	const pool = createExtractPool(workerThreads && workerThreads > 0 ? { threads: workerThreads } : {});
	const wallStart = performance.now();
	let peakRss = process.memoryUsage().rss;
	const metrics: RunMetrics = {
		threads: pool.threads,
		wallS: 0,
		files: files.length,
		bytes: 0,
		extractMs: [],
		snapshotRows: [],
		parseErrors: 0,
		extractErrors: 0,
		extractTimeouts: 0,
		totals: { symbols: 0, imports: 0, exports: 0, calls: 0, refs: 0, renders: 0 },
		symbolKinds: {} as Record<SymbolKind, number>,
		importKinds: {} as Record<RawImport["kind"], number>,
		zeroSymbolFiles: 0,
		peakRssMb: 0,
	};
	const extractMsByPath = new Map<string, number>();
	const tasks = files.map((f) => ({ path: f.path, abs: f.abs, lang: f.lang }));

	try {
		for await (const result of pool.run(tasks, (d, total) => {
			if (d % 100 === 0 || d === total) peakRss = Math.max(peakRss, process.memoryUsage().rss);
		})) {
			if (result.ok) {
				ingestFacts(result.facts, result.ms, metrics, extractMsByPath);
			} else if (result.reason === "extract_error") metrics.extractErrors++;
			else metrics.extractTimeouts++;
		}
	} finally {
		await pool.destroy();
	}
	summarize(metrics, files, extractMsByPath);
	metrics.wallS = (performance.now() - wallStart) / 1000;
	metrics.peakRssMb = peakRss;
	return metrics;
}

function countMapsEqual(a: Record<string, number>, b: Record<string, number>): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const k of keys) {
		if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
	}
	return true;
}

function compareRuns(a: RunMetrics, b: RunMetrics): string | null {
	const rowsA = snapshotRows(a.snapshotRows);
	const rowsB = snapshotRows(b.snapshotRows);
	const diffs = rowsEqual(rowsA, rowsB);
	if (diffs.length > 0) return diffs[0] ?? "row mismatch";
	if (a.totals.calls !== b.totals.calls) return `totalCalls ${a.totals.calls} vs ${b.totals.calls}`;
	if (a.totals.refs !== b.totals.refs) return `totalRefs ${a.totals.refs} vs ${b.totals.refs}`;
	if (a.totals.symbols !== b.totals.symbols) return `totalSymbols ${a.totals.symbols} vs ${b.totals.symbols}`;
	if (!countMapsEqual(a.symbolKinds, b.symbolKinds)) return "symbolKinds differ";
	if (!countMapsEqual(a.importKinds, b.importKinds)) return "importKinds differ";
	return null;
}

async function main(): Promise<void> {
	const flags = parseCli(process.argv);
	if (!flags.root) {
		throw new Error(
			"Usage: tsx scripts/bench-extract.ts <repo-root> [--workers [n]] [--compare] [--snapshot <file>] [--against <file>]",
		);
	}
	if (flags.snapshot && flags.against) throw new Error("Use only one of --snapshot or --against");

	const root = path.resolve(flags.root);
	const discovery = await discover(root);
	console.log(
		JSON.stringify({
			indexed: discovery.counts.indexed,
			skipped: discovery.counts.skipped,
			discoverMs: discovery.ms,
			source: discovery.source,
		}),
	);

	if (flags.compare) {
		const seq = await runSequential(discovery.files);
		printSummary(seq);
		const par = await runPool(discovery.files, flags.workers && flags.workers > 0 ? flags.workers : undefined);
		printSummary(par);
		const diff = compareRuns(seq, par);
		if (diff) {
			console.error(`COMPARE DIFF: ${diff}`);
			process.exit(1);
		}
		console.log("IDENTICAL");
		return;
	}

	const metrics =
		flags.workers !== undefined
			? await runPool(discovery.files, flags.workers > 0 ? flags.workers : undefined)
			: await runSequential(discovery.files);

	printSummary(metrics);

	const rows = snapshotRows(metrics.snapshotRows);
	const slowest = discovery.files
		.map((file, idx) => ({
			path: file.path,
			ms: metrics.extractMs[idx] ?? 0,
			bytes: file.size,
		}))
		.sort((a, b) => b.ms - a.ms)
		.slice(0, 10);
	for (const row of slowest) {
		console.log(`${Math.round(row.ms)}ms\t${Math.round(row.bytes / 1024)}KB\t${row.path}`);
	}

	if (flags.snapshot) {
		const outPath = path.resolve(flags.snapshot);
		await writeFile(outPath, `${JSON.stringify(rows, null, 0)}\n`, "utf8");
		console.log(`SNAPSHOT written: ${outPath} (${rows.length} files)`);
	}

	if (flags.against) {
		const baselinePath = path.resolve(flags.against);
		const raw = await readFile(baselinePath, "utf8");
		const baseline = snapshotRows(JSON.parse(raw) as SnapshotRow[]);
		const diffs = rowsEqual(rows, baseline);
		if (diffs.length === 0) {
			console.log("IDENTICAL");
		} else {
			console.error(`DIFF (${diffs.length}):`);
			for (const d of diffs.slice(0, 50)) console.error(`  ${d}`);
			process.exit(1);
		}
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
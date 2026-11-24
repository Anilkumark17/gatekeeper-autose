import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { discover } from "../src/modules/indexing/discover.js";
import { extractFile } from "../src/modules/indexing/extract-file.js";

interface BenchFlags {
	root?: string;
	snapshot?: string;
	against?: string;
}

interface SnapshotRow {
	path: string;
	contentHash: string;
	symbols: number;
	calls: number;
	refs: number;
	renders: number;
}

function parseCli(argv: string[]): BenchFlags {
	const flags: BenchFlags = {};
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--snapshot") {
			flags.snapshot = argv[++i];
		} else if (arg === "--against") {
			flags.against = argv[++i];
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

async function main(): Promise<void> {
	const { root: rootArg, snapshot, against } = parseCli(process.argv);
	if (!rootArg) {
		throw new Error(
			"Usage: tsx scripts/bench-extract.ts <repo-root> [--snapshot <file>] [--against <file>]",
		);
	}
	if (snapshot && against) throw new Error("Use only one of --snapshot or --against");

	const root = path.resolve(rootArg);
	const discovery = await discover(root);
	console.log(
		JSON.stringify({
			indexed: discovery.counts.indexed,
			skipped: discovery.counts.skipped,
			discoverMs: discovery.ms,
			source: discovery.source,
		}),
	);

	const wallStart = performance.now();
	const extractMs: number[] = [];
	const snapshotData: SnapshotRow[] = [];
	let bytes = 0;
	let parseErrors = 0;
	let calls = 0;
	let refs = 0;
	let peakRss = process.memoryUsage().rss;

	for (let i = 0; i < discovery.files.length; i++) {
		const file = discovery.files[i]!;
		const text = await readFile(file.abs, "utf8");
		bytes += text.length;
		const t0 = performance.now();
		const facts = extractFile(file.path, text, file.lang);
		extractMs.push(performance.now() - t0);
		if (facts.parse.hasError) parseErrors++;
		calls += facts.calls.length;
		refs += facts.refs.length;
		snapshotData.push({
			path: file.path,
			contentHash: facts.contentHash,
			symbols: facts.symbols.length,
			calls: facts.calls.length,
			refs: facts.refs.length,
			renders: facts.renders.length,
		});
		if (i % 500 === 499 || i === discovery.files.length - 1) {
			peakRss = Math.max(peakRss, process.memoryUsage().rss);
		}
	}

	const wallS = (performance.now() - wallStart) / 1000;
	const sorted = [...extractMs].sort((a, b) => a - b);
	const slowest = [...discovery.files]
		.map((file, idx) => ({ path: file.path, ms: extractMs[idx] ?? 0, bytes: file.size }))
		.sort((a, b) => b.ms - a.ms)
		.slice(0, 10);

	const summary = {
		files: discovery.files.length,
		mb: Number((bytes / (1024 * 1024)).toFixed(3)),
		wallS: Number(wallS.toFixed(3)),
		filesPerSec: Number((discovery.files.length / wallS).toFixed(1)),
		p50Ms: percentile(sorted, 50),
		p95Ms: percentile(sorted, 95),
		p99Ms: percentile(sorted, 99),
		parseErrorRatePct: Number(((parseErrors / Math.max(1, discovery.files.length)) * 100).toFixed(2)),
		totalCalls: calls,
		totalRefs: refs,
		peakRssMb: Number((peakRss / (1024 * 1024)).toFixed(1)),
		slowestMs: slowest[0] ? Number(slowest[0].ms.toFixed(3)) : 0,
	};
	console.log(JSON.stringify(summary));

	for (const row of slowest) {
		console.log(`${Math.round(row.ms)}ms\t${Math.round(row.bytes / 1024)}KB\t${row.path}`);
	}

	const rows = snapshotRows(snapshotData);

	if (snapshot) {
		const outPath = path.resolve(snapshot);
		await writeFile(outPath, `${JSON.stringify(rows, null, 0)}\n`, "utf8");
		console.log(`SNAPSHOT written: ${outPath} (${rows.length} files)`);
	}

	if (against) {
		const baselinePath = path.resolve(against);
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
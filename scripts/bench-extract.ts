import { readFile } from "node:fs/promises";
import path from "node:path";
import { discover } from "../src/modules/indexing/discover.js";
import { extractFile } from "../src/modules/indexing/extract-file.js";

const rootArg = process.argv[2];
if (!rootArg) throw new Error("Usage: tsx scripts/bench-extract.ts <repo-root>");

const root = path.resolve(rootArg);

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.ceil((p / 100) * sorted.length) - 1;
	return sorted[Math.max(0, idx)] ?? 0;
}

async function main(): Promise<void> {
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

	console.log(
		JSON.stringify({
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
		}),
	);

	for (const row of slowest) {
		console.log(`${Math.round(row.ms)}ms\t${Math.round(row.bytes / 1024)}KB\t${row.path}`);
	}
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { discover } from "../src/modules/indexing/discover.js";
import type { FileFacts } from "../src/modules/indexing/extract-file.js";
import { createExtractPool } from "../src/modules/indexing/extract-pool.js";
import { bindableMemberRatePct, buildEdgesFromContext, edgesPerFile } from "../src/modules/indexing/graph/build-edges.js";
import { createGraphBindContext } from "../src/modules/indexing/graph/bind.js";
import { createResolver, resolutionRate } from "../src/modules/indexing/resolve/resolve-imports.js";

interface Flags {
	root?: string;
	snapshot?: string;
	against?: string;
}

function parseCli(argv: string[]): Flags {
	const flags: Flags = {};
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--snapshot") flags.snapshot = argv[++i];
		else if (arg === "--against") flags.against = argv[++i];
		else if (!arg.startsWith("-") && !flags.root) flags.root = arg;
	}
	return flags;
}

function cmpPath(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function diffCounts(
	a: { path: string; count: number }[],
	b: { path: string; count: number }[],
): string[] {
	const diffs: string[] = [];
	const byPath = new Map(b.map((r) => [r.path, r.count]));
	if (a.length !== b.length) diffs.push(`row count ${a.length} vs ${b.length}`);
	for (const row of a) {
		const other = byPath.get(row.path);
		if (other === undefined) {
			diffs.push(`missing in baseline: ${row.path}`);
			continue;
		}
		if (other !== row.count) diffs.push(`edges ${row.path}: ${row.count} vs ${other}`);
	}
	for (const row of b) {
		if (!a.some((r) => r.path === row.path)) diffs.push(`extra in baseline: ${row.path}`);
	}
	return diffs;
}

const flags = parseCli(process.argv);
const rootArg = flags.root;
if (!rootArg) {
	console.error("usage: bench-graph <repo-root> [--snapshot path] [--against path]");
	process.exit(1);
}

const repoRoot = path.resolve(rootArg);
const t0 = performance.now();

const discovery = await discover(repoRoot);
const discoverMs = Math.round(performance.now() - t0);

const pool = createExtractPool();
const tasks = discovery.files.map((f) => ({ path: f.path, abs: f.abs, lang: f.lang }));
const facts = new Map<string, FileFacts>();
const tExtract = performance.now();
for await (const row of pool.run(tasks)) {
	if (row.ok) facts.set(row.path, row.facts);
}
await pool.destroy();
const extractMs = Math.round(performance.now() - tExtract);

const tResolve = performance.now();
const resolver = createResolver(repoRoot, discovery);
for (const f of discovery.files) {
	const fileFacts = facts.get(f.path);
	if (!fileFacts) continue;
	for (const imp of fileFacts.imports) resolver.resolve(f.path, imp);
}
const ctx = createGraphBindContext(facts, resolver);
const resolveMs = Math.round(performance.now() - tResolve);
const resolveStats = resolver.stats();

const tGraph = performance.now();
const graph = buildEdgesFromContext(ctx);
const buildEdgesMs = Math.round(performance.now() - tGraph);

const perFile = edgesPerFile(graph.edges);
const totalMs = Math.round(performance.now() - t0);

const payload = {
	files: discovery.files.length,
	edges: graph.edges.length,
	edgesByType: graph.edgesByType,
	callBinding: graph.callBinding,
	bindingRatePct: graph.bindingRatePct,
	internalBindingRatePct: graph.internalBindingRatePct,
	bindableMemberRatePct: bindableMemberRatePct(graph.callBinding),
	memberUnboundBreakdown: graph.callBinding.memberUnboundBreakdown,
	topHubs: graph.hubs,
	topExternalHubs: graph.topExternalHubs,
	resolutionRatePct: resolutionRate(resolveStats),
	discoverMs,
	extractMs,
	resolveMs,
	buildEdgesMs,
	totalMs,
};

if (flags.snapshot) {
	const snap = {
		generatedAt: new Date().toISOString(),
		repoRoot,
		edgesByType: graph.edgesByType,
		edgesPerFile: perFile,
	};
	await writeFile(path.resolve(flags.snapshot), `${JSON.stringify(snap)}\n`, "utf8");
}

if (flags.against) {
	const base = JSON.parse(await readFile(path.resolve(flags.against), "utf8")) as {
		edgesPerFile?: { path: string; count: number }[];
	};
	const diffs = diffCounts(perFile, (base.edgesPerFile ?? []).sort((a, b) => cmpPath(a.path, b.path)));
	if (diffs.length) {
		console.error(JSON.stringify({ compare: "DIFF", diffs: diffs.slice(0, 50), diffCount: diffs.length }));
		process.exit(2);
	}
	console.error(JSON.stringify({ compare: "IDENTICAL", files: perFile.length }));
}

console.log(JSON.stringify(payload));
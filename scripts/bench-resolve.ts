import path from "node:path";
import { discover } from "../src/modules/indexing/discover.js";
import type { FileFacts } from "../src/modules/indexing/extract-file.js";
import { createExtractPool } from "../src/modules/indexing/extract-pool.js";
import type { ResolvedImport } from "../src/modules/indexing/resolve/resolve-imports.js";
import { createResolver, resolutionRate } from "../src/modules/indexing/resolve/resolve-imports.js";

const rootArg = process.argv[2];
if (!rootArg) {
	console.error("usage: bench-resolve <repo-root>");
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
const externalPkgCounts = new Map<string, number>();
const notFoundEntries: { from: string; line: number; specifier: string }[] = [];
let imports = 0;

const recordResolution = (row: ResolvedImport) => {
	if (row.target.kind === "external") {
		externalPkgCounts.set(row.target.pkg, (externalPkgCounts.get(row.target.pkg) ?? 0) + 1);
	}
	if (row.target.kind === "unresolved" && row.target.reason === "not_found" && row.specifier) {
		notFoundEntries.push({ from: row.from, line: row.line, specifier: row.specifier });
	}
};

for (const f of discovery.files) {
	const fileFacts = facts.get(f.path);
	if (!fileFacts) continue;
	for (const imp of fileFacts.imports) {
		imports++;
		recordResolution(resolver.resolve(f.path, imp));
	}
}
const resolveWallMs = Math.round(performance.now() - tResolve);
const stats = resolver.stats();
const totalMs = Math.round(performance.now() - t0);

const topExternal = [...externalPkgCounts.entries()]
	.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
	.slice(0, 20)
	.map(([pkg, count]) => ({ pkg, count }));

const installGenerated = [...stats.workspaceUnresolvedSpecifiers, ...stats.unresolvedSpecifiers].filter((row) =>
	/@calcom\/prisma|\/generated\//i.test(row.specifier),
);

const notFoundUnique = (() => {
	const seen = new Set<string>();
	const out: typeof notFoundEntries = [];
	for (const row of notFoundEntries) {
		const key = `${row.from}:${row.line}:${row.specifier}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(row);
	}
	return out;
})();

console.log(
	JSON.stringify({
		files: discovery.files.length,
		imports,
		byKind: stats.byKind,
		byUnresolvedReason: stats.byUnresolvedReason,
		resolutionRatePct: resolutionRate(stats),
		topUnresolved: stats.unresolvedSpecifiers,
		topWorkspaceUnresolved: stats.workspaceUnresolvedSpecifiers,
		install_generated: installGenerated,
		topExternal,
		workspaceAsExternal: stats.workspaceAsExternal,
		workspacePackages: stats.workspacePackages,
		notFound: notFoundUnique,
		resolveMs: stats.totalMs,
		resolveWallMs,
		discoverMs,
		extractMs,
		totalMs,
	}),
);
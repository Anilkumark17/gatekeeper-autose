import "dotenv/config";
import path from "node:path";
import { discover } from "../src/modules/indexing/discover.js";
import { createExtractPool } from "../src/modules/indexing/extract-pool.js";
import { blameSymbols, computeRecency } from "../src/modules/indexing/recency/recency.js";
import type { SymbolFact } from "../src/modules/indexing/symbols.js";

const repoRoot = process.argv[2];
if (!repoRoot) {
	console.error("usage: bench-recency <repo-root>");
	process.exit(1);
}

const root = path.resolve(repoRoot);
const discovery = await discover(root);

const pool = createExtractPool();
const symbolsByFile = new Map<string, SymbolFact[]>();
const tasks = discovery.files.map((f) => ({ path: f.path, abs: f.abs, lang: f.lang }));
try {
	for await (const row of pool.run(tasks)) {
		if (row.ok) symbolsByFile.set(row.path, row.facts.symbols);
	}
} finally {
	await pool.close();
}

const { stats, recentFilePaths } = await computeRecency(root, discovery, symbolsByFile);

const top50 = recentFilePaths.slice(0, 50);
const { ms: blameMs } = await blameSymbols(root, top50, symbolsByFile);

console.log(
	JSON.stringify({
		filesWithHistoryPct: stats.filesWithHistoryPct,
		filesBoundaryPct: stats.filesBoundaryPct,
		filesRealHistoryPct: stats.filesRealHistoryPct,
		commitsRead: stats.commitsRead,
		shallowWarning: stats.shallowWarning,
		fileLevelMs: stats.ms,
		logMs: stats.logMs,
		blame50Files: top50.length,
		blameMs,
	}),
);
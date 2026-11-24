import { describe, expect, test } from "vitest";
import { fileRecencyRowsFromResult } from "../../src/modules/indexing/build/file-recency.js";
import type { RecencyResult } from "../../src/modules/indexing/recency/recency.js";

function minimalResult(
	byNode: Map<string, { sha: string; at: Date; source: "file" | "boundary" }>,
): RecencyResult {
	return {
		byNode,
		recentFilePaths: [],
		stats: {
			commitsRead: 1,
			filesWithHistory: byNode.size,
			filesBoundary: 0,
			filesRealHistory: byNode.size,
			filesIndexed: 3,
			filesWithHistoryPct: 100,
			filesBoundaryPct: 0,
			filesRealHistoryPct: 100,
			blamedFiles: 0,
			symbolsWithBlameRecency: 0,
			symbolsTotal: 0,
			shallowWarning: null,
			logMs: 1,
			blameMs: 0,
			ms: 2,
		},
	};
}

describe("fileRecencyRowsFromResult", () => {
	test("maps POSIX paths, boundary flag, drops non-indexed paths", () => {
		const at = new Date("2024-06-01T12:00:00.000Z");
		const byNode = new Map([
			["src/a.js", { sha: "aaa", at, source: "file" as const }],
			["src/b.js", { sha: "bbb", at, source: "boundary" as const }],
			["src/ghost.js", { sha: "ggg", at, source: "file" as const }],
			["src/a.js#fn", { sha: "sym", at, source: "file" as const }],
		]);
		const indexed = new Set(["src/a.js", "src/b.js"]);
		const rows = fileRecencyRowsFromResult("repo-1", indexed, minimalResult(byNode));
		expect(rows).toEqual([
			{
				repoId: "repo-1",
				path: "src/a.js",
				lastSha: "aaa",
				lastAt: at,
				atBoundary: false,
			},
			{
				repoId: "repo-1",
				path: "src/b.js",
				lastSha: "bbb",
				lastAt: at,
				atBoundary: true,
			},
		]);
	});
});

import type { RecencyResult } from "../recency/recency.js";

export interface FileRecencyRow {
	repoId: string;
	path: string;
	lastSha: string;
	lastAt: Date;
	atBoundary: boolean;
}

/** Map computeRecency file-level entries (byNode key = repo-relative file path) to DB rows. */
export function fileRecencyRowsFromResult(
	repoId: string,
	indexedPaths: ReadonlySet<string>,
	result: RecencyResult,
): FileRecencyRow[] {
	const rows: FileRecencyRow[] = [];
	for (const filePath of indexedPaths) {
		const rec = result.byNode.get(filePath);
		if (!rec) continue;
		rows.push({
			repoId,
			path: filePath,
			lastSha: rec.sha,
			lastAt: rec.at,
			atBoundary: rec.source === "boundary",
		});
	}
	rows.sort((a, b) => a.path.localeCompare(b.path));
	return rows;
}

export function fileRecencyToCsv(rows: FileRecencyRow[]): (string | number | boolean)[][] {
	return rows.map((r) => [r.repoId, r.path, r.lastSha, r.lastAt.toISOString(), r.atBoundary]);
}

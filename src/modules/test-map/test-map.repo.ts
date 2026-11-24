import type pg from "pg";

const PRODUCT_EDGE_TYPES = ["calls", "references", "imports"] as const;

export async function listFileNodePaths(
	pool: pg.Pool | pg.PoolClient,
	repoId: string,
): Promise<string[]> {
	const result = await pool.query<{ path: string }>(
		`SELECT path
     FROM nodes
     WHERE repo_id = $1 AND kind = 'file'
     ORDER BY path`,
		[repoId],
	);
	return result.rows.map((r) => r.path);
}

export async function sampleTargetSymbols(
	pool: pg.Pool | pg.PoolClient,
	repoId: string,
	n: number,
	seed: string,
	isProductPath: (path: string) => boolean,
): Promise<string[]> {
	const limit = Math.max(n * 3, n);
	const result = await pool.query<{ id: string; path: string }>(
		`SELECT id, path
     FROM nodes
     WHERE repo_id = $1
       AND exported = true
       AND in_degree > 0
       AND position('#' in id) > 0
     ORDER BY md5(id || $2)
     LIMIT $3`,
		[repoId, seed, limit],
	);
	const out: string[] = [];
	for (const row of result.rows) {
		if (!isProductPath(row.path)) continue;
		out.push(row.id);
		if (out.length >= n) break;
	}
	return out;
}

export async function outgoingProductEdgeCount(
	pool: pg.Pool | pg.PoolClient,
	repoId: string,
	testFilePaths: string[],
	types: readonly string[],
	isProductPath: (path: string) => boolean,
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	if (testFilePaths.length === 0) return counts;

	const chunk = 400;
	for (let i = 0; i < testFilePaths.length; i += chunk) {
		const paths = testFilePaths.slice(i, i + chunk);
		const result = await pool.query<{ src_path: string; dst_path: string }>(
			`SELECT ns.path AS src_path, nd.path AS dst_path
       FROM edges e
       INNER JOIN nodes ns ON ns.repo_id = e.repo_id AND ns.id = e.src
       INNER JOIN nodes nd ON nd.repo_id = e.repo_id AND nd.id = e.dst
       WHERE e.repo_id = $1
         AND e.type = ANY($2::text[])
         AND ns.path = ANY($3::text[])`,
			[repoId, types, paths],
		);
		for (const row of result.rows) {
			if (!isProductPath(row.dst_path)) continue;
			counts.set(row.src_path, (counts.get(row.src_path) ?? 0) + 1);
		}
	}
	return counts;
}

export { PRODUCT_EDGE_TYPES };

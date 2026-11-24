import type pg from "pg";
import type {
	DependentEdge,
	DependencyEdge,
	FindByNameOpts,
	LevelEdge,
	NameMatch,
	QueryOpts,
} from "./types.js";

const DEFAULT_LIMIT = 500;

function typesParam(types: string[] | undefined): string[] | null {
	return types && types.length > 0 ? types : null;
}

export async function dependents(
	pool: pg.Pool | pg.PoolClient,
	repoId: string,
	nodeId: string,
	opts: QueryOpts = {},
): Promise<DependentEdge[]> {
	const limit = opts.limit ?? DEFAULT_LIMIT;
	const types = typesParam(opts.types);
	const result = await pool.query<DependentEdge>(
		`SELECT src, type, line
     FROM edges
     WHERE repo_id = $1 AND dst = $2
       AND ($3::text[] IS NULL OR type = ANY($3))
     ORDER BY src, line
     LIMIT $4`,
		[repoId, nodeId, types, limit],
	);
	return result.rows;
}

export async function dependencies(
	pool: pg.Pool | pg.PoolClient,
	repoId: string,
	nodeId: string,
	opts: QueryOpts = {},
): Promise<DependencyEdge[]> {
	const limit = opts.limit ?? DEFAULT_LIMIT;
	const types = typesParam(opts.types);
	const result = await pool.query<DependencyEdge>(
		`SELECT dst, type, line
     FROM edges
     WHERE repo_id = $1 AND src = $2
       AND ($3::text[] IS NULL OR type = ANY($3))
     ORDER BY dst, line
     LIMIT $4`,
		[repoId, nodeId, types, limit],
	);
	return result.rows;
}

export async function fetchLevelEdges(
	pool: pg.Pool | pg.PoolClient,
	repoId: string,
	direction: "in" | "out",
	ids: string[],
	types?: string[],
): Promise<LevelEdge[]> {
	if (ids.length === 0) return [];
	const typeFilter = typesParam(types);
	if (direction === "in") {
		const result = await pool.query<LevelEdge>(
			`SELECT src, dst, type, line
       FROM edges
       WHERE repo_id = $1 AND dst = ANY($2::text[])
         AND ($3::text[] IS NULL OR type = ANY($3))
       ORDER BY src, line`,
			[repoId, ids, typeFilter],
		);
		return result.rows;
	}
	const result = await pool.query<LevelEdge>(
		`SELECT src, dst, type, line
     FROM edges
     WHERE repo_id = $1 AND src = ANY($2::text[])
       AND ($3::text[] IS NULL OR type = ANY($3))
     ORDER BY dst, line`,
		[repoId, ids, typeFilter],
	);
	return result.rows;
}

const BARREL_PATH = `(^|/)index\\.(js|ts|tsx|jsx|mjs|cjs)$`;

export async function findByName(
	pool: pg.Pool | pg.PoolClient,
	repoId: string,
	name: string,
	opts: FindByNameOpts = {},
): Promise<NameMatch[]> {
	const limit = opts.limit ?? 20;
	const kind = opts.kind ?? null;
	const result = await pool.query<NameMatch>(
		`SELECT id, kind, name, path, exported
     FROM nodes
     WHERE repo_id = $1
       AND (name = $2 OR name LIKE $2 || '%')
       AND ($3::text IS NULL OR kind = $3)
     ORDER BY
       CASE WHEN name = $2 THEN 0 ELSE 1 END,
       CASE WHEN path ~ $4 THEN 1 ELSE 0 END,
       exported DESC,
       length(path),
       id
     LIMIT $5`,
		[repoId, name, kind, BARREL_PATH, limit],
	);
	return result.rows;
}

export async function explainDependents(
	client: pg.PoolClient,
	repoId: string,
	nodeId: string,
	types?: string[],
): Promise<{ plan: string; executionMs: number }> {
	const typeFilter = typesParam(types);
	const result = await client.query(
		`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
     SELECT src, type, line
     FROM edges
     WHERE repo_id = $1 AND dst = $2
       AND ($3::text[] IS NULL OR type = ANY($3))
     ORDER BY src, line
     LIMIT 500`,
		[repoId, nodeId, typeFilter],
	);
	const plan = result.rows.map((r: { "QUERY PLAN": string }) => r["QUERY PLAN"]).join("\n");
	const ms = parseExecutionMs(plan);
	return { plan, executionMs: ms };
}

export async function explainWalkLevel(
	client: pg.PoolClient,
	repoId: string,
	direction: "in" | "out",
	ids: string[],
	types?: string[],
): Promise<{ plan: string; executionMs: number }> {
	const typeFilter = typesParam(types);
	const predicate = direction === "in" ? "dst = ANY($2::text[])" : "src = ANY($2::text[])";
	const result = await client.query(
		`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
     SELECT src, dst, type, line
     FROM edges
     WHERE repo_id = $1 AND ${predicate}
       AND ($3::text[] IS NULL OR type = ANY($3))
     ORDER BY ${direction === "in" ? "src, line" : "dst, line"}`,
		[repoId, ids, typeFilter],
	);
	const plan = result.rows.map((r: { "QUERY PLAN": string }) => r["QUERY PLAN"]).join("\n");
	const ms = parseExecutionMs(plan);
	return { plan, executionMs: ms };
}

function parseExecutionMs(plan: string): number {
	const match = /Execution Time: ([0-9.]+) ms/.exec(plan);
	return match ? Number.parseFloat(match[1]!) : 0;
}

export async function topCalledNodeIds(
	pool: pg.Pool | pg.PoolClient,
	repoId: string,
	limit: number,
): Promise<string[]> {
	const result = await pool.query<{ id: string }>(
		`SELECT id
     FROM nodes
     WHERE repo_id = $1 AND in_degree > 0
     ORDER BY in_degree DESC, id
     LIMIT $2`,
		[repoId, limit],
	);
	return result.rows.map((r) => r.id);
}
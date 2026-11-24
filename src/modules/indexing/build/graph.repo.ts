import { createHash } from "node:crypto";
import path from "node:path";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { folderId, parseNodeId } from "../../../core/ids.js";
import type { EdgeRow, NodeRow } from "../../../core/types.js";
import * as schema from "../../../db/schema.js";
import type { DiscoveryResult } from "../discover.js";
import type { FileFacts } from "../extract-file.js";
import type { GraphBuildResult } from "../graph/types.js";
import type { SymbolFact, SymbolKind } from "../symbols.js";
import { tokenize } from "../tokens.js";
import {
	copyStageEdges,
	copyStageFileRecency,
	copyStageNodes,
	copyStageSearch,
} from "./copy-writer.js";

type Db = NodePgDatabase<typeof schema>;

const SYMBOL_KIND: Record<SymbolKind, string> = {
	function: "function",
	class: "class",
	method: "method",
	const: "const",
	component: "component",
	hook: "hook",
};

export interface RecencyEntry {
	lastChangeSha: string;
	lastChangeAt: Date;
}

export interface CompiledGraph {
	nodes: NodeRow[];
	edges: EdgeRow[];
	nodeCsv: (string | number | boolean | null)[][];
	edgeCsv: (string | number | null)[][];
	searchCsv: string[][];
	fileRecencyCsv: (string | number | boolean)[][];
	contentHashes: { path: string; contentHash: string }[];
}

function foldersFromFiles(paths: string[]): string[] {
	const out = new Set<string>();
	for (const filePath of paths) {
		const parts = filePath.split("/");
		for (let i = 1; i < parts.length; i++) {
			out.add(`${parts.slice(0, i).join("/")}/`);
		}
	}
	return [...out].sort();
}

function pathTokens(filePath: string): string {
	const parts = filePath.split("/").filter(Boolean);
	const base = path.basename(filePath);
	return tokenize([...parts, base]).join(" ");
}

function nodeKind(id: string, symbolKind?: SymbolKind): string {
	if (id.startsWith("external:")) return "external";
	if (id.startsWith("unresolved:")) return "unresolved";
	const parsed = parseNodeId(id);
	if (parsed.kind === "folder") return "folder";
	if (parsed.kind === "file") return "file";
	if (parsed.kind === "symbol" && symbolKind) return SYMBOL_KIND[symbolKind];
	return "function";
}

function nodeName(id: string, symbol?: SymbolFact): string {
	if (symbol) return symbol.name;
	const parsed = parseNodeId(id);
	switch (parsed.kind) {
		case "symbol":
			return parsed.qualifiedName;
		case "file":
			return path.basename(parsed.repoPath);
		case "folder":
			return parsed.dir.replace(/\/$/, "").split("/").pop() ?? parsed.dir;
		case "external":
			return parsed.pkg;
		case "unresolved":
			return parsed.spec;
	}
}

function nodePath(id: string, symbol?: SymbolFact): string {
	if (symbol) return symbol.id.split("#")[0] ?? "";
	const parsed = parseNodeId(id);
	switch (parsed.kind) {
		case "symbol":
			return parsed.repoPath;
		case "file":
			return parsed.repoPath;
		case "folder":
			return parsed.dir;
		case "external":
			return parsed.pkg;
		case "unresolved":
			return parsed.spec;
	}
}

function toIso(d: Date | undefined): string | null {
	return d ? d.toISOString() : null;
}

export function compileGraph(
	repoId: string,
	discovery: DiscoveryResult,
	factsByPath: Map<string, FileFacts>,
	graph: GraphBuildResult,
	recency?: Map<string, RecencyEntry>,
): CompiledGraph {
	const symbolsById = new Map<string, SymbolFact>();
	for (const f of discovery.files) {
		const facts = factsByPath.get(f.path);
		if (!facts) continue;
		for (const sym of facts.symbols) symbolsById.set(sym.id, sym);
	}

	const nodeById = new Map<string, NodeRow>();

	const addNode = (id: string, symbol?: SymbolFact) => {
		if (nodeById.has(id)) return;
		const rec = recency?.get(id);
		const inDegree = graph.inDegree.get(id as never) ?? 0;
		nodeById.set(id, {
			repoId,
			id,
			kind: nodeKind(id, symbol?.kind),
			name: nodeName(id, symbol),
			path: nodePath(id, symbol),
			lineStart: symbol?.lineStart ?? 0,
			lineEnd: symbol?.lineEnd ?? 0,
			exported: symbol?.exported ?? false,
			bodyHash: symbol?.bodyHash ?? null,
			exportHash: symbol?.exportHash ?? null,
			lastChangeSha: rec?.lastChangeSha ?? null,
			lastChangeAt: rec?.lastChangeAt ?? null,
			inDegree,
		});
	};

	for (const f of discovery.files) {
		addNode(f.path);
	}
	for (const dir of foldersFromFiles(discovery.files.map((x) => x.path))) {
		addNode(folderId(dir));
	}
	for (const sym of symbolsById.values()) addNode(sym.id, sym);

	for (const e of graph.edges) {
		addNode(e.dst);
		addNode(e.src);
	}

	const nodes = [...nodeById.values()].sort((a, b) => a.id.localeCompare(b.id));
	const edges: EdgeRow[] = graph.edges.map((e) => ({
		repoId,
		src: e.src,
		dst: e.dst,
		type: e.type,
		path: e.path,
		line: e.line,
		meta: e.meta ?? null,
	}));

	const searchCsv: string[][] = [];
	const nodeCsv: CompiledGraph["nodeCsv"] = nodes.map((n) => {
		const nameTok = tokenize([n.name]).join(" ");
		const pathTok = n.path.endsWith("/") ? pathTokens(n.path.slice(0, -1)) : pathTokens(n.path);
		searchCsv.push([repoId, n.id, nameTok, pathTok]);
		return [
			repoId,
			n.id,
			n.kind,
			n.name,
			n.path,
			n.lineStart,
			n.lineEnd,
			n.exported,
			n.bodyHash,
			n.exportHash,
			n.lastChangeSha,
			toIso(n.lastChangeAt ?? undefined),
			n.inDegree,
		];
	});

	const edgeCsv: CompiledGraph["edgeCsv"] = [...edges]
		.sort(
			(a, b) =>
				a.path.localeCompare(b.path) ||
				a.line - b.line ||
				a.type.localeCompare(b.type) ||
				a.src.localeCompare(b.src) ||
				a.dst.localeCompare(b.dst),
		)
		.map((e) => [
			repoId,
			e.src,
			e.dst,
			e.type,
			e.path,
			e.line,
			e.meta ? JSON.stringify(e.meta) : null,
		]);

	const contentHashes: { path: string; contentHash: string }[] = [];
	for (const [filePath, facts] of factsByPath) {
		contentHashes.push({ path: filePath, contentHash: facts.contentHash });
	}
	contentHashes.sort((a, b) => a.path.localeCompare(b.path));

	return {
		nodes,
		edges,
		nodeCsv,
		edgeCsv,
		searchCsv,
		fileRecencyCsv: [],
		contentHashes,
	};
}

export interface SwapGraphOptions {
	simulateSwapFailure?: boolean;
}

export async function publishGraph(
	client: pg.PoolClient,
	repoId: string,
	compiled: CompiledGraph,
	opts: SwapGraphOptions = {},
): Promise<{
	nodes: number;
	edges: number;
	search: number;
	fileRecency: number;
	copyMs: number;
	swapMs: number;
}> {
	await client.query("BEGIN");
	try {
		await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [repoId]);
		await client.query(`DELETE FROM stage_nodes WHERE repo_id = $1`, [repoId]);
		await client.query(`DELETE FROM stage_edges WHERE repo_id = $1`, [repoId]);
		await client.query(`DELETE FROM stage_search WHERE repo_id = $1`, [repoId]);
		await client.query(`DELETE FROM stage_file_recency WHERE repo_id = $1`, [repoId]);

		const tCopy = performance.now();
		const nodes = await copyStageNodes(client, compiled.nodeCsv);
		const edges = await copyStageEdges(client, compiled.edgeCsv);
		const search = await copyStageSearch(client, compiled.searchCsv);
		const fileRecency = await copyStageFileRecency(client, compiled.fileRecencyCsv);
		const copyMs = Math.round(performance.now() - tCopy);

		if (opts.simulateSwapFailure) {
			throw new Error("simulateSwapFailure");
		}

		const tSwap = performance.now();
		await client.query(`DELETE FROM edges WHERE repo_id = $1`, [repoId]);
		await client.query(`DELETE FROM nodes WHERE repo_id = $1`, [repoId]);
		await client.query(`DELETE FROM search_docs WHERE repo_id = $1`, [repoId]);
		await client.query(`DELETE FROM file_recency WHERE repo_id = $1`, [repoId]);

		await client.query(
			`INSERT INTO nodes (
        repo_id, id, kind, name, path, line_start, line_end, exported,
        body_hash, export_hash, last_change_sha, last_change_at, in_degree
      )
      SELECT
        repo_id, id, kind, name, path, line_start, line_end, exported,
        body_hash, export_hash, last_change_sha, last_change_at, in_degree
      FROM stage_nodes WHERE repo_id = $1`,
			[repoId],
		);

		await client.query(
			`INSERT INTO edges (repo_id, src, dst, type, path, line, meta)
       SELECT repo_id, src, dst, type, path, line, meta
       FROM stage_edges WHERE repo_id = $1`,
			[repoId],
		);

		await client.query(
			`INSERT INTO search_docs (repo_id, node_id, tsv, body_hash)
       SELECT
         repo_id,
         node_id,
         setweight(to_tsvector('simple', name_tokens), 'A')
           || setweight(to_tsvector('simple', path_tokens), 'C'),
         md5(name_tokens || ' ' || path_tokens)
       FROM stage_search
       WHERE repo_id = $1`,
			[repoId],
		);

		await client.query(
			`INSERT INTO file_recency (repo_id, path, last_sha, last_at, at_boundary)
       SELECT repo_id, path, last_sha, last_at, at_boundary
       FROM stage_file_recency WHERE repo_id = $1`,
			[repoId],
		);

		const contentHashes = compiled.contentHashes;
		for (let i = 0; i < contentHashes.length; i += 500) {
			const chunk = contentHashes.slice(i, i + 500);
			const values = chunk.map((_, j) => `($${j * 2 + 2}, $${j * 2 + 3})`).join(", ");
			const params: string[] = [repoId];
			for (const row of chunk) {
				params.push(row.path, row.contentHash);
			}
			await client.query(
				`UPDATE files AS f SET content_hash = v.hash
         FROM (VALUES ${values}) AS v(path, hash)
         WHERE f.repo_id = $1 AND f.path = v.path`,
				params,
			);
		}

		await client.query(`UPDATE repos SET graph_version = graph_version + 1 WHERE id = $1`, [
			repoId,
		]);

		await client.query(`DELETE FROM stage_nodes WHERE repo_id = $1`, [repoId]);
		await client.query(`DELETE FROM stage_edges WHERE repo_id = $1`, [repoId]);
		await client.query(`DELETE FROM stage_search WHERE repo_id = $1`, [repoId]);
		await client.query(`DELETE FROM stage_file_recency WHERE repo_id = $1`, [repoId]);

		const swapMs = Math.round(performance.now() - tSwap);
		await client.query("COMMIT");
		return { nodes, edges, search, fileRecency, copyMs, swapMs };
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	}
}

export async function graphDeterminismHash(db: Db, repoId: string): Promise<string> {
	const result = await db.execute(sql`
    SELECT md5(
      coalesce((SELECT string_agg(id, '|' ORDER BY id) FROM nodes WHERE repo_id = ${repoId}), '') ||
      coalesce((
        SELECT string_agg(src || '|' || dst || '|' || type || '|' || path || '|' || line::text, '|' ORDER BY src, dst, type, path, line)
        FROM edges WHERE repo_id = ${repoId}
      ), '')
    ) AS md5
  `);
	const rows = (result as unknown as { rows: { md5: string }[] }).rows;
	return rows[0]?.md5 ?? "";
}

export interface TableCounts {
	nodes: number;
	edges: number;
	searchDocs: number;
	files: number;
}

export async function countRepoGraph(db: Db, repoId: string): Promise<TableCounts> {
	const { nodes, edges, searchDocs, files } = schema;
	const [[n], [e], [s], [f]] = await Promise.all([
		db
			.select({ c: sql<number>`count(*)::int` })
			.from(nodes)
			.where(sql`${nodes.repoId} = ${repoId}`),
		db
			.select({ c: sql<number>`count(*)::int` })
			.from(edges)
			.where(sql`${edges.repoId} = ${repoId}`),
		db
			.select({ c: sql<number>`count(*)::int` })
			.from(searchDocs)
			.where(sql`${searchDocs.repoId} = ${repoId}`),
		db
			.select({ c: sql<number>`count(*)::int` })
			.from(files)
			.where(sql`${files.repoId} = ${repoId}`),
	]);
	return {
		nodes: n?.c ?? 0,
		edges: e?.c ?? 0,
		searchDocs: s?.c ?? 0,
		files: f?.c ?? 0,
	};
}

export function callBindingReconcile(graph: GraphBuildResult): {
	boundCallSites: number;
	callEdges: number;
	dedupedBoundCalls: number;
	boundCallsToExternal: number;
} {
	const callEdges = graph.edges.filter((e) => e.type === "calls" || e.type === "uses_hook").length;
	const bound = graph.callBinding.bound;
	const boundCallsToExternal = graph.edges.filter(
		(e) => (e.type === "calls" || e.type === "uses_hook") && String(e.dst).startsWith("external:"),
	).length;
	return {
		boundCallSites: bound,
		callEdges,
		dedupedBoundCalls: Math.max(0, bound - callEdges),
		boundCallsToExternal,
	};
}

export async function loadAndSwapGraph(
	directPool: pg.Pool,
	repoId: string,
	compiled: CompiledGraph,
	opts: SwapGraphOptions,
): Promise<{
	copyMs: number;
	swapMs: number;
	copied: { nodes: number; edges: number; search: number };
}> {
	const client = await directPool.connect();
	try {
		const copied = await publishGraph(client, repoId, compiled, opts);
		return { copyMs: copied.copyMs, swapMs: copied.swapMs, copied };
	} finally {
		client.release();
	}
}

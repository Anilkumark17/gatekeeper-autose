import type pg from "pg";
import { fetchLevelEdges } from "./queries.repo.js";
import type { PathEdge, PathOpts, WalkNode, WalkOpts, WalkResult } from "./types.js";

const MAX_DEPTH_CAP = 6;

function sortWalkNodes(nodes: WalkNode[]): WalkNode[] {
	return [...nodes].sort((a, b) => a.depth - b.depth || a.id.localeCompare(b.id));
}

export async function walk(
	pool: pg.Pool | pg.PoolClient,
	repoId: string,
	startIds: string[],
	opts: WalkOpts,
): Promise<WalkResult> {
	const maxDepth = Math.min(opts.maxDepth ?? 4, MAX_DEPTH_CAP);
	const maxNodes = opts.maxNodes ?? 2000;
	const direction = opts.direction;
	const types = opts.types;

	const visited = new Set<string>();
	const nodes: WalkNode[] = [];

	for (const id of [...startIds].sort((a, b) => a.localeCompare(b))) {
		if (visited.has(id)) continue;
		visited.add(id);
		nodes.push({ id, depth: 0 });
	}

	let frontier = [...startIds];
	let depth = 0;
	let truncated = false;

	while (frontier.length > 0 && depth < maxDepth && nodes.length < maxNodes) {
		const edges = await fetchLevelEdges(pool, repoId, direction, frontier, types);
		depth += 1;
		const nextFrontier: string[] = [];

		for (const edge of edges) {
			const parent = direction === "out" ? edge.src : edge.dst;
			if (!frontier.includes(parent)) continue;

			const nodeId = direction === "out" ? edge.dst : edge.src;
			if (visited.has(nodeId)) continue;

			if (nodes.length >= maxNodes) {
				truncated = true;
				break;
			}

			visited.add(nodeId);
			nodes.push({
				id: nodeId,
				depth,
				via: { from: parent, type: edge.type, line: edge.line },
			});
			nextFrontier.push(nodeId);
		}

		if (truncated) break;

		if (depth >= maxDepth && edges.length > 0) {
			const hasUnvisited = edges.some((e) => {
				const nodeId = direction === "out" ? e.dst : e.src;
				return !visited.has(nodeId);
			});
			if (hasUnvisited) truncated = true;
		}

		frontier = [...new Set(nextFrontier)].sort((a, b) => a.localeCompare(b));
	}

	if (nodes.length >= maxNodes && frontier.length > 0) {
		truncated = true;
	}

	return { nodes: sortWalkNodes(nodes), truncated };
}

interface ParentLink {
	parent: string;
	edge: PathEdge;
}

export async function path(
	pool: pg.Pool | pg.PoolClient,
	repoId: string,
	fromId: string,
	toId: string,
	opts: PathOpts = {},
): Promise<PathEdge[] | null> {
	if (fromId === toId) return [];

	const maxDepth = Math.min(opts.maxDepth ?? 6, MAX_DEPTH_CAP);
	const types = opts.types;

	const parentOf = new Map<string, ParentLink>();
	const visited = new Set<string>([fromId]);
	let frontier = [fromId];

	for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
		const edges = await fetchLevelEdges(pool, repoId, "out", frontier, types);
		const nextFrontier: string[] = [];

		for (const edge of edges) {
			if (!frontier.includes(edge.src)) continue;
			if (visited.has(edge.dst)) continue;
			visited.add(edge.dst);
			parentOf.set(edge.dst, {
				parent: edge.src,
				edge: { src: edge.src, dst: edge.dst, type: edge.type, line: edge.line },
			});
			if (edge.dst === toId) {
				return reconstructPath(fromId, toId, parentOf);
			}
			nextFrontier.push(edge.dst);
		}

		frontier = nextFrontier;
	}

	return null;
}

function reconstructPath(fromId: string, toId: string, parentOf: Map<string, ParentLink>): PathEdge[] {
	const edges: PathEdge[] = [];
	let current = toId;
	while (current !== fromId) {
		const link = parentOf.get(current);
		if (!link) return [];
		edges.push(link.edge);
		current = link.parent;
	}
	edges.reverse();
	return edges;
}
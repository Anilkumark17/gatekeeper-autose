import type pg from "pg";
import { parseNodeId } from "../../core/ids.js";
import type { WalkOpts as GqWalkOpts, WalkResult as GqWalkResult } from "../graph-query/types.js";
import { walk } from "../graph-query/walk.js";
import type {
	DependentHit,
	TestsCoveringResult,
	WalkDependents,
	WalkOpts,
} from "./tests-covering.js";
import { testsCovering } from "./tests-covering.js";

export function repoPathFromNodeId(id: string): string | null {
	if (id.startsWith("external:")) return null;
	const parsed = parseNodeId(id);
	switch (parsed.kind) {
		case "symbol":
			return parsed.repoPath;
		case "file":
			return parsed.repoPath;
		case "folder":
			return null;
		case "external":
			return null;
		case "unresolved":
			return null;
	}
}

export function toDependentHits(result: GqWalkResult, _startId: string): DependentHit[] {
	const hits: DependentHit[] = [];
	for (const node of result.nodes) {
		const filePath = repoPathFromNodeId(node.id);
		if (filePath === null) continue;
		hits.push({ id: node.id, path: filePath, depth: node.depth });
	}
	return hits;
}

export type WalkDependentsWithMeta = WalkDependents & {
	lastWalkResult?: GqWalkResult;
};

export function makeWalkDependents(
	pool: pg.Pool | pg.PoolClient,
	repoId: string,
): WalkDependentsWithMeta {
	const fn = (async (startId: string, opts: WalkOpts): Promise<DependentHit[]> => {
		const gqOpts: GqWalkOpts = {
			direction: "in",
			types: [...opts.edgeTypes],
			maxDepth: opts.maxDepth,
			maxNodes: opts.limit,
		};
		const walkResult = await walk(pool, repoId, [startId], gqOpts);
		fn.lastWalkResult = walkResult;
		return toDependentHits(walkResult, startId);
	}) as WalkDependentsWithMeta;
	return fn;
}

export async function testsCoveringNode(
	pool: pg.Pool | pg.PoolClient,
	repoId: string,
	nodeId: string,
	opts?: Partial<WalkOpts>,
): Promise<TestsCoveringResult> {
	const walker = makeWalkDependents(pool, repoId);
	const result = await testsCovering(walker, nodeId, opts);
	const walkTruncated = walker.lastWalkResult?.truncated ?? false;
	return {
		...result,
		truncated: result.truncated || walkTruncated,
	};
}

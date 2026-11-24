import { classifyTestFile } from "./classify.js";

export const COVER_EDGE_TYPES = ["calls", "references", "imports"] as const;

export interface DependentHit {
	id: string;
	path: string;
	depth: number;
}

export interface WalkOpts {
	maxDepth: number;
	edgeTypes: readonly string[];
	limit: number;
}

export type WalkDependents = (startId: string, opts: WalkOpts) => Promise<DependentHit[]>;

export interface CoveringTest {
	testPath: string;
	role: "test" | "e2e";
	hops: number;
	viaNodeId: string;
}

export interface TestsCoveringResult {
	tests: CoveringTest[];
	truncated: boolean;
}

export const DEFAULTS = {
	maxDepth: 5,
	limit: 5000,
} as const;

function cmp(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

export async function testsCovering(
	walk: WalkDependents,
	nodeId: string,
	opts?: Partial<WalkOpts>,
): Promise<TestsCoveringResult> {
	const merged: WalkOpts = {
		maxDepth: opts?.maxDepth ?? DEFAULTS.maxDepth,
		edgeTypes: opts?.edgeTypes ?? COVER_EDGE_TYPES,
		limit: opts?.limit ?? DEFAULTS.limit,
	};

	const hits = await walk(nodeId, merged);
	const truncated = hits.length >= merged.limit;

	const bestByTestPath = new Map<string, DependentHit>();

	for (const hit of hits) {
		if (hit.id === nodeId) continue;

		const role = classifyTestFile(hit.path);
		if (role !== "test" && role !== "e2e") continue;

		const testPath = hit.path;
		const existing = bestByTestPath.get(testPath);
		if (!existing) {
			bestByTestPath.set(testPath, hit);
			continue;
		}

		if (hit.depth < existing.depth) {
			bestByTestPath.set(testPath, hit);
			continue;
		}

		if (hit.depth === existing.depth && cmp(hit.id, existing.id) < 0) {
			bestByTestPath.set(testPath, hit);
		}
	}

	const tests: CoveringTest[] = [];
	for (const [testPath, hit] of bestByTestPath) {
		const role = classifyTestFile(testPath);
		if (role !== "test" && role !== "e2e") continue;
		tests.push({
			testPath,
			role,
			hops: hit.depth,
			viaNodeId: hit.id,
		});
	}

	tests.sort((a, b) => (a.hops !== b.hops ? a.hops - b.hops : cmp(a.testPath, b.testPath)));

	return { tests, truncated };
}

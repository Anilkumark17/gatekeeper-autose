import { describe, expect, test } from "vitest";
import type { DependentHit, WalkDependents } from "./tests-covering.js";
import { DEFAULTS, testsCovering } from "./tests-covering.js";

const TARGET = "utils/string.js#titleCase";

function walkWith(hits: DependentHit[]): WalkDependents {
	return async () => hits;
}

describe("testsCovering", () => {
	test("keeps the closest hit per test file", async () => {
		const hits: DependentHit[] = [
			{ id: TARGET, path: "utils/string.js", depth: 0 },
			{ id: "receipt.test.js#far", path: "receipt.test.js", depth: 4 },
			{ id: "receipt.test.js#near", path: "receipt.test.js", depth: 2 },
			{ id: "cart.test.js#a", path: "cart.test.js", depth: 2 },
		];
		const { tests } = await testsCovering(walkWith(hits), TARGET);
		expect(tests).toHaveLength(2);
		const receipt = tests.find((t) => t.testPath === "receipt.test.js");
		expect(receipt).toMatchObject({ hops: 2, viaNodeId: "receipt.test.js#near" });
	});

	test("drops product files, support files and the start node", async () => {
		const hits: DependentHit[] = [
			{ id: TARGET, path: "utils/string.js", depth: 0 },
			{ id: "receipt.js#caller", path: "receipt.js", depth: 1 },
			{ id: "test/helpers/db.ts#h", path: "test/helpers/db.ts", depth: 1 },
			{ id: "vitest.config.ts#x", path: "vitest.config.ts", depth: 1 },
		];
		const { tests } = await testsCovering(walkWith(hits), TARGET);
		expect(tests).toEqual([]);
	});

	test("sorts by hops then path, labels .e2e.ts as e2e", async () => {
		const hits: DependentHit[] = [
			{ id: "z.e2e.ts#a", path: "z.e2e.ts", depth: 2 },
			{ id: "a.test.ts#a", path: "a.test.ts", depth: 2 },
			{ id: "m.test.ts#a", path: "m.test.ts", depth: 1 },
		];
		const { tests } = await testsCovering(walkWith(hits), TARGET);
		expect(tests.map((t) => [t.testPath, t.role, t.hops])).toEqual([
			["m.test.ts", "test", 1],
			["a.test.ts", "test", 2],
			["z.e2e.ts", "e2e", 2],
		]);
	});

	test("breaks equal-hop ties by smallest node id", async () => {
		const hits: DependentHit[] = [
			{ id: "same.test.ts#z", path: "same.test.ts", depth: 2 },
			{ id: "same.test.ts#a", path: "same.test.ts", depth: 2 },
		];
		const { tests } = await testsCovering(walkWith(hits), TARGET);
		expect(tests).toHaveLength(1);
		expect(tests[0]?.viaNodeId).toBe("same.test.ts#a");
	});

	test("passes default maxDepth to walker", async () => {
		let seenMaxDepth: number | undefined;
		const walk: WalkDependents = async (_start, opts) => {
			seenMaxDepth = opts.maxDepth;
			return [];
		};
		await testsCovering(walk, TARGET);
		expect(seenMaxDepth).toBe(DEFAULTS.maxDepth);
	});

	test("sets truncated when hits.length reaches limit", async () => {
		const walk: WalkDependents = async (_start, opts) =>
			Array.from({ length: opts.limit }, (_, i) => ({
				id: `n${i}`,
				path: `receipt.js`,
				depth: 1,
			}));
		const { truncated } = await testsCovering(walk, TARGET, { limit: 3 });
		expect(truncated).toBe(true);
	});
});

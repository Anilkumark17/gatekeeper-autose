import { describe, expect, test } from "vitest";
import type { WalkResult } from "../graph-query/types.js";
import { repoPathFromNodeId, toDependentHits } from "./graph-query.adapter.js";

describe("toDependentHits", () => {
	test("maps id, path, depth", () => {
		const result: WalkResult = {
			nodes: [
				{ id: "utils/string.js#titleCase", depth: 0 },
				{ id: "receipt.js#lineFor", depth: 2 },
			],
			truncated: false,
		};
		expect(toDependentHits(result, "utils/string.js#titleCase")).toEqual([
			{ id: "utils/string.js#titleCase", path: "utils/string.js", depth: 0 },
			{ id: "receipt.js#lineFor", path: "receipt.js", depth: 2 },
		]);
	});

	test("drops folder and external nodes", () => {
		const result: WalkResult = {
			nodes: [
				{ id: "utils/", depth: 1 },
				{ id: "external:lodash", depth: 1 },
				{ id: "receipt.js", depth: 1 },
			],
			truncated: false,
		};
		expect(toDependentHits(result, "utils/string.js#titleCase")).toEqual([
			{ id: "receipt.js", path: "receipt.js", depth: 1 },
		]);
	});

	test("preserves depth 0 for the start node", () => {
		const result: WalkResult = {
			nodes: [{ id: "utils/string.js#titleCase", depth: 0 }],
			truncated: false,
		};
		expect(toDependentHits(result, "utils/string.js#titleCase")[0]?.depth).toBe(0);
		expect(repoPathFromNodeId("utils/string.js#titleCase")).toBe("utils/string.js");
	});
});

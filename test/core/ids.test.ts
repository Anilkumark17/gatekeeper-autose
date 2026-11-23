import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	externalId,
	fileId,
	folderId,
	isResolved,
	parseNodeId,
	symbolId,
	toRepoPath,
	unresolvedId,
} from "../../src/core/ids.js";

describe("toRepoPath", () => {
	const repoRoot = path.resolve("fixtures", "sample-js");

	it("normalizes Windows-style paths to POSIX", () => {
		const input = path.join("src", "cart.js");
		expect(toRepoPath(repoRoot, input)).toBe("src/cart.js");
	});

	it("throws when path escapes the repo root", () => {
		const outside = path.join("..", "outside.js");
		expect(() => toRepoPath(repoRoot, outside)).toThrow(/repository root/i);
	});
});

describe("parseNodeId", () => {
	it("round-trips each node id kind", () => {
		const cases = [
			{ id: symbolId("src/cart.js", "addToCart"), kind: "symbol" as const },
			{ id: fileId("src/cart.js"), kind: "file" as const },
			{ id: folderId("src/utils/"), kind: "folder" as const },
			{ id: externalId("lodash"), kind: "external" as const },
			{ id: unresolvedId("dynamic:./promo.js"), kind: "unresolved" as const },
		];

		for (const sample of cases) {
			const parsed = parseNodeId(sample.id);
			expect(parsed.kind).toBe(sample.kind);
			expect(parsed.id).toBe(sample.id);
		}
	});
});

describe("isResolved", () => {
	it("returns false for external and unresolved ids", () => {
		expect(isResolved(String(externalId("react")))).toBe(false);
		expect(isResolved(String(unresolvedId("pkg")))).toBe(false);
		expect(isResolved(String(fileId("main.js")))).toBe(true);
	});
});

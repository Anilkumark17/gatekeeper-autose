import { describe, expect, it } from "vitest";
import { hypothesisSchema, intentSchema, probeSchema } from "../../src/core/schemas.js";

describe("intentSchema", () => {
	it("parses a valid intent", () => {
		const parsed = intentSchema.safeParse({
			version: 1,
			route: "rule",
			problemType: "wrong_output",
			observed: "total is 90",
			expected: "total is 81",
			keyPhrases: ["discount"],
			files: ["checkout.js"],
			symbols: ["checkout"],
			frames: [{ path: "checkout.js", line: 4 }],
			confidence: "high",
		});
		expect(parsed.success).toBe(true);
	});

	it("rejects unknown problemType", () => {
		const parsed = intentSchema.safeParse({
			version: 1,
			route: "llm",
			problemType: "unknown",
			observed: "x",
			expected: null,
			keyPhrases: [],
			files: [],
			symbols: [],
			frames: [],
			confidence: "low",
		});
		expect(parsed.success).toBe(false);
	});
});

const baseHypothesis = {
	rank: 1,
	nodeId: "checkout.js#checkout",
	contractId: null,
	cause: "wrong discount",
	mechanism: "rate applied twice",
	probe: { type: "assert" as const, test: "checkout.test" },
	confidence: "med" as const,
};

describe("hypothesisSchema", () => {
	it("fails with one evidence item", () => {
		const parsed = hypothesisSchema.safeParse({
			...baseHypothesis,
			evidence: [{ kind: "test", ref: "a" }],
		});
		expect(parsed.success).toBe(false);
	});

	it("passes with two evidence items", () => {
		const parsed = hypothesisSchema.safeParse({
			...baseHypothesis,
			evidence: [
				{ kind: "test", ref: "a" },
				{ kind: "edge", ref: "b" },
			],
		});
		expect(parsed.success).toBe(true);
	});
});

describe("probeSchema", () => {
	it("rejects unknown probe type", () => {
		const parsed = probeSchema.safeParse({ type: "deploy", sha: "abc" });
		expect(parsed.success).toBe(false);
	});
});

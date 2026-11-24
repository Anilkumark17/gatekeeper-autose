import { describe, expect, test } from "vitest";
import { parseSource } from "../../src/modules/indexing/parser.js";

describe("parseSource (perf)", () => {
	test("throughput: 2000 parses under 6000ms", () => {
		const functions = Array.from(
			{ length: 200 },
			(_, i) => `export function f${i}() { return ${i}; }`,
		).join("\n");
		parseSource(functions, "js");
		const t0 = performance.now();
		for (let i = 0; i < 2000; i++) {
			const result = parseSource(functions, "js");
			if (result.hasError) throw new Error("unexpected parse error");
		}
		const elapsed = performance.now() - t0;
		console.log(`[perf] parser 2000 parses: ${elapsed.toFixed(1)}ms (limit 6000ms)`);
		expect(elapsed).toBeLessThan(6000);
	}, 30_000);
});
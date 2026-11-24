import { describe, expect, test } from "vitest";
import { getParser, lines, parseSource, walk } from "../../src/modules/indexing/parser.js";

describe("parseSource", () => {
	const okSamples: Array<[string, string]> = [
		["js", "export const ok = 1;"],
		["jsx", "export const App = () => <div />;"],
		["ts", "export const ok: number = 1;"],
		["tsx", "export const C = <T,>(p: { v: T }) => <span>{String(p.v)}</span>;"],
	];

	for (const [lang, source] of okSamples) {
		test(`${lang} parses clean program`, () => {
			const result = parseSource(source, lang as "js" | "jsx" | "ts" | "tsx");
			expect(result.hasError).toBe(false);
			expect(result.errorCount).toBe(0);
			expect(result.tree.rootNode.type).toBe("program");
		});
	}

	test("getParser caches per language", () => {
		expect(getParser("ts")).toBe(getParser("ts"));
		expect(getParser("js")).not.toBe(getParser("ts"));
	});

	test("parses a >32 KB file with 4000 exports", () => {
		const body = Array.from({ length: 4000 }, (_, i) => `export const v${i} = ${i};`).join("\n");
		const result = parseSource(body, "js");
		expect(result.hasError).toBe(false);
		expect(result.errorCount).toBe(0);
		expect(result.tree.rootNode.namedChildCount).toBe(4000);
	});

	test("broken source keeps partial tree and counts errors", () => {
		const broken = "export function f( {\n  return 1;\n}\nexport const ok = 2;\n";
		const result = parseSource(broken, "js");
		expect(result.hasError).toBe(true);
		expect(result.errorCount).toBeGreaterThan(0);
		expect(result.tree.rootNode.text).toContain("export const ok = 2;");
	});

	test("lines() is 1-based", () => {
		const source = "line1\nline2\nfunction f() {\n  return 1;\n}\n";
		const { tree } = parseSource(source, "js");
		const fn = tree.rootNode.namedChildren.find((n) => n.type === "function_declaration");
		expect(fn).toBeDefined();
		expect(lines(fn!)).toEqual({ start: 3, end: 5 });
	});

	test("deeply nested array literal does not overflow the stack", () => {
		const depth = 5000;
		const source = `const x = ${"[".repeat(depth)}${"]".repeat(depth)};`;
		expect(() => parseSource(source, "js")).not.toThrow();
	});

	test("strips a leading BOM before parsing", () => {
		const result = parseSource("\uFEFFexport const ok = 1;", "js");
		expect(result.hasError).toBe(false);
		expect(result.errorCount).toBe(0);
	});

	test("walk visits fewer nodes when pruning array nodes", () => {
		const src = "const a = [1, [2, [3]]];\nconst b = { k: { n: 1 } };\n";
		const { tree } = parseSource(src, "js");
		let all = 0;
		let pruned = 0;
		walk(tree.rootNode, () => {
			all++;
			return true;
		});
		walk(tree.rootNode, (node) => {
			if (node.type === "array") return false;
			pruned++;
			return true;
		});
		expect(pruned).toBeLessThan(all);
	});

});
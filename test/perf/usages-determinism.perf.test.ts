import { describe, expect, test } from "vitest";
import { extractImports } from "../../src/modules/indexing/imports.js";
import { parseSource } from "../../src/modules/indexing/parser.js";
import { extractSymbols } from "../../src/modules/indexing/symbols.js";
import { extractUsages, knownNamesForFile } from "../../src/modules/indexing/usages.js";

const PATH = "src/example.js";

function buildRefHeavySynthetic(): string {
	const topFns = 500;
	const classes = 50;
	const methodsPerClass = 10;
	const sites = topFns + classes * methodsPerClass;
	const importNames = Array.from({ length: sites }, (_, i) => [`helper${i}`, `RATE_${i}`, `cb${i}`]).flat();
	const importChunks: string[] = [];
	for (let i = 0; i < importNames.length; i += 60) {
		importChunks.push(`import { ${importNames.slice(i, i + 60).join(", ")} } from "./lib";\n`);
	}
	const fns = Array.from(
		{ length: topFns },
		(_, i) =>
			`export function fn${i}(items) { helper${i}(items[${i % 7}], RATE_${i}); return items.map(cb${i}); }`,
	).join("\n");
	const classBlocks = Array.from({ length: classes }, (_, ci) => {
		const methods = Array.from({ length: methodsPerClass }, (_, mi) => {
			const i = topFns + ci * methodsPerClass + mi;
			return `  m${mi}(items) { helper${i}(items[${mi}], RATE_${i}); return items.map(cb${i}); }`;
		}).join("\n");
		return `export class Cls${ci} {\n${methods}\n}`;
	}).join("\n");
	return `${importChunks.join("")}${fns}\n${classBlocks}\n`;
}

describe("extractUsages determinism (perf)", () => {
	test("deterministic across 20 runs on a large synthetic file", () => {
		const src = buildRefHeavySynthetic();
		const root = parseSource(src, "js").tree.rootNode;
		const symbols = extractSymbols(root, PATH);
		const imports = extractImports(root);
		const known = knownNamesForFile(imports, symbols);
		extractUsages(root, symbols, known, PATH);
		const t0 = performance.now();
		const runs = Array.from({ length: 20 }, () => extractUsages(root, symbols, known, PATH));
		const elapsed = performance.now() - t0;
		const first = runs[0]!;
		for (let i = 1; i < runs.length; i++) {
			expect(runs[i]!.refs).toEqual(first.refs);
			expect(runs[i]!.calls).toEqual(first.calls);
			expect(runs[i]!.renders).toEqual(first.renders);
		}
		expect(first.refs.length).toBeGreaterThanOrEqual(1000);
		console.log(
			`[perf] usages 20x determinism: ${first.calls.length} calls, ${first.refs.length} refs, ${elapsed.toFixed(1)}ms (limit 6500ms)`,
		);
		expect(elapsed).toBeLessThan(6500);
	}, 120_000);
});
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { symbolId } from "../../src/core/ids.js";
import { fileId } from "../../src/core/ids.js";
import { extractImports } from "../../src/modules/indexing/imports.js";
import { parseSource, walk } from "../../src/modules/indexing/parser.js";
import { extractSymbols } from "../../src/modules/indexing/symbols.js";
import {
	enclosingFromId,
	extractUsages,
	knownNamesForFile,
	makeEnclosingFromId,
} from "../../src/modules/indexing/usages.js";

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

function usagesOf(src: string, lang: "js" | "jsx" = "js", path = PATH) {
	const root = parseSource(src, lang).tree.rootNode;
	const symbols = extractSymbols(root, path);
	const imports = extractImports(root);
	const known = knownNamesForFile(imports, symbols);
	return extractUsages(root, symbols, known, path);
}

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "sample-js");

async function sampleJsSources(): Promise<{ path: string; source: string }[]> {
	const out: { path: string; source: string }[] = [];
	async function list(dir: string, rel: string) {
		for (const ent of await readdir(dir, { withFileTypes: true })) {
			const relPath = rel ? `${rel}/${ent.name}` : ent.name;
			const abs = path.join(dir, ent.name);
			if (ent.isDirectory()) await list(abs, relPath);
			else if (ent.name.endsWith(".js")) {
				out.push({
					path: `fixtures/sample-js/${relPath.replace(/\\/g, "/")}`,
					source: await readFile(abs, "utf8"),
				});
			}
		}
	}
	await list(fixtureRoot, "");
	return out;
}

function assertEnclosingOracle(root: ReturnType<typeof parseSource>["tree"]["rootNode"], filePath: string) {
	const symbols = extractSymbols(root, filePath);
	const moduleId = fileId(filePath);
	const fast = makeEnclosingFromId(symbols, moduleId);
	walk(root, (node) => {
		const idx = node.startIndex;
		expect(fast(idx)).toBe(enclosingFromId(symbols, idx, moduleId));
		return true;
	});
}

describe("extractUsages", () => {
	test(
		"makeEnclosingFromId matches enclosingFromId on every visited node (fixtures + synthetic)",
		async () => {
			const files = await sampleJsSources();
			expect(files.length).toBeGreaterThan(0);
			for (const f of files) assertEnclosingOracle(parseSource(f.source, "js").tree.rootNode, f.path);
			assertEnclosingOracle(parseSource(buildRefHeavySynthetic(), "js").tree.rootNode, PATH);
		},
		15_000,
	);

	test("lineFor calls titleCase with member arg", () => {
		const src = 'import { titleCase } from "./u"; export function lineFor(item) { return titleCase(item.name) }';
		const { calls } = usagesOf(src);
		const fromLineFor = symbolId(PATH, "lineFor");
		const call = calls.find((c) => c.fromId === fromLineFor && c.callee.name === "titleCase");
		expect(call).toMatchObject({
			callee: { kind: "name", name: "titleCase", chain: null },
			isNew: false,
		});
		expect(call?.args).toEqual([{ index: 0, kind: "member", text: "item.name" }]);
	});

	test("receiptLines: items.map call and lineFor ref as argument", () => {
		const src =
			'import { lineFor } from "./r"; export function receiptLines(items) { return items.map(lineFor) }';
		const { calls, refs } = usagesOf(src);
		const from = symbolId(PATH, "receiptLines");
		const mapCall = calls.find((c) => c.fromId === from && c.callee.chain === "items.map");
		expect(mapCall).toMatchObject({ callee: { kind: "member", name: "map" } });
		expect(mapCall?.args).toEqual([{ index: 0, kind: "identifier", text: "lineFor" }]);
		expect(refs).toContainEqual({ fromId: from, name: "lineFor", role: "argument", line: 1 });
	});

	test("checkout passes DISCOUNT_RATE as argument ref", () => {
		const src =
			'import { DISCOUNT_RATE } from "./config"; import { applyDiscount } from "./p"; export function checkout(subtotal) { return applyDiscount(subtotal, DISCOUNT_RATE) }';
		const { refs } = usagesOf(src);
		const from = symbolId(PATH, "checkout");
		expect(refs).toContainEqual({ fromId: from, name: "DISCOUNT_RATE", role: "argument", line: 1 });
	});

	test("method call inside class method uses symbol fromId", () => {
		const src = "export class Cart { add(item) { console.log(item) } }";
		const { calls } = usagesOf(src);
		const from = symbolId(PATH, "Cart.add");
		expect(calls.some((c) => c.fromId === from && c.callee.chain === "console.log")).toBe(true);
	});

	test("this.save() callee kind this", () => {
		const src = "export class Cart { save() { this.save() } }";
		const { calls } = usagesOf(src);
		const from = symbolId(PATH, "Cart.save");
		const inner = calls.find((c) => c.fromId === from && c.callee.kind === "this");
		expect(inner?.callee).toMatchObject({ kind: "this", name: "save" });
	});

	test("const v = new Cart() records newLocals for enclosing scope", () => {
		const src = "export function setup() { const cart = new Cart(); cart.add(x); }\nexport class Cart { add() {} }";
		const { newLocals } = usagesOf(src);
		const from = symbolId(PATH, "setup");
		expect(newLocals).toEqual([{ fromId: from, local: "cart", className: "Cart", line: 1 }]);
	});

	test("new Cart() isNew with name Cart", () => {
		const src = "export class Cart {} new Cart()";
		const { calls } = usagesOf(src);
		const top = calls.find((c) => c.isNew && c.callee.name === "Cart");
		expect(top?.fromId).toBe(PATH);
	});

	test("top-level call uses file id", () => {
		const src = 'import { titleCase } from "./u"; titleCase(x)';
		const { calls } = usagesOf(src);
		expect(calls[0]?.fromId).toBe(PATH);
	});

	test("string containing call syntax produces no usages", () => {
		const { calls, refs, renders } = usagesOf('const s = "titleCase(x)"');
		expect(calls).toEqual([]);
		expect(refs).toEqual([]);
		expect(renders).toEqual([]);
	});

	test("deterministic across 5 runs on ref-heavy synthetic (500 fn + 50x10 methods)", () => {
		const src = buildRefHeavySynthetic();
		const root = parseSource(src, "js").tree.rootNode;
		const symbols = extractSymbols(root, PATH);
		const imports = extractImports(root);
		const known = knownNamesForFile(imports, symbols);
		const t0 = performance.now();
		const runs = Array.from({ length: 5 }, () => extractUsages(root, symbols, known, PATH));
		const first = runs[0]!;
		for (let i = 1; i < runs.length; i++) {
			expect(runs[i]!.refs).toEqual(first.refs);
			expect(runs[i]!.calls).toEqual(first.calls);
			expect(runs[i]!.renders).toEqual(first.renders);
			expect(runs[i]!.newLocals).toEqual(first.newLocals);
		}
		expect(first.refs.length).toBeGreaterThanOrEqual(1000);
		const elapsed = performance.now() - t0;
		console.log(
			`[test] usages 5x determinism: ${first.calls.length} calls, ${first.refs.length} refs, ${elapsed.toFixed(1)}ms`,
		);
	}, 30_000);

	test("optional chain callee a?.b() records chain, name, optional", () => {
		const src = 'import { a } from "./x"; export function f() { a?.b(); }';
		const { calls } = usagesOf(src);
		const from = symbolId(PATH, "f");
		const call = calls.find((c) => c.fromId === from);
		expect(call).toMatchObject({
			callee: { kind: "member", name: "b", chain: "a.b", optional: true },
		});
	});

	test("obj?.items?.map(fn) optional chain and lineFor ref as argument", () => {
		const src =
			'import { lineFor } from "./r"; export function g(obj) { return obj?.items?.map(lineFor); }';
		const { calls, refs } = usagesOf(src);
		const from = symbolId(PATH, "g");
		const mapCall = calls.find((c) => c.fromId === from && c.callee.name === "map");
		expect(mapCall?.callee).toMatchObject({
			kind: "member",
			name: "map",
			chain: "obj.items.map",
			optional: true,
		});
		expect(refs).toContainEqual({ fromId: from, name: "lineFor", role: "argument", line: 1 });
	});

	test("JSX Receipt render with props; div ignored; UI.Button member", () => {
		const src = `
export function App() { return <Receipt items={items} {...rest} /> }
function ignore() { return <div/> }
const el = <UI.Button />`;
		const { renders } = usagesOf(src, "jsx");
		const fromApp = symbolId(PATH, "App");
		expect(renders).toContainEqual({
			fromId: fromApp,
			component: "Receipt",
			props: ["items", "..."],
			line: 2,
		});
		expect(renders.some((r) => r.component === "div")).toBe(false);
		expect(renders.some((r) => r.component === "UI.Button")).toBe(true);
	});
});
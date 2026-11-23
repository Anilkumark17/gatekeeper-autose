import { describe, expect, test } from "vitest";
import { symbolId } from "../../src/core/ids.js";
import { extractImports } from "../../src/modules/indexing/imports.js";
import { parseSource } from "../../src/modules/indexing/parser.js";
import { extractSymbols } from "../../src/modules/indexing/symbols.js";
import { extractUsages, knownNamesForFile } from "../../src/modules/indexing/usages.js";

const PATH = "src/example.js";

function usagesOf(src: string, lang: "js" | "jsx" = "js", path = PATH) {
	const root = parseSource(src, lang).tree.rootNode;
	const symbols = extractSymbols(root, path);
	const imports = extractImports(root);
	const known = knownNamesForFile(imports, symbols);
	return extractUsages(root, symbols, known, path);
}

describe("extractUsages", () => {
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
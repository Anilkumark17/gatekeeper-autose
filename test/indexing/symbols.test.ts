import { describe, expect, test } from "vitest";
import { parseSource } from "../../src/modules/indexing/parser.js";
import { extractSymbols } from "../../src/modules/indexing/symbols.js";

const JS = `import x from "./x";
export const DISCOUNT_RATE = 0.1;
const ITEMS = [{ price: 10 }];
export function applyDiscount(total, rate) { return total * (1 - rate); }
function helper() { function inner() {} return inner(); }
export const lineFor = (item) => titleCase(item.name);
export function Receipt({ items }) { return <ul>{items.map(lineFor)}</ul>; }
export const useCart = () => { return []; };
export default function () { return 1; }
export class Cart {
  constructor() { this.items = []; }
  add(item) { this.items.push(item); }
  get size() { return this.items.length; }
  set size(v) {}
  total = () => 0;
}
let counter = 0;
const { a, b } = obj;
`;

const symbolsOf = (src: string, lang: "jsx" | "ts" | "tsx" = "jsx", path = "src/cart.js") =>
  extractSymbols(parseSource(src, lang).tree.rootNode, path);

describe("extractSymbols", () => {
  test("finds top-level symbols and class methods with kinds", () => {
    const got = symbolsOf(JS).map((s) => [s.qualifiedName, s.kind, s.exported]);
    expect(got).toEqual([
      ["DISCOUNT_RATE", "const", true],
      ["ITEMS", "const", false],
      ["applyDiscount", "function", true],
      ["helper", "function", false],
      ["lineFor", "function", true],
      ["Receipt", "component", true],
      ["useCart", "hook", true],
      ["default", "function", true],
      ["Cart", "class", true],
      ["Cart.constructor", "method", true],
      ["Cart.add", "method", true],
      ["Cart.size", "method", true],
      ["Cart.size~2", "method", true],
      ["Cart.total", "method", true],
      ["counter", "const", false],
    ]);
  });

  test("nested functions and destructuring are not symbols", () => {
    const names = symbolsOf(JS).map((s) => s.name);
    expect(names).not.toContain("inner");
    expect(names).not.toContain("a");
  });

  test("ids, lines and default flag", () => {
    const s = symbolsOf(JS);
    const apply = s.find((x) => x.name === "applyDiscount")!;
    expect(apply.id).toBe("src/cart.js#applyDiscount");
    expect([apply.lineStart, apply.lineEnd]).toEqual([4, 4]);
    expect(s.find((x) => x.name === "default")?.isDefault).toBe(true);
  });

  test("TypeScript: types skipped, typed arrow is a function, abstract class methods", () => {
    const ts = `export interface User { id: string }
export type Id = string;
export enum Color { Red }
export const handler: (r: Request) => Promise<void> = async (req) => {};
export abstract class Repo { abstract find(): void; save(): void {} }
`;
    const got = symbolsOf(ts, "ts", "src/repo.ts").map((s) => [s.qualifiedName, s.kind]);
    expect(got).toEqual([
      ["handler", "function"],
      ["Repo", "class"],
      ["Repo.save", "method"],
    ]);
  });

  test("bodyHash changes with the body; exportHash only with the shape", () => {
    const v1 = symbolsOf("export function f(a) { return a + 1; }", "ts")[0]!;
    const v2 = symbolsOf("export function f(a) { return a + 2; }", "ts")[0]!;
    const v3 = symbolsOf("export function f(a, b) { return a + 2; }", "ts")[0]!;
    expect(v2.bodyHash).not.toBe(v1.bodyHash);
    expect(v2.exportHash).toBe(v1.exportHash);
    expect(v3.exportHash).not.toBe(v2.exportHash);
  });

  test("TSX component detection", () => {
    const tsx = `export const Button = ({ label }: { label: string }) => <button>{label}</button>;
export const formatLabel = (s: string) => s.trim();`;
    const got = symbolsOf(tsx, "tsx", "src/Button.tsx").map((s) => [s.name, s.kind]);
    expect(got).toEqual([
      ["Button", "component"],
      ["formatLabel", "function"],
    ]);
  });

  test("class field arrow functions are methods in JS and TS", () => {
    const src = "export class A { run = () => 1; private stop = (x: number) => x; }";
    expect(symbolsOf(src, "ts", "src/a.ts").map((s) => s.qualifiedName)).toEqual(["A", "A.run", "A.stop"]);
    expect(symbolsOf("export class A { run = () => 1; }", "jsx").map((s) => s.qualifiedName)).toEqual(["A", "A.run"]);
  });
});
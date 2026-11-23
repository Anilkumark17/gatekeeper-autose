import { describe, expect, test } from "vitest";
import { extractExports } from "../../src/modules/indexing/exports.js";
import { parseSource } from "../../src/modules/indexing/parser.js";

const exportsOf = (src: string, lang: "js" | "ts" = "js") => extractExports(parseSource(src, lang).tree.rootNode);
const pick = (e: ReturnType<typeof exportsOf>) => e.map(({ kind, exported, local, imported, source }) => ({ kind, exported, local, imported, source }));

describe("extractExports", () => {
  test("declaration exports", () => {
    expect(pick(exportsOf(`export const RATE = 0.1, MAX = 5;\nexport function f() {}\nexport class C {}\n`))).toEqual([
      { kind: "local", exported: "RATE", local: "RATE", imported: null, source: null },
      { kind: "local", exported: "MAX", local: "MAX", imported: null, source: null },
      { kind: "local", exported: "f", local: "f", imported: null, source: null },
      { kind: "local", exported: "C", local: "C", imported: null, source: null },
    ]);
  });

  test("default export forms", () => {
    const e = (src: string) => pick(exportsOf(src))[0];
    expect(e("function foo() {}\nexport default foo;")).toMatchObject({ exported: "default", local: "foo" });
    expect(e("export default function main() {}")).toMatchObject({ exported: "default", local: "main" });
    expect(e("export default () => 1;")).toMatchObject({ exported: "default", local: "default" });
  });

  test("local export list with alias", () => {
    expect(pick(exportsOf(`const a = 1, b = 2;\nexport { a, b as c };`))).toEqual([
      { kind: "local", exported: "a", local: "a", imported: null, source: null },
      { kind: "local", exported: "c", local: "b", imported: null, source: null },
    ]);
  });

  test("barrel re-exports: named, default, all, namespace", () => {
    const barrel = `export { titleCase } from "./string.js";
export { default as Button, default } from "./Button.js";
export * from "./math.js";
export * as fmt from "./format.js";
`;
    expect(pick(exportsOf(barrel))).toEqual([
      { kind: "reexport", exported: "titleCase", local: null, imported: "titleCase", source: "./string.js" },
      { kind: "reexport", exported: "Button", local: null, imported: "default", source: "./Button.js" },
      { kind: "reexport", exported: "default", local: null, imported: "default", source: "./Button.js" },
      { kind: "reexport_all", exported: null, local: null, imported: null, source: "./math.js" },
      { kind: "reexport_namespace", exported: "fmt", local: null, imported: null, source: "./format.js" },
    ]);
  });

  test("TypeScript type exports are flagged", () => {
    const e = exportsOf(`export interface User {}\nexport type Id = string;\nexport type { T } from "./t";\nexport { type U, V } from "./uv";\n`, "ts");
    expect(e.map((x) => [x.exported, x.typeOnly])).toEqual([
      ["User", true],
      ["Id", true],
      ["T", true],
      ["U", true],
      ["V", false],
    ]);
  });

  test("CommonJS exports", () => {
    const cjs = `function a() {}\nconst b = 1;\nmodule.exports = { a, renamed: b };\nexports.c = a;\nmodule.exports.d = b;\n`;
    expect(exportsOf(cjs).map((x) => [x.kind, x.exported, x.local])).toEqual([
      ["commonjs", "a", "a"],
      ["commonjs", "renamed", "b"],
      ["commonjs", "c", "a"],
      ["commonjs", "d", "b"],
    ]);
  });
});
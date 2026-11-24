import { describe, expect, test } from "vitest";
import { extractImports } from "../../src/modules/indexing/imports.js";
import { parseSource } from "../../src/modules/indexing/parser.js";
import { extractUsages } from "../../src/modules/indexing/usages.js";

const importsOf = (src: string, lang: "js" | "ts" = "js") => {
	const root = parseSource(src, lang).tree.rootNode;
	const known = new Set<string>();
	const { dynamicImports } = extractUsages(root, [], known, "test.js");
	return extractImports(root, dynamicImports);
};

const JS = `import a from "./a";
import * as ns from "./ns";
import { b, c as d } from "./bc";
import e, { f } from "./ef";
import "./side.css";
const g = require("./g");
const { h, i: j } = require("./hi");
async function load() {
  const m = await import("./pricing.js");
  const t = await import(\`./tpl.js\`);
  return import(name);
}
const s = "import('./not-real.js')";
`;

describe("extractImports", () => {
  const imps = importsOf(JS);
  const bySpec = (spec: string | null) => imps.find((i) => i.specifier === spec);

  test("finds every import form, in line order", () => {
    expect(imps.map((i) => [i.line, i.kind, i.specifier])).toEqual([
      [1, "static", "./a"],
      [2, "static", "./ns"],
      [3, "static", "./bc"],
      [4, "static", "./ef"],
      [5, "side_effect", "./side.css"],
      [6, "require", "./g"],
      [7, "require", "./hi"],
      [9, "dynamic", "./pricing.js"],
      [10, "dynamic", "./tpl.js"],
      [11, "dynamic", null],
    ]);
  });

  test("default, namespace and named bindings with aliases", () => {
    expect(bySpec("./a")?.defaultLocal).toBe("a");
    expect(bySpec("./ns")?.namespaceLocal).toBe("ns");
    expect(bySpec("./bc")?.names).toEqual([
      { imported: "b", local: "b", typeOnly: false },
      { imported: "c", local: "d", typeOnly: false },
    ]);
    expect(bySpec("./ef")).toMatchObject({ defaultLocal: "e", names: [{ imported: "f", local: "f", typeOnly: false }] });
  });

  test("require bindings: whole module and destructured names", () => {
    expect(bySpec("./g")?.namespaceLocal).toBe("g");
    expect(bySpec("./hi")?.names).toEqual([
      { imported: "h", local: "h", typeOnly: false },
      { imported: "i", local: "j", typeOnly: false },
    ]);
  });

  test("strings that look like imports are ignored", () => {
    expect(bySpec("./not-real.js")).toBeUndefined();
  });

  test("TypeScript type-only imports are flagged", () => {
    const ts = importsOf(`import type { T } from "./types";\nimport { type U, V } from "./uv";\n`, "ts");
    expect(ts[0]).toMatchObject({ specifier: "./types", typeOnly: true, names: [{ imported: "T", local: "T", typeOnly: true }] });
    expect(ts[1]?.names).toEqual([
      { imported: "U", local: "U", typeOnly: true },
      { imported: "V", local: "V", typeOnly: false },
    ]);
  });
});
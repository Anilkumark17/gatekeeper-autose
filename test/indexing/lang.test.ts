import { describe, expect, test } from "vitest";
import { detectLang } from "../../src/modules/indexing/lang.js";

describe("detectLang", () => {
  test.each([
    ["src/main.js", "js"],
    ["src/a.mjs", "js"],
    ["src/a.cjs", "js"],
    ["src/App.jsx", "jsx"],
    ["src/a.ts", "ts"],
    ["src/a.mts", "ts"],
    ["src/a.cts", "ts"],
    ["src/App.tsx", "tsx"],
    ["src/App.TSX", "tsx"],
  ])("%s -> %s", (path, lang) => {
    expect(detectLang(path)).toBe(lang);
  });

  test.each([
    "README.md",
    "package.json",
    "src/styles.css",
    ".eslintrc",
    "Makefile",
    "src/folder.js/file",
  ])("%s -> null", (path) => {
    expect(detectLang(path)).toBeNull();
  });

  test("handles Windows separators", () => {
    expect(detectLang("src\\utils\\string.js")).toBe("js");
  });
});

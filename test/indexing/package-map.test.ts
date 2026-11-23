import { describe, expect, test } from "vitest";
import { buildPackageMap } from "../../src/modules/indexing/package-map.js";

describe("buildPackageMap", () => {
  test("single-package repo", () => {
    const map = buildPackageMap(["package.json", "jsconfig.json", "src/main.js", "src/utils/string.js"]);
    expect(map.packages).toEqual([{ root: "", tsconfig: "jsconfig.json" }]);
    expect(map.lookup("src/utils/string.js")).toEqual({ pkg: "", tsconfig: "jsconfig.json" });
  });

  test("monorepo: each file maps to its own package and nearest config", () => {
    const map = buildPackageMap([
      "package.json",
      "tsconfig.json",
      "packages/a/package.json",
      "packages/a/src/index.ts",
      "packages/b/package.json",
      "packages/b/tsconfig.json",
      "packages/b/src/deep/util.ts",
    ]);
    expect(map.packages.map((p) => p.root)).toEqual(["", "packages/a", "packages/b"]);
    expect(map.lookup("packages/a/src/index.ts")).toEqual({ pkg: "packages/a", tsconfig: "tsconfig.json" });
    expect(map.lookup("packages/b/src/deep/util.ts")).toEqual({
      pkg: "packages/b",
      tsconfig: "packages/b/tsconfig.json",
    });
  });

  test("tsconfig wins over jsconfig in the same folder", () => {
    const map = buildPackageMap(["package.json", "jsconfig.json", "tsconfig.json", "src/a.ts"]);
    expect(map.lookup("src/a.ts").tsconfig).toBe("tsconfig.json");
  });

  test("a nested tsconfig closer to the file wins", () => {
    const map = buildPackageMap(["package.json", "tsconfig.json", "src/legacy/tsconfig.json", "src/legacy/old.ts"]);
    expect(map.lookup("src/legacy/old.ts").tsconfig).toBe("src/legacy/tsconfig.json");
  });

  test("no package.json anywhere maps to repo root, no config is null", () => {
    const map = buildPackageMap(["src/a.js"]);
    expect(map.packages).toEqual([]);
    expect(map.lookup("src/a.js")).toEqual({ pkg: "", tsconfig: null });
  });

  test("configs inside ignored folders are not counted", () => {
    const map = buildPackageMap(["package.json", "dist/package.json", "dist/tsconfig.json", "src/a.js"]);
    expect(map.packages.map((p) => p.root)).toEqual([""]);
    expect(map.lookup("src/a.js").tsconfig).toBeNull();
  });

  test("tsconfig.base.json is not a governing config", () => {
    const map = buildPackageMap(["package.json", "tsconfig.base.json", "src/a.ts"]);
    expect(map.lookup("src/a.ts").tsconfig).toBeNull();
  });
});
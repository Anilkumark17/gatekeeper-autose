import { describe, expect, test } from "vitest";
import { skipReasonByPath } from "../../src/modules/indexing/skip.js";

describe("skipReasonByPath", () => {
  test.each([
    ["node_modules/react/index.js", "ignored_dir"],
    ["packages/web/node_modules/x/a.ts", "ignored_dir"],
    ["dist/main.js", "ignored_dir"],
    ["apps/web/.next/server/page.js", "ignored_dir"],
    ["coverage/lcov-report/a.js", "ignored_dir"],
    ["src/types/global.d.ts", "declaration"],
    ["src/types/env.d.mts", "declaration"],
    ["public/vendor.min.js", "minified"],
    ["public/app.bundle.js", "minified"],
    ["README.md", "not_source"],
    ["src/styles.css", "not_source"],
  ])("%s -> %s", (path, reason) => {
    expect(skipReasonByPath(path)).toBe(reason);
  });

  test.each([
    "src/main.js",
    "src/build.ts",
    "scripts/dist.js",
    "src/components/App.tsx",
    "src/utils/index.js",
  ])("%s -> indexed", (path) => {
    expect(skipReasonByPath(path)).toBeNull();
  });

  test("handles Windows separators", () => {
    expect(skipReasonByPath("node_modules\\react\\index.js")).toBe("ignored_dir");
    expect(skipReasonByPath("src\\main.js")).toBeNull();
  });
});
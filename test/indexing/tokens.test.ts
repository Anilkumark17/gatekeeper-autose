import { describe, expect, test } from "vitest";
import { tokenize } from "../../src/modules/indexing/tokens.js";

describe("tokenize", () => {
  test("splits camelCase, PascalCase, snake_case, and digits", () => {
    expect(tokenize(["titleCase", "DISCOUNT_RATE", "getHTTPClient"])).toEqual([
      "case",
      "client",
      "discount",
      "get",
      "http",
      "rate",
      "title",
    ]);
  });

  test("removes stopwords and short tokens", () => {
    expect(tokenize(["a", "is", "to", "ok"])).toEqual(["ok"]);
  });

  test("deduplicates and sorts", () => {
    expect(tokenize(["fooBar", "foo_bar", "bar"])).toEqual(["bar", "foo"]);
  });
});
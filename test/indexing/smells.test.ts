import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { detectSmells } from "../../src/modules/indexing/smells.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(__dirname, "..", "..", "fixtures", "sample-js");

describe("detectSmells", () => {
	it("detects debugger in the audit fixture", async () => {
		const source = await readFile(path.join(fixtureRoot, "audit.js"), "utf8");
		const result = detectSmells(source, "js");

		expect(result.smells.some((s) => s.type === "debugger_statement")).toBe(true);
	});
});
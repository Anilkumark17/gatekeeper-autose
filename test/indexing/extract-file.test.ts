import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { extractFile } from "../../src/modules/indexing/extract-file.js";

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "sample-js");

async function fixtureFiles(): Promise<{ path: string; source: string }[]> {
	const out: { path: string; source: string }[] = [];
	async function walk(dir: string, rel: string) {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const ent of entries) {
			const relPath = rel ? `${rel}/${ent.name}` : ent.name;
			const abs = path.join(dir, ent.name);
			if (ent.isDirectory()) await walk(abs, relPath);
			else if (ent.name.endsWith(".js")) {
				out.push({
					path: `fixtures/sample-js/${relPath.replace(/\\/g, "/")}`,
					source: await readFile(abs, "utf8"),
				});
			}
		}
	}
	await walk(fixtureRoot, "");
	return out;
}

describe("extractFile", () => {
	test("all fixture files extract without throwing; stable content hash", async () => {
		const files = await fixtureFiles();
		expect(files.length).toBeGreaterThan(0);
		for (const f of files) {
			const a = extractFile(f.path, f.source, "js");
			const b = extractFile(f.path, f.source, "js");
			expect(a.contentHash).toMatch(/^[a-f0-9]{64}$/);
			expect(b.contentHash).toBe(a.contentHash);
		}
	});

	test("receipt.js: titleCase call and lineFor callback ref", async () => {
		const source = await readFile(path.join(fixtureRoot, "receipt.js"), "utf8");
		const facts = extractFile("fixtures/sample-js/receipt.js", source, "js");
		expect(facts.calls.some((c) => c.callee.name === "titleCase")).toBe(true);
		expect(facts.refs.some((r) => r.name === "lineFor" && r.role === "argument")).toBe(true);
	});

	test("checkout.js: DISCOUNT_RATE argument ref", async () => {
		const source = await readFile(path.join(fixtureRoot, "checkout.js"), "utf8");
		const facts = extractFile("fixtures/sample-js/checkout.js", source, "js");
		expect(facts.refs.some((r) => r.name === "DISCOUNT_RATE" && r.role === "argument")).toBe(true);
	});

	test("main.js: dynamic import recorded in imports", async () => {
		const source = await readFile(path.join(fixtureRoot, "main.js"), "utf8");
		const facts = extractFile("fixtures/sample-js/main.js", source, "js");
		expect(facts.imports.some((i) => i.kind === "dynamic" && i.specifier === "./pricing.js")).toBe(true);
	});

	const SYNTHETIC = `import { applyDiscount, DISCOUNT_RATE, lineFor } from "./lib";\n${Array.from(
		{ length: 50 },
		(_, i) => `export function f${i}(x) { return applyDiscount(x, DISCOUNT_RATE); return [1].map(lineFor); }`,
	).join("\n")}\n`;

	test("JSON stable across 10 runs for fixtures and synthetic file", async () => {
		const files = await fixtureFiles();
		for (const f of files) {
			const serial = Array.from({ length: 10 }, () =>
				JSON.stringify({
					...extractFile(f.path, f.source, "js"),
					parse: { hasError: false, errorCount: 0, ms: 0 },
				}),
			);
			for (let i = 1; i < serial.length; i++) expect(serial[i]).toBe(serial[0]);
		}
		const p = "fixtures/synthetic-heavy.js";
		const serial = Array.from({ length: 10 }, () =>
			JSON.stringify({
				...extractFile(p, SYNTHETIC, "js"),
				parse: { hasError: false, errorCount: 0, ms: 0 },
			}),
		);
		for (let i = 1; i < serial.length; i++) expect(serial[i]).toBe(serial[0]);
	});

});
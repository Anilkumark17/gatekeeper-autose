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

describe("extractFile (perf)", () => {
	test("200x all fixtures completes under 5s", async () => {
		const files = await fixtureFiles();
		for (const f of files) extractFile(f.path, f.source, "js");
		const t0 = performance.now();
		for (let i = 0; i < 200; i++) {
			for (const f of files) extractFile(f.path, f.source, "js");
		}
		const elapsed = performance.now() - t0;
		console.log(`[perf] extract-file 200x fixtures: ${elapsed.toFixed(1)}ms (limit 2000ms)`);
		expect(elapsed).toBeLessThan(2000);
	});
});
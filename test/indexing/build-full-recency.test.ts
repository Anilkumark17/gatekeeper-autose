import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { runFileRecencyStep } from "../../src/modules/indexing/build/build-full.js";
import { compileGraph } from "../../src/modules/indexing/build/graph.repo.js";
import { discover } from "../../src/modules/indexing/discover.js";
import type { FileFacts } from "../../src/modules/indexing/extract-file.js";
import { extractFile } from "../../src/modules/indexing/extract-file.js";
import { buildEdges } from "../../src/modules/indexing/graph/build-edges.js";
import { detectLang } from "../../src/modules/indexing/lang.js";
import { createResolver } from "../../src/modules/indexing/resolve/resolve-imports.js";

const sampleJsRoot = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"fixtures",
	"sample-js",
);

async function sampleCompiled() {
	const discovery = await discover(sampleJsRoot);
	const facts = new Map<string, Awaited<ReturnType<typeof extractFile>>>();
	for (const f of discovery.files) {
		const lang = detectLang(f.path) ?? "js";
		const src = await import("node:fs/promises").then((fs) => fs.readFile(f.abs, "utf8"));
		facts.set(f.path, extractFile(f.path, src, lang));
	}
	const resolver = createResolver(sampleJsRoot, discovery);
	for (const f of discovery.files) {
		const fileFacts = facts.get(f.path);
		if (!fileFacts) continue;
		for (const imp of fileFacts.imports) resolver.resolve(f.path, imp);
	}
	const graph = buildEdges(facts, resolver);
	return { discovery, facts, graph };
}

describe("buildFull file recency", () => {
	test("graph compile output unchanged when fileRecencyCsv is populated", async () => {
		const { discovery, facts, graph } = await sampleCompiled();
		const a = compileGraph("rid", discovery, facts, graph);
		const b = compileGraph("rid", discovery, facts, graph);
		b.fileRecencyCsv = [["rid", "extra.test.js", "deadbeef", "2020-01-01T00:00:00.000Z", false]];
		expect(a.nodeCsv).toEqual(b.nodeCsv);
		expect(a.edgeCsv).toEqual(b.edgeCsv);
	});

	test("recency failure yields status failed; graph compile unchanged", async () => {
		const { discovery, facts, graph } = await sampleCompiled();
		expect(discovery.mode).toBe("git");

		const failing = async () => {
			throw new Error("recency boom");
		};

		const { recency, fileRecencyCsv } = await runFileRecencyStep(
			"rid",
			sampleJsRoot,
			discovery,
			facts as Map<string, FileFacts>,
			failing,
		);
		expect(recency.status).toBe("failed");
		expect(recency.reason).toMatch(/recency boom/);
		expect(fileRecencyCsv).toEqual([]);

		const compiled = compileGraph("rid", discovery, facts, graph);
		compiled.fileRecencyCsv = fileRecencyCsv;
		expect(compiled.nodeCsv.length).toBeGreaterThan(0);
	});
});

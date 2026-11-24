import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { symbolId } from "../../src/core/ids.js";
import { discover } from "../../src/modules/indexing/discover.js";
import type { FileFacts } from "../../src/modules/indexing/extract-file.js";
import { createExtractPool } from "../../src/modules/indexing/extract-pool.js";
import { buildEdges } from "../../src/modules/indexing/graph/build-edges.js";
import { createResolver } from "../../src/modules/indexing/resolve/resolve-imports.js";

const sampleJsRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "sample-js");

async function sampleGraph() {
	const discovery = await discover(sampleJsRoot);
	const pool = createExtractPool({ threads: 2 });
	const tasks = discovery.files.map((f) => ({ path: f.path, abs: f.abs, lang: f.lang }));
	const facts = new Map<string, FileFacts>();
	for await (const row of pool.run(tasks)) {
		if (row.ok) facts.set(row.path, row.facts);
	}
	await pool.destroy();
	const resolver = createResolver(sampleJsRoot, discovery);
	const graph = buildEdges(facts, resolver);
	return { discovery, facts, graph };
}

describe("buildEdges", () => {
	test("lineFor calls titleCase through utils barrel", async () => {
		const { graph } = await sampleGraph();
		const from = symbolId("receipt.js", "lineFor");
		const to = symbolId("utils/string.js", "titleCase");
		expect(
			graph.edges.some(
				(e) => e.type === "calls" && e.src === from && e.dst === to && e.path === "receipt.js",
			),
		).toBe(true);
	});

	test("receiptLines references lineFor as argument", async () => {
		const { graph } = await sampleGraph();
		const from = symbolId("receipt.js", "receiptLines");
		const to = symbolId("receipt.js", "lineFor");
		expect(
			graph.edges.some(
				(e) =>
					e.type === "references" &&
					e.src === from &&
					e.dst === to &&
					e.meta?.role === "argument" &&
					e.path === "receipt.js",
			),
		).toBe(true);
	});

	test("DISCOUNT_RATE flows into applyDiscount", async () => {
		const { graph } = await sampleGraph();
		const from = symbolId("config.js", "DISCOUNT_RATE");
		const to = symbolId("pricing.js", "applyDiscount");
		expect(
			graph.edges.some(
				(e) =>
					e.type === "flows_into" &&
					e.src === from &&
					e.dst === to &&
					e.path === "checkout.js" &&
					e.meta?.argIndex === 1,
			),
		).toBe(true);
	});

	test("titleCase has exactly three incoming call edges", async () => {
		const { graph } = await sampleGraph();
		const dst = symbolId("utils/string.js", "titleCase");
		const callers = graph.edges.filter((e) => e.type === "calls" && e.dst === dst).map((e) => e.src);
		expect(callers.sort()).toEqual(
			[
				symbolId("receipt.js", "formatHeader"),
				symbolId("receipt.js", "lineFor"),
				symbolId("receipt.js", "renderReceipt"),
			].sort(),
		);
	});

	test("main.js dynamic import edge has meta.dynamic", async () => {
		const { graph } = await sampleGraph();
		expect(
			graph.edges.some(
				(e) => e.type === "imports" && e.path === "main.js" && e.meta?.dynamic === true,
			),
		).toBe(true);
	});

	test("buildEdges is deterministic", async () => {
		const { facts } = await sampleGraph();
		const discovery = await discover(sampleJsRoot);
		const resolver = createResolver(sampleJsRoot, discovery);
		const a = JSON.stringify(buildEdges(facts, resolver).edges);
		const b = JSON.stringify(buildEdges(facts, resolver).edges);
		expect(a).toBe(b);
	});
});
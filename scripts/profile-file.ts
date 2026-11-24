import { readFile } from "node:fs/promises";
import path from "node:path";
import { extractFile } from "../src/modules/indexing/extract-file.js";
import { detectLang } from "../src/modules/indexing/lang.js";

const [root, rel, times = "20"] = process.argv.slice(2);
if (!root || !rel) throw new Error("usage: tsx scripts/profile-file.ts <repo-root> <repo-relative-file> [times]");

const abs = path.join(root, ...rel.split("/"));
const lang = detectLang(rel);
if (!lang) throw new Error(`not a JS/TS file: ${rel}`);
const src = await readFile(abs, "utf8");

const n = Number(times);
const t0 = performance.now();
let facts = extractFile(rel, src, lang);
for (let i = 1; i < n; i++) facts = extractFile(rel, src, lang);
const ms = (performance.now() - t0) / n;

console.log(
	JSON.stringify({
		file: rel,
		kb: Math.round(src.length / 1024),
		runs: n,
		msPerRun: +ms.toFixed(1),
		symbols: facts.symbols.length,
		calls: facts.calls.length,
		refs: facts.refs.length,
	}),
);
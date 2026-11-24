import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("usage: tsx scripts/cpuprofile-top.mjs <file>");

const p = JSON.parse(readFileSync(path, "utf8"));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const samples = p.samples ?? [];
const deltas = p.timeDeltas ?? [];

function label(id) {
	const n = byId.get(id);
	if (!n) return `(missing ${id})`;
	const name = n.callFrame.functionName || "(anonymous)";
	const url = n.callFrame.url ?? "";
	const file = url.split(/[/\\]/).pop() || url;
	return `${name}  ${file}`.trim();
}

const self = new Map();
let total = 0;
for (let i = 0; i < samples.length; i++) {
	const id = samples[i];
	const dt = deltas[i] ?? 0;
	total += dt;
	const key = label(id);
	self.set(key, (self.get(key) ?? 0) + dt);
}

const ranked = [...self.entries()]
	.map(([k, us]) => ({ k, pct: total ? (100 * us) / total : 0, us }))
	.sort((a, b) => b.us - a.us);

console.log(`samples=${samples.length} totalUs=${total}`);
for (const r of ranked.slice(0, 10)) {
	console.log(`${r.pct.toFixed(2)}%\t${r.k}`);
}
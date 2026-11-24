import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { discover } from "../../src/modules/indexing/discover.js";
import { extractFile, type FileFacts } from "../../src/modules/indexing/extract-file.js";
import {
	createExtractPool,
	extractPoolSubmittedInFlight,
	type ExtractTask,
} from "../../src/modules/indexing/extract-pool.js";

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "sample-js");
const sleepWorker = fileURLToPath(new URL("../fixtures/workers/sleep-worker.ts", import.meta.url));

function tasksFromDiscovery(root: string): Promise<ExtractTask[]> {
	return discover(root).then((d) =>
		d.files.map((f) => ({ path: f.path, abs: f.abs, lang: f.lang })),
	);
}

async function sequentialFacts(tasks: ExtractTask[]): Promise<Map<string, FileFacts>> {
	const out = new Map<string, FileFacts>();
	for (const t of tasks) {
		const source = await readFile(t.abs, "utf8");
		out.set(t.path, extractFile(t.path, source, t.lang));
	}
	return out;
}

describe(
	"extract pool",
	() => {
		test("pool results match sequential extractFile for fixtures/sample-js", async () => {
			const tasks = await tasksFromDiscovery(fixtureRoot);
			expect(tasks.length).toBeGreaterThan(0);
			const expected = await sequentialFacts(tasks);
			const pool = createExtractPool({ threads: 2 });
			try {
				for await (const result of pool.run(tasks)) {
					expect(result.ok).toBe(true);
					if (!result.ok) continue;
					const seq = expected.get(result.path);
					expect(seq).toBeDefined();
					const norm = (f: FileFacts): FileFacts => ({
						...f,
						parse: { ...f.parse, ms: 0 },
					});
					expect(norm(result.facts)).toEqual(norm(seq!));
					expect(result.facts.contentHash).toBe(seq!.contentHash);
				}
			} finally {
				await pool.destroy();
			}
		});

		test("one bad path does not fail the run", async () => {
			const tasks = await tasksFromDiscovery(fixtureRoot);
			const bad: ExtractTask = {
				path: "missing.js",
				abs: path.join(fixtureRoot, "no-such-file.js"),
				lang: "js",
			};
			const all = [...tasks.slice(0, 3), bad, ...tasks.slice(3, 5)];
			const pool = createExtractPool({ threads: 2 });
			const outcomes = { ok: 0, err: 0 };
			try {
				for await (const result of pool.run(all)) {
					if (result.ok) outcomes.ok++;
					else {
						outcomes.err++;
						expect(result.path).toBe("missing.js");
						expect(result.reason).toBe("extract_error");
					}
				}
			} finally {
				await pool.destroy();
			}
			expect(outcomes.err).toBe(1);
			expect(outcomes.ok).toBe(all.length - 1);
		});

		test("timeout aborts slow worker and pool remains usable", async () => {
			const pool = createExtractPool({
				workerFile: sleepWorker,
				timeoutMs: 500,
				threads: 2,
			});
			const t0 = performance.now();
			try {
				for await (const result of pool.run([{ path: "slow/task", abs: "n/a", lang: "js" }])) {
					expect(result.ok).toBe(false);
					if (!result.ok) expect(result.reason).toBe("extract_timeout");
				}
				expect(performance.now() - t0).toBeLessThan(3000);

				for await (const result of pool.run([{ path: "fast/ok", abs: "n/a", lang: "js" }])) {
					expect(result.ok).toBe(true);
				}
			} finally {
				await pool.destroy();
			}
		});

		test("maxInFlight caps submitted-but-unfinished tasks", async () => {
			const tasks = Array.from({ length: 10 }, (_, i) => ({
				path: i % 2 === 0 ? `slow/${i}` : `fast/${i}`,
				abs: "n/a",
				lang: "js" as const,
			}));
			const pool = createExtractPool({
				workerFile: sleepWorker,
				timeoutMs: 400,
				maxInFlight: 2,
				threads: 2,
			});
			let peak = 0;
			const tick = setInterval(() => {
				peak = Math.max(peak, extractPoolSubmittedInFlight);
			}, 1);
			const t0 = performance.now();
			try {
				for await (const _ of pool.run(tasks)) {
					peak = Math.max(peak, extractPoolSubmittedInFlight);
				}
			} finally {
				clearInterval(tick);
				await pool.destroy();
			}
			expect(peak).toBeLessThanOrEqual(2);
			expect(performance.now() - t0).toBeLessThan(5000);
		});

		test("run() after destroy() throws", async () => {
			const pool = createExtractPool({ threads: 2 });
			await pool.destroy();
			const gen = pool.run([{ path: "x.js", abs: path.join(fixtureRoot, "cart.js"), lang: "js" }]);
			await expect(gen.next()).rejects.toThrow(/destroyed/i);
		});
	},
	30_000,
);
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(scriptDir, "..");
const self = fileURLToPath(import.meta.url);

function parseRuns(argv: string[]): number {
	const idx = argv.indexOf("--runs");
	if (idx >= 0) {
		const n = Number(argv[idx + 1]);
		if (Number.isFinite(n) && n > 0) return Math.floor(n);
	}
	return 50;
}

async function childOnce(): Promise<void> {
	const { discover } = await import("../src/modules/indexing/discover.js");
	const { createExtractPool } = await import("../src/modules/indexing/extract-pool.js");

	const sampleJs = path.join(root, "fixtures", "sample-js");
	const calcom = path.join(root, "bench", "cal.com");

	const sample = await discover(sampleJs);
	const tasks = sample.files.map((f) => ({ path: f.path, abs: f.abs, lang: f.lang }));

	if (existsSync(calcom)) {
		const large = await discover(calcom);
		tasks.push(...large.files.slice(0, 300).map((f) => ({ path: f.path, abs: f.abs, lang: f.lang })));
	}

	const pool = createExtractPool();
	try {
		let count = 0;
		for await (const row of pool.run(tasks)) {
			if (row.ok) count++;
		}
		if (count === 0 && tasks.length > 0) process.exitCode = 2;
	} finally {
		await pool.destroy();
	}
}

if (process.argv.includes("--child")) {
	await childOnce();
	process.exit(process.exitCode ?? 0);
}

const runs = parseRuns(process.argv.slice(2));
const failures: { run: number; code: number | null; signal: string | null }[] = [];
const codes = new Map<number, number>();

for (let i = 1; i <= runs; i++) {
	try {
		await execFileAsync(process.execPath, ["--import", "tsx", self, "--child"], {
			cwd: root,
			env: { ...process.env, INDEX_WORKERS: process.env.INDEX_WORKERS ?? "2" },
			windowsHide: true,
		});
	} catch (err: unknown) {
		const e = err as { code?: number | null; signal?: string | null; status?: number | null };
		const code = typeof e.status === "number" ? e.status : typeof e.code === "number" ? e.code : null;
		const signal = e.signal ?? null;
		failures.push({ run: i, code, signal });
		const key = code ?? -1;
		codes.set(key, (codes.get(key) ?? 0) + 1);
	}
}

console.log(
	JSON.stringify({
		runs,
		failures: failures.length,
		exitCodes: Object.fromEntries(codes),
		failedRuns: failures,
	}),
);

if (failures.length > 0) process.exit(1);
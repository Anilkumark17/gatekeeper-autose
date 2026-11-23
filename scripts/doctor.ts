import { execSync } from "node:child_process";
import "dotenv/config";
import pg from "pg";
import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";

type CheckResult = { name: string; ok: boolean; ms: number; detail?: string };

function isPlaceholderUrl(url: string | undefined): boolean {
	if (!url) return true;
	return url.includes("USER:PASS") || url.includes("USER:PASSWORD");
}

async function timed(name: string, run: () => Promise<void> | void): Promise<CheckResult> {
	const started = performance.now();
	try {
		await run();
		return { name, ok: true, ms: Math.round(performance.now() - started) };
	} catch (err) {
		return {
			name,
			ok: false,
			ms: Math.round(performance.now() - started),
			detail: err instanceof Error ? err.message : String(err),
		};
	}
}

function checkNode(): CheckResult {
	const major = Number(process.versions.node.split(".")[0] ?? 0);
	return {
		name: "node >= 22",
		ok: major >= 22,
		ms: 0,
		detail: major >= 22 ? undefined : `found ${process.versions.node}`,
	};
}

async function main(): Promise<void> {
	const results: CheckResult[] = [];

	results.push(checkNode());

	results.push(
		await timed("git", () => {
			execSync("git --version", { stdio: "pipe" });
		}),
	);

	results.push(
		await timed("tree-sitter js/ts/tsx", () => {
			const jsParser = new Parser();
			jsParser.setLanguage(JavaScript as unknown as Parser.Language);
			const tsParser = new Parser();
			tsParser.setLanguage(TypeScript.typescript as unknown as Parser.Language);
			const tsxParser = new Parser();
			tsxParser.setLanguage(TypeScript.tsx as unknown as Parser.Language);
			const smoke = "export const ok = 1;";
			if (jsParser.parse(smoke).rootNode.hasError) throw new Error("javascript parse failed");
			if (tsParser.parse(smoke).rootNode.hasError) throw new Error("typescript parse failed");
			if (tsxParser.parse("<App />").rootNode.hasError) throw new Error("tsx parse failed");
		}),
	);

	const directUrl = process.env.DATABASE_URL_DIRECT;
	const pooledUrl = process.env.DATABASE_URL;
	const testUrl = process.env.TEST_DATABASE_URL;

	if (!isPlaceholderUrl(directUrl)) {
		results.push(
			await timed("neon direct pgvector+halfvec", async () => {
				const pool = new pg.Pool({
					connectionString: directUrl,
					max: 1,
					connectionTimeoutMillis: 8_000,
				});
				try {
					const vector = await pool.query(
						"SELECT extname FROM pg_extension WHERE extname = 'vector'",
					);
					if (vector.rowCount === 0) throw new Error("pgvector extension missing");
					await pool.query("SELECT '[1,2,3]'::halfvec(3)");
				} finally {
					await pool.end();
				}
			}),
		);
	}

	if (!isPlaceholderUrl(pooledUrl)) {
		results.push(
			await timed("neon pooled set_config tx", async () => {
				const pool = new pg.Pool({
					connectionString: pooledUrl,
					max: 1,
					connectionTimeoutMillis: 8_000,
				});
				const client = await pool.connect();
				try {
					await client.query("BEGIN");
					await client.query("SELECT set_config('application_name', 'gatekeeper-doctor', true)");
					await client.query("COMMIT");
				} finally {
					client.release();
					await pool.end();
				}
			}),
		);
	}

	if (!isPlaceholderUrl(testUrl)) {
		results.push(
			await timed("neon test branch pgvector", async () => {
				const pool = new pg.Pool({
					connectionString: testUrl,
					max: 1,
					connectionTimeoutMillis: 8_000,
				});
				try {
					const vector = await pool.query(
						"SELECT extname FROM pg_extension WHERE extname = 'vector'",
					);
					if (vector.rowCount === 0) throw new Error("pgvector extension missing on test branch");
				} finally {
					await pool.end();
				}
			}),
		);
	}

	for (const result of results) {
		const status = result.ok ? "PASS" : "FAIL";
		const detail = result.detail ? ` — ${result.detail}` : "";
		console.log(`${status} ${result.name} (${result.ms}ms)${detail}`);
	}

	const failed = results.some((r) => !r.ok);
	if (failed) process.exit(1);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

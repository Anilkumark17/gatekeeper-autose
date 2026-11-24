import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as schema from "../../src/db/schema.js";
import type { DiscoveryResult } from "../../src/modules/indexing/discover.js";
import { saveDiscovery } from "../../src/modules/indexing/files.repo.js";

const { files, repos } = schema;

if (process.env.CI && !process.env.TEST_DATABASE_URL) {
	throw new Error("TEST_DATABASE_URL must be set when CI=true");
}

const url = process.env.TEST_DATABASE_URL;
if (!url) {
	console.warn("Skipping saveDiscovery (Neon): set TEST_DATABASE_URL to run database integration tests");
}

function result(paths: string[], skipped: { path: string; reason: "minified" }[] = []): DiscoveryResult {
	return {
		root: "/tmp/x",
		source: "walk",
		files: paths.map((p) => ({ path: p, abs: `/tmp/x/${p}`, lang: "js", size: 10, pkg: "", tsconfig: null })),
		skipped,
		packages: [],
		counts: { listed: paths.length + skipped.length, indexed: paths.length, skipped: skipped.length, notSource: 3 },
		ms: 0,
	};
}

function isConnectionTimeout(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	const msg = err.message.toLowerCase();
	return msg.includes("timeout") || msg.includes("timed out") || (err as NodeJS.ErrnoException).code === "ETIMEDOUT";
}

describe.skipIf(!url)("saveDiscovery (Neon test branch)", () => {
	const pool = new pg.Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 20_000 });
	const db = drizzle(pool, { schema });
	const repoId = randomUUID();

	async function seedRepo(): Promise<void> {
		await db.insert(repos).values({ id: repoId, root: "/tmp/x", name: `test-${repoId.slice(0, 8)}` });
	}

	beforeAll(async () => {
		const attempt = async (label: string) => {
			const t0 = performance.now();
			await seedRepo();
			const elapsed = Math.round(performance.now() - t0);
			console.log(`saveDiscovery beforeAll ${label}: ${elapsed}ms`);
		};
		try {
			await attempt("attempt 1");
		} catch (err) {
			if (!isConnectionTimeout(err)) throw err;
			await attempt("attempt 2 (after connection timeout)");
		}
	}, 45_000);

	afterAll(async () => {
		await db.delete(files).where(eq(files.repoId, repoId));
		await db.delete(repos).where(eq(repos.id, repoId));
		await pool.end();
	}, 45_000);

	test(
		"first save inserts indexed and skipped files",
		async () => {
		const r = await saveDiscovery(db, repoId, result(["src/a.js", "src/b.js"], [{ path: "public/v.min.js", reason: "minified" }]));
		expect(r).toMatchObject({ upserted: 3, deleted: 0 });

		const rows = await db.select().from(files).where(eq(files.repoId, repoId));
		expect(rows).toHaveLength(3);
		expect(rows.find((x) => x.path === "public/v.min.js")).toMatchObject({ skipped: true, error: "minified" });
		},
		45_000,
	);

	test(
		"re-save keeps content_hash set by the extractor",
		async () => {
		const contentHash = "a".repeat(64);
		await db
			.update(files)
			.set({ contentHash })
			.where(and(eq(files.repoId, repoId), eq(files.path, "src/a.js")));
		await saveDiscovery(db, repoId, result(["src/a.js", "src/b.js"], [{ path: "public/v.min.js", reason: "minified" }]));

		const [row] = await db
			.select()
			.from(files)
			.where(and(eq(files.repoId, repoId), eq(files.path, "src/a.js")));
		expect(row?.contentHash).toBe(contentHash);
		},
		45_000,
	);

	test(
		"removed files are deleted and graph_version is bumped",
		async () => {
		const [before] = await db.select().from(repos).where(eq(repos.id, repoId));
		const r = await saveDiscovery(db, repoId, result(["src/a.js"]));
		const [after] = await db.select().from(repos).where(eq(repos.id, repoId));

		expect(r.deleted).toBe(2);
		expect(Number(after?.graphVersion)).toBe(Number(before?.graphVersion) + 1);
		const rows = await db.select().from(files).where(eq(files.repoId, repoId));
		expect(rows.map((x) => x.path)).toEqual(["src/a.js"]);
		},
		45_000,
	);
});
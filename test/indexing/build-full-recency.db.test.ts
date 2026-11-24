import "dotenv/config";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as schema from "../../src/db/schema.js";
import { buildFull } from "../../src/modules/indexing/build/build-full.js";
import { graphDeterminismHash } from "../../src/modules/indexing/build/graph.repo.js";
import { gitTestBin } from "../helpers/git.js";

const execFileAsync = promisify(execFile);
const { repos, edges, nodes, searchDocs, files, fileRecency } = schema;

const url = process.env.TEST_DATABASE_URL;
const directUrl = process.env.TEST_DATABASE_URL_DIRECT ?? url;

const describeDb = describe.skipIf(!url || !gitTestBin);

async function git(args: string[], cwd: string) {
	if (!gitTestBin) throw new Error("git not available");
	await execFileAsync(gitTestBin, args, { cwd });
}

describeDb("buildFull file_recency (Neon)", () => {
	const pooled = new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 20_000 });
	const direct = new pg.Pool({
		connectionString: directUrl,
		max: 2,
		connectionTimeoutMillis: 20_000,
	});
	const db = drizzle(pooled, { schema });
	const repoId = randomUUID();
	const bundle = { db, pool: pooled, direct };
	const tmpRoot = path.join(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
		".tmp-recency-git",
	);

	beforeAll(async () => {
		await rm(tmpRoot, { recursive: true, force: true });
		await mkdir(tmpRoot, { recursive: true });
		await git(["init"], tmpRoot);
		await git(["config", "user.email", "test@test.local"], tmpRoot);
		await git(["config", "user.name", "Test"], tmpRoot);

		await writeFile(path.join(tmpRoot, "first.js"), "export const one = 1;\n");
		await git(["add", "first.js"], tmpRoot);
		await git(["commit", "-m", "add first"], tmpRoot);

		await new Promise((r) => setTimeout(r, 1100));

		await writeFile(path.join(tmpRoot, "second.js"), "export const two = 2;\n");
		await git(["add", "second.js"], tmpRoot);
		await git(["commit", "-m", "add second"], tmpRoot);

		await db.insert(repos).values({ id: repoId, root: tmpRoot, name: "recency-git-fixture" });
	}, 60_000);

	afterAll(async () => {
		await db.delete(fileRecency).where(eq(fileRecency.repoId, repoId));
		await db.delete(edges).where(eq(edges.repoId, repoId));
		await db.delete(nodes).where(eq(nodes.repoId, repoId));
		await db.delete(searchDocs).where(eq(searchDocs.repoId, repoId));
		await db.delete(files).where(eq(files.repoId, repoId));
		await db.delete(repos).where(eq(repos.id, repoId));
		await direct.end();
		await pooled.end();
		await rm(tmpRoot, { recursive: true, force: true });
	}, 45_000);

	test("persist file_recency rows; second.js has newest commit", async () => {
		const stats = await buildFull(tmpRoot, repoId, bundle);
		expect(stats.recency.status).toBe("ok");
		expect(stats.recency.files).toBeGreaterThanOrEqual(2);

		const rows = await db.select().from(fileRecency).where(eq(fileRecency.repoId, repoId));
		expect(rows.length).toBeGreaterThanOrEqual(2);

		const second = rows.find((r) => r.path === "second.js");
		const first = rows.find((r) => r.path === "first.js");
		expect(second).toBeDefined();
		expect(first).toBeDefined();
			expect(second?.atBoundary).toBe(false);
			expect(second?.lastSha).not.toBe(first?.lastSha);
			expect(second?.lastAt.getTime() ?? 0).toBeGreaterThanOrEqual(first?.lastAt.getTime() ?? 0);
	}, 120_000);

	test("graphHash unchanged when recency returns empty", async () => {
		const hashBefore = await graphDeterminismHash(db, repoId);
		const emptyRecency = async () => ({
			byNode: new Map(),
			recentFilePaths: [],
			stats: {
				commitsRead: 0,
				filesWithHistory: 0,
				filesBoundary: 0,
				filesRealHistory: 0,
				filesIndexed: 0,
				filesWithHistoryPct: 0,
				filesBoundaryPct: 0,
				filesRealHistoryPct: 0,
				blamedFiles: 0,
				symbolsWithBlameRecency: 0,
				symbolsTotal: 0,
				shallowWarning: null,
				logMs: 0,
				blameMs: 0,
				ms: 0,
			},
		});
		const stats = await buildFull(tmpRoot, repoId, bundle, { computeRecencyFn: emptyRecency });
		expect(stats.recency.status).toBe("ok");
		const hashAfter = await graphDeterminismHash(db, repoId);
		expect(hashAfter).toBe(hashBefore);
	}, 120_000);
});

import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as schema from "../../db/schema.js";
import { buildFull } from "../indexing/build/build-full.js";
import { classifyTestFile } from "./classify.js";
import { testsCoveringNode } from "./graph-query.adapter.js";

const { repos, edges, nodes, searchDocs, files } = schema;

if (process.env.CI && !process.env.TEST_DATABASE_URL) {
	throw new Error("TEST_DATABASE_URL must be set when CI=true");
}

const url = process.env.TEST_DATABASE_URL;
const directUrl = process.env.TEST_DATABASE_URL_DIRECT ?? url;
const sampleJsRoot = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"fixtures",
	"sample-js",
);

describe.skipIf(!url)("testsCoveringNode (Neon sample-js)", () => {
	const pooled = new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 20_000 });
	const direct = new pg.Pool({
		connectionString: directUrl,
		max: 2,
		connectionTimeoutMillis: 20_000,
	});
	const db = drizzle(pooled, { schema });
	const repoId = randomUUID();
	const bundle = { db, pool: pooled, direct };

	beforeAll(async () => {
		await db.insert(repos).values({
			id: repoId,
			root: sampleJsRoot,
			name: `tests-covering-${repoId.slice(0, 8)}`,
		});
		await buildFull(sampleJsRoot, repoId, bundle);
	}, 120_000);

	afterAll(async () => {
		await db.delete(edges).where(eq(edges.repoId, repoId));
		await db.delete(nodes).where(eq(nodes.repoId, repoId));
		await db.delete(searchDocs).where(eq(searchDocs.repoId, repoId));
		await db.delete(files).where(eq(files.repoId, repoId));
		await db.delete(repos).where(eq(repos.id, repoId));
		await direct.end();
		await pooled.end();
	}, 45_000);

	test("testsCoveringNode on titleCase returns only classified test paths", async () => {
		const titleCase = "utils/string.js#titleCase";
		const result = await testsCoveringNode(pooled, repoId, titleCase);
		expect(result.truncated).toBe(false);
		for (const row of result.tests) {
			const role = classifyTestFile(row.testPath);
			expect(role === "test" || role === "e2e").toBe(true);
		}
	}, 60_000);
});

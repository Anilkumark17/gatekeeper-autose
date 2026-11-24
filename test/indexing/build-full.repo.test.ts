import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as schema from "../../src/db/schema.js";
import { buildFull } from "../../src/modules/indexing/build/build-full.js";
import { graphDeterminismHash } from "../../src/modules/indexing/build/graph.repo.js";

const { repos, edges, nodes, searchDocs, files, fileRecency } = schema;

if (process.env.CI && !process.env.TEST_DATABASE_URL) {
	throw new Error("TEST_DATABASE_URL must be set when CI=true");
}

const url = process.env.TEST_DATABASE_URL;
const directUrl = process.env.TEST_DATABASE_URL_DIRECT ?? url;
const sampleJsRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "sample-js");

describe.skipIf(!url)("buildFull (Neon test branch)", () => {
	const pooled = new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 20_000 });
	const direct = new pg.Pool({ connectionString: directUrl, max: 2, connectionTimeoutMillis: 20_000 });
	const db = drizzle(pooled, { schema });
	const repoId = randomUUID();
	const bundle = { db, pool: pooled, direct };

	beforeAll(async () => {
		await db.insert(repos).values({
			id: repoId,
			root: sampleJsRoot,
			name: `build-full-${repoId.slice(0, 8)}`,
		});
	}, 45_000);

	afterAll(async () => {
		await db.delete(fileRecency).where(eq(fileRecency.repoId, repoId));
		await db.delete(edges).where(eq(edges.repoId, repoId));
		await db.delete(nodes).where(eq(nodes.repoId, repoId));
		await db.delete(searchDocs).where(eq(searchDocs.repoId, repoId));
		await db.delete(files).where(eq(files.repoId, repoId));
		await db.delete(repos).where(eq(repos.id, repoId));
		await direct.end();
		await pooled.end();
	}, 45_000);

	test(
		"first build populates graph tables and fixture edges",
		async () => {
			const stats = await buildFull(sampleJsRoot, repoId, bundle);
			expect(stats.counts.nodes).toBeGreaterThan(0);
			expect(stats.counts.edges).toBeGreaterThan(0);
			expect(stats.counts.searchDocs).toBeGreaterThan(0);
			expect(stats.counts.files).toBeGreaterThan(0);
			expect(stats.graphVersion).toBeGreaterThan(0);

			const titleCase = "utils/string.js#titleCase";
			const incoming = await db
				.select()
				.from(edges)
				.where(
					and(eq(edges.repoId, repoId), eq(edges.dst, titleCase), eq(edges.type, "calls")),
				);
			expect(incoming).toHaveLength(3);

			const flow = await db
				.select()
				.from(edges)
				.where(
					and(
						eq(edges.repoId, repoId),
						eq(edges.type, "flows_into"),
						eq(edges.src, "config.js#DISCOUNT_RATE"),
						eq(edges.dst, "pricing.js#applyDiscount"),
					),
				);
			expect(flow.length).toBeGreaterThan(0);

			const hash = await graphDeterminismHash(db, repoId);
			expect(stats.graphHash).toBe(hash);
		},
		120_000,
	);

	test(
		"second build keeps hash and bumps graph_version",
		async () => {
			const [before] = await db.select().from(repos).where(eq(repos.id, repoId));
			const firstHash = await graphDeterminismHash(db, repoId);
			const stats = await buildFull(sampleJsRoot, repoId, bundle);
			const [after] = await db.select().from(repos).where(eq(repos.id, repoId));

			expect(stats.graphHash).toBe(firstHash);
			expect(Number(after?.graphVersion)).toBe(Number(before?.graphVersion) + 1);
		},
		120_000,
	);

	test(
		"swap failure leaves previous graph intact",
		async () => {
			const hashBefore = await graphDeterminismHash(db, repoId);
			const [repoBefore] = await db.select().from(repos).where(eq(repos.id, repoId));
			const edgeCountBefore = (
				await db
					.select({ c: sql<number>`count(*)::int` })
					.from(edges)
					.where(eq(edges.repoId, repoId))
			)[0]?.c;

			await expect(
				buildFull(sampleJsRoot, repoId, bundle, { simulateSwapFailure: true }),
			).rejects.toThrow(/simulateSwapFailure/);

			const hashAfter = await graphDeterminismHash(db, repoId);
			const [repoAfter] = await db.select().from(repos).where(eq(repos.id, repoId));
			const edgeCountAfter = (
				await db
					.select({ c: sql<number>`count(*)::int` })
					.from(edges)
					.where(eq(edges.repoId, repoId))
			)[0]?.c;

			expect(hashAfter).toBe(hashBefore);
			expect(Number(repoAfter?.graphVersion)).toBe(Number(repoBefore?.graphVersion));
			expect(edgeCountAfter).toBe(edgeCountBefore);
		},
		120_000,
	);
});
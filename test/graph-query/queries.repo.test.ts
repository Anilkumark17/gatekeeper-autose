import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as schema from "../../src/db/schema.js";
import { buildFull } from "../../src/modules/indexing/build/build-full.js";
import { dependents, findByName } from "../../src/modules/graph-query/queries.repo.js";
import { path as graphPath, walk } from "../../src/modules/graph-query/walk.js";

const { repos, edges, nodes, searchDocs, files } = schema;

if (process.env.CI && !process.env.TEST_DATABASE_URL) {
	throw new Error("TEST_DATABASE_URL must be set when CI=true");
}

const url = process.env.TEST_DATABASE_URL;
const directUrl = process.env.TEST_DATABASE_URL_DIRECT ?? url;
const sampleJsRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "sample-js");

describe.skipIf(!url)("graph queries (Neon test branch)", () => {
	const pooled = new pg.Pool({ connectionString: url, max: 3, connectionTimeoutMillis: 20_000 });
	const direct = new pg.Pool({ connectionString: directUrl, max: 2, connectionTimeoutMillis: 20_000 });
	const db = drizzle(pooled, { schema });
	const repoId = randomUUID();
	const bundle = { db, pool: pooled, direct };

	beforeAll(async () => {
		await db.insert(repos).values({
			id: repoId,
			root: sampleJsRoot,
			name: `graph-query-${repoId.slice(0, 8)}`,
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

	const titleCase = "utils/string.js#titleCase";
	const lineFor = "receipt.js#lineFor";

	test("dependents(titleCase, calls) returns three planted callers", async () => {
		const rows = await dependents(pooled, repoId, titleCase, { types: ["calls"] });
		expect(rows).toHaveLength(3);
		const srcs = rows.map((r) => r.src).sort();
		expect(srcs).toEqual(
			["receipt.js#formatHeader", "receipt.js#lineFor", "receipt.js#renderReceipt"].sort(),
		);
		for (const row of rows) {
			expect(row.type).toBe("calls");
			expect(row.line).toBeGreaterThan(0);
		}
	});

	test("path(lineFor -> titleCase) is a single calls edge", async () => {
		const edgesOnPath = await graphPath(pooled, repoId, lineFor, titleCase, { types: ["calls"] });
		expect(edgesOnPath).not.toBeNull();
		expect(edgesOnPath).toHaveLength(1);
		expect(edgesOnPath![0]).toMatchObject({
			src: lineFor,
			dst: titleCase,
			type: "calls",
		});
		expect(edgesOnPath![0]!.src).not.toContain("utils/index.js");
	});

	test("walk out from DISCOUNT_RATE reaches applyDiscount via flows_into", async () => {
		const start = "config.js#DISCOUNT_RATE";
		const target = "pricing.js#applyDiscount";
		const result = await walk(pooled, repoId, [start], {
			direction: "out",
			types: ["flows_into"],
			maxDepth: 4,
		});
		const hit = result.nodes.find((n) => n.id === target);
		expect(hit).toBeDefined();
		expect(hit?.depth).toBe(1);
		expect(hit?.via).toMatchObject({ from: start, type: "flows_into" });
	});

	test("walk respects maxNodes and sets truncated", async () => {
		const result = await walk(pooled, repoId, [titleCase], {
			direction: "in",
			maxDepth: 6,
			maxNodes: 2,
		});
		expect(result.nodes.length).toBeLessThanOrEqual(2);
		expect(result.truncated).toBe(true);
	});

	test('findByName("titleCase") ranks utils/string.js#titleCase first', async () => {
		const matches = await findByName(pooled, repoId, "titleCase");
		expect(matches.length).toBeGreaterThan(0);
		expect(matches[0]!.id).toBe(titleCase);
	});

	test("queries are deterministic across three calls", async () => {
		const run = async () => ({
			dep: await dependents(pooled, repoId, titleCase, { types: ["calls"] }),
			walkOut: await walk(pooled, repoId, ["config.js#DISCOUNT_RATE"], {
				direction: "out",
				maxDepth: 2,
			}),
			names: await findByName(pooled, repoId, "titleCase", { limit: 5 }),
		});
		const a = JSON.stringify(await run());
		const b = JSON.stringify(await run());
		const c = JSON.stringify(await run());
		expect(a).toBe(b);
		expect(b).toBe(c);
	});
});
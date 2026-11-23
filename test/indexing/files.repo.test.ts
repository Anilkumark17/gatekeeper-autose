import "dotenv/config";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import * as schema from "../../src/db/schema.js";
import type { DiscoveryResult } from "../../src/modules/indexing/discover.js";
import { saveDiscovery } from "../../src/modules/indexing/files.repo.js";

const url = process.env.TEST_DATABASE_URL;
const { files, repos } = schema;

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

describe.skipIf(!url)("saveDiscovery (Neon test branch)", () => {
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const db = drizzle(pool, { schema });
  const repoId = randomUUID();

  beforeAll(async () => {
    await db.insert(repos).values({ id: repoId, root: "/tmp/x", name: `test-${repoId.slice(0, 8)}` });
  });

  afterAll(async () => {
    await db.delete(files).where(eq(files.repoId, repoId));
    await db.delete(repos).where(eq(repos.id, repoId));
    await pool.end();
  });

  test("first save inserts indexed and skipped files", async () => {
    const r = await saveDiscovery(db, repoId, result(["src/a.js", "src/b.js"], [{ path: "public/v.min.js", reason: "minified" }]));
    expect(r).toMatchObject({ upserted: 3, deleted: 0 });

    const rows = await db.select().from(files).where(eq(files.repoId, repoId));
    expect(rows).toHaveLength(3);
    expect(rows.find((x) => x.path === "public/v.min.js")).toMatchObject({ skipped: true, error: "minified" });
  });

  test("re-save keeps content_hash set by the extractor", async () => {
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
  });

  test("removed files are deleted and graph_version is bumped", async () => {
    const [before] = await db.select().from(repos).where(eq(repos.id, repoId));
    const r = await saveDiscovery(db, repoId, result(["src/a.js"]));
    const [after] = await db.select().from(repos).where(eq(repos.id, repoId));

    expect(r.deleted).toBe(2);
    expect(Number(after?.graphVersion)).toBe(Number(before?.graphVersion) + 1);
    const rows = await db.select().from(files).where(eq(files.repoId, repoId));
    expect(rows.map((x) => x.path)).toEqual(["src/a.js"]);
  });
});
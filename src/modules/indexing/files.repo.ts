import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../../db/schema.js";
import type { DiscoveryResult } from "./discover.js";

type Db = NodePgDatabase<typeof schema>;
const { files, repos } = schema;

const CHUNK = 1000;

export interface SaveDiscoveryResult {
  upserted: number;
  deleted: number;
  ms: number;
}

export async function saveDiscovery(db: Db, repoId: string, result: DiscoveryResult): Promise<SaveDiscoveryResult> {
  const t0 = performance.now();
  const now = new Date();

  const rows = [
    ...result.files.map((f) => ({
      repoId,
      path: f.path,
      pkg: f.pkg,
      size: f.size,
      skipped: false,
      error: null,
      indexedAt: now,
    })),
    ...result.skipped.map((s) => ({
      repoId,
      path: s.path,
      pkg: null,
      size: s.size ?? 0,
      skipped: true,
      error: s.reason,
      indexedAt: now,
    })),
  ];

  return db.transaction(async (tx) => {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await tx
        .insert(files)
        .values(rows.slice(i, i + CHUNK))
        .onConflictDoUpdate({
          target: [files.repoId, files.path],
          set: {
            pkg: sql`excluded.pkg`,
            size: sql`excluded.size`,
            skipped: sql`excluded.skipped`,
            error: sql`excluded.error`,
            indexedAt: sql`excluded.indexed_at`,
          },
        });
    }

    const keep = new Set(rows.map((r) => r.path));
    const existing = await tx.select({ path: files.path }).from(files).where(eq(files.repoId, repoId));
    const stale = existing.map((r) => r.path).filter((p) => !keep.has(p));

    for (let i = 0; i < stale.length; i += CHUNK) {
      await tx
        .delete(files)
        .where(and(eq(files.repoId, repoId), inArray(files.path, stale.slice(i, i + CHUNK))));
    }

    if (stale.length > 0) {
      await tx
        .update(repos)
        .set({ graphVersion: sql`${repos.graphVersion} + 1` })
        .where(eq(repos.id, repoId));
    }

    return { upserted: rows.length, deleted: stale.length, ms: Math.round(performance.now() - t0) };
  });
}
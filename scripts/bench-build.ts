import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { eq } from "drizzle-orm";
import pg from "pg";
import { createDb } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { buildFull } from "../src/modules/indexing/build/build-full.js";
import { discover } from "../src/modules/indexing/discover.js";

function parseArgs(argv: string[]): { repoRoot?: string; repoId?: string; cleanup: boolean } {
	let repoRoot: string | undefined;
	let repoId: string | undefined;
	let cleanup = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--cleanup") {
			cleanup = true;
			continue;
		}
		if (arg === "--repo-id") {
			const next = argv[i + 1];
			if (next && !next.startsWith("-")) repoId = next;
			i++;
			continue;
		}
		if (arg && !arg.startsWith("-")) repoRoot = arg;
	}
	return { repoRoot, repoId, cleanup };
}

function hostnameFromUrl(url: string): string {
	try {
		return new URL(url.replace(/^postgresql:\/\//, "http://")).hostname;
	} catch {
		return "unknown";
	}
}

async function pingDatabase(url: string): Promise<void> {
	const host = hostnameFromUrl(url);
	const probe = new pg.Pool({
		connectionString: url,
		max: 1,
		connectionTimeoutMillis: 10_000,
	});
	try {
		await probe.query("select 1");
	} catch (err) {
		const code =
			err &&
			typeof err === "object" &&
			"code" in err &&
			typeof (err as { code: unknown }).code === "string"
				? (err as { code: string }).code
				: "error";
		console.error(`DB unreachable: ${code} ${host}`);
		process.exit(1);
	} finally {
		await probe.end();
	}
}

const { repoRoot, repoId: repoIdFlag, cleanup } = parseArgs(process.argv.slice(2));

if (!repoRoot) {
	console.error("usage: bench-build <repo-root> [--repo-id <uuid>] [--cleanup]");
	process.exit(1);
}

const pooled = process.env.DATABASE_URL;
const direct = process.env.DATABASE_URL_DIRECT;
if (!pooled || !direct) {
	console.error("DATABASE_URL and DATABASE_URL_DIRECT required");
	process.exit(1);
}

await pingDatabase(pooled);

const resolvedRoot = path.resolve(repoRoot);
const { db, pool, direct: directPool } = createDb(pooled, direct);
const name = path.basename(resolvedRoot);

let repoId = repoIdFlag;
if (!repoId) {
	const [existing] = await db
		.select({ id: schema.repos.id })
		.from(schema.repos)
		.where(eq(schema.repos.root, resolvedRoot));
	repoId = existing?.id ?? randomUUID();
}

await db
	.insert(schema.repos)
	.values({ id: repoId, root: resolvedRoot, name })
	.onConflictDoNothing();

const discoveryMode = await discover(resolvedRoot);
const stats = await buildFull(resolvedRoot, repoId, { db, pool, direct: directPool });

const filesIndexed = stats.counts.files;
console.log(
	JSON.stringify({
		repoId,
		discoveryMode: discoveryMode.mode,
		walkReason: discoveryMode.walkReason ?? null,
		filesIndexed,
		nodes: stats.counts.nodes,
		edges: stats.counts.edges,
		graphHash: stats.graphHash,
		discoverMs: stats.discoverMs,
		extractMs: stats.extractMs,
		resolveMs: stats.resolveMs,
		edgesMs: stats.edgesMs,
		recencyMs: stats.recencyMs,
		recencyStatus: stats.recency.status,
		recencyFiles: stats.recency.files,
		recencyBoundaryPct: stats.recency.boundaryPct ?? null,
		copyMs: stats.copyMs,
		swapMs: stats.swapMs,
		totalMs: stats.totalMs,
	}),
);

if (cleanup) {
	const { edges, nodes, searchDocs, files, fileRecency, repos } = schema;
	await db.delete(fileRecency).where(eq(fileRecency.repoId, repoId));
	await db.delete(edges).where(eq(edges.repoId, repoId));
	await db.delete(nodes).where(eq(nodes.repoId, repoId));
	await db.delete(searchDocs).where(eq(searchDocs.repoId, repoId));
	await db.delete(files).where(eq(files.repoId, repoId));
	await db.delete(repos).where(eq(repos.id, repoId));
}

await pool.end();
await directPool.end();

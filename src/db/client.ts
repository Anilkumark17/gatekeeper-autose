import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

const { Pool } = pg;

export function createDb(pooledUrl: string, directUrl: string) {
	const pool = new Pool({
		connectionString: pooledUrl,
		max: 10,
		statement_timeout: 5000,
	});
	const direct = new Pool({ connectionString: directUrl, max: 4 });
	const db = drizzle(pool, { schema });
	return { db, pool, direct };
}

export type DbBundle = ReturnType<typeof createDb>;

let bundle: DbBundle | null = null;

export function initDb(pooledUrl: string, directUrl: string): DbBundle {
	bundle = createDb(pooledUrl, directUrl);
	return bundle;
}

export function getDb(): DbBundle {
	if (!bundle) {
		throw new Error("Database not initialized");
	}
	return bundle;
}

export async function closeDb(): Promise<void> {
	if (!bundle) {
		return;
	}
	await bundle.pool.end();
	await bundle.direct.end();
	bundle = null;
}

import { sql } from "drizzle-orm";
import type { DbBundle } from "../../db/client.js";

export type DbPingResult = {
	ok: boolean;
	ms: number;
};

export async function pingDatabase(dbBundle: DbBundle): Promise<DbPingResult> {
	const started = performance.now();
	try {
		await dbBundle.db.execute(sql`select 1`);
		return { ok: true, ms: Math.round(performance.now() - started) };
	} catch {
		return { ok: false, ms: Math.round(performance.now() - started) };
	}
}

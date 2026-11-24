import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL_DIRECT;
if (!url) {
	console.error("Set DATABASE_URL_DIRECT (or MIGRATE_DATABASE_URL) in .env");
	process.exit(1);
}

const host = (() => {
	try {
		return new URL(url.replace(/^postgresql:\/\//, "http://")).hostname;
	} catch {
		return "";
	}
})();
if (host.includes("-pooler")) {
	console.warn(
		"Warning: migration URL uses the Neon pooler (-pooler). Use the direct host for migrations (same ep name without -pooler).",
	);
}

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");

const pool = new pg.Pool({
	connectionString: url,
	max: 1,
	connectionTimeoutMillis: 20_000,
});

const db = drizzle(pool);

try {
	console.log("Applying migrations from", migrationsFolder);
	await migrate(db, { migrationsFolder });
	console.log("Migrations complete.");
} catch (err) {
	console.error("Migration failed:");
	console.error(err);
	process.exitCode = 1;
} finally {
	await pool.end();
}

if (process.exitCode === 1) {
	process.exit(1);
}
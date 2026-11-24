import "dotenv/config";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
	console.error("TEST_DATABASE_URL is not set in .env");
	process.exit(1);
}

const runMigrations = path.join(path.dirname(fileURLToPath(import.meta.url)), "run-migrations.ts");
const child = spawnSync(process.execPath, ["--import", "tsx", runMigrations], {
	stdio: "inherit",
	env: { ...process.env, MIGRATE_DATABASE_URL: testUrl },
});

if (child.status !== 0) {
	process.exit(child.status ?? 1);
}
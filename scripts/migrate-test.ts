import "dotenv/config";
import { execSync } from "node:child_process";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) {
	console.error("TEST_DATABASE_URL is not set in .env");
	process.exit(1);
}

execSync("drizzle-kit migrate", {
	stdio: "inherit",
	env: { ...process.env, DATABASE_URL_DIRECT: testUrl },
});
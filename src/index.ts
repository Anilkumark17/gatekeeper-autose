import { createApp } from "./app.js";
import { type Env, loadConfig } from "./config/env.js";
import { ConfigError } from "./core/errors.js";
import { createLogger } from "./core/logger.js";
import { closeDb, initDb } from "./db/client.js";
import { pingDatabase } from "./modules/health/db-ping.js";

async function main(): Promise<void> {
	let config: Env;
	try {
		config = loadConfig();
	} catch (err) {
		if (err instanceof ConfigError) {
			console.error(err.message);
			process.exit(1);
		}
		throw err;
	}

	const logger = createLogger({
		level: config.LOG_LEVEL,
		pretty: config.NODE_ENV === "development",
	});

	const db = initDb(config.DATABASE_URL, config.DATABASE_URL_DIRECT);
	const startupDb = await pingDatabase(db);
	logger.info(startupDb, "Database startup check");

	const app = createApp({ logger, db });
	const server = app.listen(config.PORT, () => {
		logger.info({ port: config.PORT }, "Server listening");
	});

	async function shutdown(signal: string) {
		logger.info({ signal }, "Shutting down");
		server.close(async () => {
			await closeDb();
			process.exit(0);
		});
	}

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

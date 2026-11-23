import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import type { Logger } from "pino";
import { pinoHttp } from "pino-http";
import type { DbBundle } from "./db/client.js";
import { createHealthRouter } from "./modules/health/routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type AppDeps = {
	logger: Logger;
	db: DbBundle;
};

export function createApp(deps: AppDeps): express.Express {
	const app = express();

	app.use(pinoHttp({ logger: deps.logger }));
	app.use(express.json({ limit: "1mb" }));
	app.use(express.urlencoded({ extended: true }));

	const publicDir = path.join(__dirname, "public");
	app.use(express.static(publicDir));

	app.use("/health", createHealthRouter(deps.db));

	app.use((_req, res) => {
		res.status(404).json({ error: "Not found" });
	});

	app.use(
		(err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
			deps.logger.error({ err }, "Unhandled error");
			res.status(500).json({ error: "Internal server error" });
		},
	);

	return app;
}

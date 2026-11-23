import { Router } from "express";
import type { DbBundle } from "../../db/client.js";
import { pingDatabase } from "./db-ping.js";

const bootedAt = Date.now();

export function createHealthRouter(dbBundle: DbBundle): Router {
	const router = Router();

	router.get("/", (_req, res) => {
		const uptimeS = Math.floor((Date.now() - bootedAt) / 1000);
		res.json({ ok: true, uptimeS });
	});

	router.get("/db", async (_req, res) => {
		const result = await pingDatabase(dbBundle);
		res.status(result.ok ? 200 : 503).json(result);
	});

	return router;
}

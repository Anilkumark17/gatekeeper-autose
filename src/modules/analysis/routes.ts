import { Router } from "express";
import { detectSmells } from "../indexing/smells.js";
import { analyzeBodySchema } from "./schema.js";

export function createAnalysisRouter(): Router {
	const router = Router();

	router.post("/analyze", async (req, res) => {
		const parsed = analyzeBodySchema.safeParse(req.body);
		if (!parsed.success) {
			res.status(400).json({ error: "Invalid request body", details: parsed.error.flatten() });
			return;
		}

		const { source, language } = parsed.data;
		res.json(detectSmells(source, language));
	});

	return router;
}

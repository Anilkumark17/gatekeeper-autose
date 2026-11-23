import { z } from "zod";

export const analyzeBodySchema = z.object({
	source: z.string().min(1).max(500_000),
	language: z.enum(["javascript", "typescript", "tsx"]).default("javascript"),
});

export type AnalyzeBody = z.infer<typeof analyzeBodySchema>;

import { z } from "zod";

export const evidenceSchema = z.object({
	path: z.string().min(1),
	line: z.number().int().positive(),
});
export type Evidence = z.infer<typeof evidenceSchema>;

export const problemTypeSchema = z.enum(["wrong_output", "crash", "ui", "build", "perf"]);
export type ProblemType = z.infer<typeof problemTypeSchema>;

export const confidenceSchema = z.enum(["low", "med", "high"]);
export type Confidence = z.infer<typeof confidenceSchema>;

export const contractSchema = z.object({
	id: z.string().min(1),
	type: z.enum(["requirement", "contract", "assumption"]),
	text: z.string(),
	attachedTo: z.string().min(1),
	source: z.enum(["doc", "test", "code", "agent", "user"]),
	status: z.enum(["declared", "verified", "violated", "unmapped"]),
});
export type Contract = z.infer<typeof contractSchema>;

export const intentSchema = z.object({
	version: z.literal(1),
	route: z.enum(["rule", "llm"]),
	problemType: problemTypeSchema,
	observed: z.string(),
	expected: z.string().nullable(),
	keyPhrases: z.array(z.string()).max(8),
	files: z.array(z.string()),
	symbols: z.array(z.string()),
	frames: z.array(evidenceSchema),
	confidence: confidenceSchema,
});
export type Intent = z.infer<typeof intentSchema>;

export const rankFeaturesSchema = z.object({
	textRank: z.number().nullable(),
	vectorRank: z.number().nullable(),
	pathCost: z.number(),
	recencyDays: z.number().nullable(),
	contractsCrossed: z.number().int(),
	contractViolated: z.boolean(),
});
export type RankFeatures = z.infer<typeof rankFeaturesSchema>;

export const packNodeSchema = z.object({
	id: z.string().min(1),
	kind: z.string().min(1),
	path: z.string().min(1),
	lines: z.tuple([z.number().int(), z.number().int()]),
	summary: z.string().nullable(),
	code: z.string(),
	lastChangeSha: z.string().nullable(),
	score: z.number(),
	features: rankFeaturesSchema,
	why: z.string(),
});
export type PackNode = z.infer<typeof packNodeSchema>;

export const packEdgeSchema = z.object({
	src: z.string().min(1),
	dst: z.string().min(1),
	type: z.string().min(1),
	evidence: evidenceSchema,
});
export type PackEdge = z.infer<typeof packEdgeSchema>;

export const contextPackSchema = z.object({
	version: z.literal(1),
	intent: intentSchema,
	nodes: z.array(packNodeSchema).max(40),
	edges: z.array(packEdgeSchema),
	contracts: z.array(contractSchema),
	gaps: z.array(z.string()),
	budget: z.object({
		used: z.number().int().nonnegative(),
		max: z.number().int().positive(),
	}),
});
export type ContextPack = z.infer<typeof contextPackSchema>;

export const probeRevertSchema = z.object({
	type: z.literal("revert"),
	sha: z.string().min(1),
});
export const probePatchSchema = z.object({
	type: z.literal("patch"),
	diff: z.string(),
});
export const probeAssertSchema = z.object({
	type: z.literal("assert"),
	test: z.string().min(1),
});
export const probeSchema = z.discriminatedUnion("type", [
	probeRevertSchema,
	probePatchSchema,
	probeAssertSchema,
]);
export type Probe = z.infer<typeof probeSchema>;

export const hypothesisSchema = z.object({
	rank: z.number().int().min(1).max(3),
	nodeId: z.string().min(1),
	contractId: z.string().nullable(),
	cause: z.string(),
	mechanism: z.string(),
	evidence: z
		.array(
			z.object({
				kind: z.enum(["edge", "test", "contract", "change"]),
				ref: z.string().min(1),
			}),
		)
		.min(2),
	probe: probeSchema,
	confidence: confidenceSchema,
});
export type Hypothesis = z.infer<typeof hypothesisSchema>;

export const hypothesesSchema = z.object({
	version: z.literal(1),
	items: z.array(hypothesisSchema).min(1).max(3),
});
export type Hypotheses = z.infer<typeof hypothesesSchema>;

export const probeResultSchema = z.object({
	version: z.literal(1),
	hypothesisRank: z.number().int().nullable(),
	probeType: z.enum(["revert", "patch", "assert", "fix"]),
	applied: z.boolean(),
	testsRun: z.array(z.string()),
	failedBefore: z.array(z.string()),
	failedAfter: z.array(z.string()),
	verdict: z.enum(["verified", "rejected", "inconclusive", "error"]),
	ms: z.number().nonnegative(),
});
export type ProbeResult = z.infer<typeof probeResultSchema>;

export const suggestionSchema = z.object({
	version: z.literal(1),
	requestId: z.uuid(),
	status: z.enum(["verified_fix", "verified_cause_only", "no_verified_cause"]),
	cause: hypothesisSchema.nullable(),
	diff: z.string().nullable(),
	blastRadius: z.array(z.string()),
	verification: probeResultSchema.nullable(),
	rejected: z.array(
		z.object({
			rank: z.number().int(),
			nodeId: z.string(),
			verdict: z.string(),
		}),
	),
});
export type Suggestion = z.infer<typeof suggestionSchema>;

export const diagnoseRequestSchema = z.object({
	report: z.string().min(5).max(4000),
	failingTest: z.string().optional(),
});
export type DiagnoseRequest = z.infer<typeof diagnoseRequestSchema>;

import "dotenv/config";
import { z } from "zod";
import { ConfigError } from "../core/errors.js";

const envSchema = z.object({
	NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
	PORT: z.coerce.number().int().positive().default(3000),
	LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
	DATABASE_URL: z.string().min(1),
	DATABASE_URL_DIRECT: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

export function loadConfig(): Env {
	const result = envSchema.safeParse(process.env);
	if (!result.success) {
		const lines = result.error.issues.map(
			(issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`,
		);
		throw new ConfigError(`Invalid environment configuration:\n${lines.join("\n")}`);
	}
	return result.data;
}

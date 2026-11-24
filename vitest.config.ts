import { defineConfig } from "vitest/config";

const argv = process.argv.map((arg) => arg.replace(/\\/g, "/"));
const perfRun = argv.some((arg) => arg.startsWith("test/perf"));
const dbRun =
	process.env.VITEST_DB === "1" || argv.some((arg) => arg.includes(".repo.test.ts"));

export default defineConfig({
	test: {
		globals: false,
		environment: "node",
		include: perfRun ? ["test/perf/**/*.perf.test.ts"] : ["test/**/*.test.ts"],
		exclude: perfRun
			? ["**/node_modules/**"]
			: dbRun
				? ["**/node_modules/**", "test/perf/**"]
				: ["**/node_modules/**", "test/perf/**", "**/*.repo.test.ts"],
		fileParallelism: perfRun || dbRun ? false : undefined,
	},
});

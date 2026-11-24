import { defineConfig } from "vitest/config";

const argv = process.argv.map((arg) => arg.replace(/\\/g, "/"));
const perfRun = argv.some((arg) => arg.startsWith("test/perf"));
const dbRun =
	process.env.VITEST_DB === "1" ||
	argv.some((arg) => arg.includes(".repo.test.ts") || arg.includes(".db.test.ts"));

export default defineConfig({
	test: {
		globals: false,
		environment: "node",
		include: perfRun ? ["test/perf/**/*.perf.test.ts"] : ["test/**/*.test.ts", "src/**/*.test.ts"],
		exclude: perfRun
			? ["**/node_modules/**"]
			: dbRun
				? ["**/node_modules/**", "test/perf/**"]
				: ["**/node_modules/**", "test/perf/**", "**/*.repo.test.ts", "**/*.db.test.ts"],
		// See docs/DECISIONS.md — parallel file workers + tree-sitter crash on Windows.
		fileParallelism: false,
	},
});

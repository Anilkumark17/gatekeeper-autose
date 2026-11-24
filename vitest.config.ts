import { defineConfig } from "vitest/config";

const perfRun = process.argv.some((arg) => arg.replace(/\\/g, "/").startsWith("test/perf"));

export default defineConfig({
	test: {
		globals: false,
		environment: "node",
		include: perfRun ? ["test/perf/**/*.perf.test.ts"] : ["test/**/*.test.ts"],
		exclude: perfRun ? ["**/node_modules/**"] : ["**/node_modules/**", "test/perf/**"],
		fileParallelism: perfRun ? false : undefined,
	},
});

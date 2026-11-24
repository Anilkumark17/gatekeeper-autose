import path from "node:path";
import ts from "typescript";

const cache = new Map<string, ts.CompilerOptions>();

const defaults = (): ts.CompilerOptions => ({
	allowJs: true,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	resolveJsonModule: true,
});

export function loadCompilerOptions(repoRoot: string, tsconfigPath: string | null): ts.CompilerOptions {
	const key = tsconfigPath ?? "";
	const hit = cache.get(key);
	if (hit) return hit;

	if (!tsconfigPath) {
		const opts = defaults();
		cache.set(key, opts);
		return opts;
	}

	const abs = path.join(repoRoot, ...tsconfigPath.split("/"));
	const read = ts.readConfigFile(abs, ts.sys.readFile);
	if (read.error) {
		const opts = defaults();
		cache.set(key, opts);
		return opts;
	}

	const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(abs));
	const opts: ts.CompilerOptions = {
		...parsed.options,
		allowJs: true,
		resolveJsonModule: true,
	};
	if (opts.moduleResolution === undefined) {
		opts.moduleResolution = ts.ModuleResolutionKind.Bundler;
	}
	cache.set(key, opts);
	return opts;
}

export function clearTsconfigLoaderCacheForTests(): void {
	cache.clear();
}
import { realpathSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { toRepoPath } from "../../../core/ids.js";
import type { DiscoveryResult } from "../discover.js";
import type { RawImport } from "../imports.js";
import { loadCompilerOptions } from "./tsconfig-loader.js";
import {
	isWorkspaceSpecifier,
	packageNameFromSpecifier,
	readWorkspacePackages,
	resolveWorkspaceImport,
} from "./workspace.js";

export type ResolvedTarget =
	| { kind: "file"; path: string }
	| { kind: "types"; path: string }
	| { kind: "external"; pkg: string }
	| { kind: "asset"; specifier: string }
	| {
			kind: "unresolved";
			reason: "not_found" | "non_literal" | "skipped_target" | "outside_repo" | "workspace_unresolved";
	  };

export interface ResolvedImport {
	from: string;
	line: number;
	specifier: string | null;
	importKind: string;
	typeOnly: boolean;
	target: ResolvedTarget;
}

export interface ResolveStats {
	byKind: Record<ResolvedTarget["kind"] | "unresolved", number>;
	byUnresolvedReason: Record<string, number>;
	unresolvedSpecifiers: { specifier: string; count: number }[];
	workspaceUnresolvedSpecifiers: { specifier: string; count: number }[];
	totalMs: number;
	workspacePackages: number;
	workspaceAsExternal: number;
}

const ASSET_EXT =
	/\.(css|scss|sass|less|svg|png|jpg|jpeg|gif|webp|ico|avif|woff2?|ttf|eot|json|md|mdx)(\?.*)?$/i;
const DECLARATION_FILE = /\.d\.(ts|mts|cts)$/i;

function isDeclarationRepoPath(repoPath: string): boolean {
	return DECLARATION_FILE.test(repoPath.split("/").pop() ?? repoPath);
}

function isAssetSpecifier(specifier: string): boolean {
	const base = specifier.split("?")[0] ?? specifier;
	return ASSET_EXT.test(base);
}

function repoRelPath(repoRoot: string, abs: string): string | null {
	try {
		return toRepoPath(repoRoot, abs);
	} catch {
		return null;
	}
}

export interface ImportResolver {
	resolve(fromPath: string, imp: RawImport): ResolvedImport;
	stats(): ResolveStats;
}

export function createResolver(repoRoot: string, discovery: DiscoveryResult): ImportResolver {
	const normalizedRoot = path.resolve(repoRoot);
	const fileSet = new Set(discovery.files.map((f) => f.path));
	const byPath = new Map(discovery.files.map((f) => [f.path, f] as const));
	const workspace = readWorkspacePackages(normalizedRoot, discovery.packages);

	const optionsByTsconfig = new Map<string, ts.CompilerOptions>();
	const resolutionCacheByTsconfig = new Map<string, ts.ModuleResolutionCache>();
	const memo = new Map<string, ResolvedTarget>();

	const getCanonicalFileName = (f: string) =>
		ts.sys.useCaseSensitiveFileNames ? f : f.toLowerCase();

	const host: ts.ModuleResolutionHost = {
		fileExists: ts.sys.fileExists,
		readFile: ts.sys.readFile,
		directoryExists: ts.sys.directoryExists,
		getCurrentDirectory: () => normalizedRoot,
		getDirectories: ts.sys.getDirectories,
		realpath: (p) => {
			try {
				return realpathSync.native(p);
			} catch {
				return p;
			}
		},
	};

	let totalMs = 0;
	const byKind: Record<string, number> = { file: 0, external: 0, asset: 0, unresolved: 0, types: 0 };
	const byUnresolvedReason: Record<string, number> = {};
	const unresolvedSpecCounts = new Map<string, number>();
	const workspaceUnresolvedSpecCounts = new Map<string, number>();
	let workspaceAsExternal = 0;

	const optionsFor = (tsconfig: string | null): ts.CompilerOptions => {
		const key = tsconfig ?? "";
		let hit = optionsByTsconfig.get(key);
		if (!hit) {
			hit = loadCompilerOptions(normalizedRoot, tsconfig);
			optionsByTsconfig.set(key, hit);
		}
		return hit;
	};

	const resolutionCacheFor = (tsconfig: string | null): ts.ModuleResolutionCache => {
		const key = tsconfig ?? "";
		let hit = resolutionCacheByTsconfig.get(key);
		if (!hit) {
			hit = ts.createModuleResolutionCache(normalizedRoot, getCanonicalFileName);
			resolutionCacheByTsconfig.set(key, hit);
		}
		return hit;
	};

	const recordTarget = (target: ResolvedTarget, specifier: string | null) => {
		if (target.kind === "unresolved") {
			byKind.unresolved = (byKind.unresolved ?? 0) + 1;
			byUnresolvedReason[target.reason] = (byUnresolvedReason[target.reason] ?? 0) + 1;
			if (specifier) {
				if (target.reason === "workspace_unresolved") {
					workspaceUnresolvedSpecCounts.set(
						specifier,
						(workspaceUnresolvedSpecCounts.get(specifier) ?? 0) + 1,
					);
				} else if (target.reason === "not_found" || target.reason === "skipped_target") {
					unresolvedSpecCounts.set(specifier, (unresolvedSpecCounts.get(specifier) ?? 0) + 1);
				}
			}
			return;
		}
		if (
			target.kind === "external" &&
			specifier !== null &&
			isWorkspaceSpecifier(specifier, workspace)
		) {
			workspaceAsExternal++;
		}
		byKind[target.kind] = (byKind[target.kind] ?? 0) + 1;
	};

	const classifyResolvedPath = (resolvedFile: string): ResolvedTarget => {
		const real = (() => {
			try {
				return realpathSync.native(resolvedFile);
			} catch {
				return resolvedFile;
			}
		})();

		const repoPath = repoRelPath(normalizedRoot, real);
		if (!repoPath) return { kind: "unresolved", reason: "outside_repo" };

		if (isDeclarationRepoPath(repoPath)) return { kind: "types", path: repoPath };
		if (fileSet.has(repoPath)) return { kind: "file", path: repoPath };

		if (real.includes(`${path.sep}node_modules${path.sep}`)) {
			return { kind: "unresolved", reason: "not_found" };
		}

		return { kind: "unresolved", reason: "skipped_target" };
	};

	const resolveSpecifier = (
		specifier: string,
		tsconfig: string | null,
		containingFile: string,
	): ResolvedTarget => {
		const memoKey = `${tsconfig ?? ""}|${path.dirname(containingFile)}|${specifier}`;
		const cached = memo.get(memoKey);
		if (cached) return cached;

		const t0 = performance.now();
		const options = optionsFor(tsconfig);
		const resCache = resolutionCacheFor(tsconfig);
		const result = ts.resolveModuleName(specifier, containingFile, options, host, resCache);
		totalMs += performance.now() - t0;

		const fn = result.resolvedModule?.resolvedFileName;
		let target: ResolvedTarget;

		if (isWorkspaceSpecifier(specifier, workspace)) {
			target = resolveWorkspaceImport(normalizedRoot, specifier, workspace, fileSet, fn);
		} else if (result.resolvedModule?.isExternalLibraryImport) {
			target = { kind: "external", pkg: packageNameFromSpecifier(specifier) };
		} else if (fn) {
			if (fn.includes(`${path.sep}node_modules${path.sep}`)) {
				target = { kind: "external", pkg: packageNameFromSpecifier(specifier) };
			} else {
				target = classifyResolvedPath(fn);
			}
		} else if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
			target = { kind: "external", pkg: packageNameFromSpecifier(specifier) };
		} else {
			target = { kind: "unresolved", reason: "not_found" };
		}

		if (target.kind === "external" && isWorkspaceSpecifier(specifier, workspace)) {
			target = resolveWorkspaceImport(normalizedRoot, specifier, workspace, fileSet, fn);
		}

		memo.set(memoKey, target);
		return target;
	};

	return {
		resolve(fromPath: string, imp: RawImport): ResolvedImport {
			const base: ResolvedImport = {
				from: fromPath,
				line: imp.line,
				specifier: imp.specifier,
				importKind: imp.kind,
				typeOnly: imp.typeOnly,
				target: { kind: "unresolved", reason: "not_found" },
			};

			if (imp.specifier === null) {
				const target: ResolvedTarget = { kind: "unresolved", reason: "non_literal" };
				recordTarget(target, imp.specifier);
				return { ...base, target };
			}

			if (isAssetSpecifier(imp.specifier)) {
				const target: ResolvedTarget = { kind: "asset", specifier: imp.specifier };
				recordTarget(target, imp.specifier);
				return { ...base, target };
			}

			const file = byPath.get(fromPath);
			const containingFile = file?.abs ?? path.join(normalizedRoot, ...fromPath.split("/"));
			const tsconfig = file?.tsconfig ?? null;

			const target = resolveSpecifier(imp.specifier, tsconfig, containingFile);
			recordTarget(target, imp.specifier);
			return { ...base, target };
		},

		stats(): ResolveStats {
			const unresolvedSpecifiers = [...unresolvedSpecCounts.entries()]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.slice(0, 20)
				.map(([specifier, count]) => ({ specifier, count }));
			const workspaceUnresolvedSpecifiers = [...workspaceUnresolvedSpecCounts.entries()]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.slice(0, 20)
				.map(([specifier, count]) => ({ specifier, count }));

			return {
				byKind: byKind as ResolveStats["byKind"],
				byUnresolvedReason,
				unresolvedSpecifiers,
				workspaceUnresolvedSpecifiers,
				totalMs: Math.round(totalMs * 1000) / 1000,
				workspacePackages: workspace.size,
				workspaceAsExternal,
			};
		},
	};
}

export function resolutionRate(stats: ResolveStats): number {
	const file = stats.byKind.file ?? 0;
	const types = stats.byKind.types ?? 0;
	const resolved = file + types;
	const notFound = stats.byUnresolvedReason.not_found ?? 0;
	const skipped = stats.byUnresolvedReason.skipped_target ?? 0;
	const workspaceUnresolved = stats.byUnresolvedReason.workspace_unresolved ?? 0;
	const denom = resolved + notFound + skipped + workspaceUnresolved;
	if (denom === 0) return 100;
	return Math.round((resolved / denom) * 10000) / 100;
}
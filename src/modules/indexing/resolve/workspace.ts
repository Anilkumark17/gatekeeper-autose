import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { toRepoPath } from "../../../core/ids.js";
import type { PackageInfo } from "../package-map.js";

export function readWorkspacePackages(repoRoot: string, packages: readonly PackageInfo[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const pkg of packages) {
		const pkgRootAbs = pkg.root === "" ? repoRoot : path.join(repoRoot, ...pkg.root.split("/"));
		const pkgJson = path.join(pkgRootAbs, "package.json");
		try {
			const raw = readFileSync(pkgJson, "utf8");
			const parsed = JSON.parse(raw) as { name?: string };
			if (typeof parsed.name === "string" && parsed.name.length > 0) {
				out.set(parsed.name, pkg.root);
			}
		} catch {
			// ignore unreadable package.json
		}
	}
	return out;
}

export function packageNameFromSpecifier(specifier: string): string {
	if (specifier.startsWith("node:")) return specifier;
	if (specifier.startsWith("@")) {
		const parts = specifier.split("/");
		if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
		return specifier;
	}
	return specifier.split("/")[0] ?? specifier;
}

export function isWorkspaceSpecifier(specifier: string, workspace: ReadonlyMap<string, string>): boolean {
	const pkg = packageNameFromSpecifier(specifier);
	if (workspace.has(pkg)) return true;
	for (const name of workspace.keys()) {
		if (specifier === name || specifier.startsWith(`${name}/`)) return true;
	}
	return false;
}

export type WorkspaceResolveTarget =
	| { kind: "file"; path: string }
	| { kind: "types"; path: string }
	| { kind: "unresolved"; reason: "workspace_unresolved" | "outside_repo" };

const SOURCE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".d.ts", ".d.mts", ".d.cts"] as const;
const BUILD_PARTS = new Set(["dist", "build", "out"]);

const DECLARATION = /\.d\.(ts|mts|cts)$/i;

function isDeclarationPath(repoPath: string): boolean {
	return DECLARATION.test(repoPath.split("/").pop() ?? repoPath);
}

function isBuildRepoPath(repoPath: string): boolean {
	return repoPath.split("/").some((p) => BUILD_PARTS.has(p));
}

function repoRelPath(repoRoot: string, abs: string): string | null {
	try {
		return toRepoPath(repoRoot, abs);
	} catch {
		return null;
	}
}

function realAbs(abs: string): string {
	try {
		return realpathSync.native(abs);
	} catch {
		return abs;
	}
}

function exportEntry(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (!value || typeof value !== "object") return null;
	const o = value as Record<string, unknown>;
	if (typeof o.import === "string") return o.import;
	if (typeof o.types === "string") return o.types;
	if (typeof o.default === "string") return o.default;
	return null;
}

function exportSubpath(exports: unknown, subpath: string): string | null {
	if (!exports || typeof exports !== "object") return null;
	const map = exports as Record<string, unknown>;
	const key = subpath === "" ? "." : `./${subpath}`;
	const entry = map[key];
	const direct = exportEntry(entry);
	if (direct) return direct;
	const star = map["./*"];
	if (typeof star === "string") return star.replace(/\*/g, subpath);
	if (star && typeof star === "object") {
		const pattern = exportEntry(star);
		if (pattern) return pattern.replace(/\*/g, subpath);
	}
	return null;
}

function subpathFromSpecifier(specifier: string, pkgName: string): string {
	if (specifier === pkgName) return "";
	return specifier.slice(pkgName.length + 1);
}

function tryResolveAtDir(dirAbs: string, relPath: string): string | null {
	const normalized = relPath.replace(/\\/g, "/");
	const base = path.join(dirAbs, ...normalized.split("/"));
	if (existsSync(base) && !path.basename(base).includes(".")) {
		for (const ext of SOURCE_EXTS) {
			const candidate = `${base}${ext}`;
			if (existsSync(candidate)) return candidate;
		}
		for (const ext of SOURCE_EXTS) {
			const candidate = path.join(base, `index${ext}`);
			if (existsSync(candidate)) return candidate;
		}
	}
	for (const ext of SOURCE_EXTS) {
		const candidate = `${base}${ext}`;
		if (existsSync(candidate)) return candidate;
	}
	for (const ext of SOURCE_EXTS) {
		const candidate = `${base}/index${ext}`;
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

function readPkgJson(pkgRootAbs: string): {
	source?: string;
	main?: string;
	exports?: unknown;
} | null {
	const pkgPath = path.join(pkgRootAbs, "package.json");
	if (!existsSync(pkgPath)) return null;
	try {
		return JSON.parse(readFileSync(pkgPath, "utf8")) as {
			source?: string;
			main?: string;
			exports?: unknown;
		};
	} catch {
		return null;
	}
}

function entryCandidates(pkg: { source?: string; main?: string; exports?: unknown }, subpath: string): string[] {
	const out: string[] = [];
	if (subpath === "") {
		if (typeof pkg.source === "string") out.push(pkg.source);
		const dot = exportSubpath(pkg.exports, "");
		if (dot) out.push(dot);
		if (typeof pkg.main === "string") out.push(pkg.main);
		out.push(
			"src/index.ts",
			"src/index.tsx",
			"src/index.js",
			"src/index.jsx",
			"index.ts",
			"index.tsx",
			"index.js",
			"index.jsx",
		);
	} else {
		const mapped = exportSubpath(pkg.exports, subpath);
		if (mapped) out.push(mapped);
		out.push(subpath, `src/${subpath}`);
	}
	return out;
}

function classifyAbs(
	repoRoot: string,
	abs: string,
	fileSet: ReadonlySet<string>,
): WorkspaceResolveTarget {
	const repoPath = repoRelPath(repoRoot, realAbs(abs));
	if (!repoPath) return { kind: "unresolved", reason: "outside_repo" };
	if (isDeclarationPath(repoPath)) return { kind: "types", path: repoPath };
	if (fileSet.has(repoPath)) return { kind: "file", path: repoPath };
	if (isBuildRepoPath(repoPath)) return { kind: "unresolved", reason: "workspace_unresolved" };
	return { kind: "unresolved", reason: "workspace_unresolved" };
}

export function resolveWorkspaceImport(
	repoRoot: string,
	specifier: string,
	workspace: ReadonlyMap<string, string>,
	fileSet: ReadonlySet<string>,
	tsResolvedFile: string | undefined,
): WorkspaceResolveTarget {
	const pkgName = packageNameFromSpecifier(specifier);
	const pkgRoot = workspace.get(pkgName);
	if (!pkgRoot) return { kind: "unresolved", reason: "workspace_unresolved" };

	if (tsResolvedFile) {
		const fromTs = classifyAbs(repoRoot, tsResolvedFile, fileSet);
		if (fromTs.kind === "file" || fromTs.kind === "types") return fromTs;
	}

	const pkgRootAbs = pkgRoot === "" ? repoRoot : path.join(repoRoot, ...pkgRoot.split("/"));
	const subpath = subpathFromSpecifier(specifier, pkgName);
	const pkg = readPkgJson(pkgRootAbs);
	if (!pkg) return { kind: "unresolved", reason: "workspace_unresolved" };

	for (const rel of entryCandidates(pkg, subpath)) {
		const relPosix = rel.replace(/\\/g, "/");
		const abs = path.normalize(path.join(pkgRootAbs, ...relPosix.split("/")));
		if (existsSync(abs)) {
			const hit = classifyAbs(repoRoot, abs, fileSet);
			if (hit.kind === "file" || hit.kind === "types") return hit;
		}
		const resolved = tryResolveAtDir(pkgRootAbs, relPosix);
		if (resolved) {
			const hit = classifyAbs(repoRoot, resolved, fileSet);
			if (hit.kind === "file" || hit.kind === "types") return hit;
		}
	}

	if (subpath !== "") {
		for (const base of [subpath, `src/${subpath}`]) {
			const resolved = tryResolveAtDir(pkgRootAbs, base);
			if (resolved) {
				const hit = classifyAbs(repoRoot, resolved, fileSet);
				if (hit.kind === "file" || hit.kind === "types") return hit;
			}
		}
	}

	return { kind: "unresolved", reason: "workspace_unresolved" };
}
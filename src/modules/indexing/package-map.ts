import { skipReasonByPath } from "./skip.js";

export interface PackageInfo {
  root: string;            // repo-relative POSIX folder, "" = repo root
  tsconfig: string | null; // governing config at or above root
}

export interface FileContext {
  pkg: string;
  tsconfig: string | null;
}

export interface PackageMap {
  packages: PackageInfo[];
  lookup(filePath: string): FileContext;
}

const dirOf = (p: string) => {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
};

const baseName = (p: string) => p.slice(p.lastIndexOf("/") + 1);

function* ancestors(dir: string): Generator<string> {
  let d = dir;
  while (true) {
    yield d;
    if (d === "") return;
    d = dirOf(d);
  }
}

export function buildPackageMap(paths: readonly string[]): PackageMap {
  const packageRoots = new Set<string>();
  const configByDir = new Map<string, string>();

  for (const p of paths) {
    if (skipReasonByPath(p) === "ignored_dir") continue;
    const name = baseName(p);
    const dir = dirOf(p);
    if (name === "package.json") packageRoots.add(dir);
    else if (name === "tsconfig.json") configByDir.set(dir, p);
    else if (name === "jsconfig.json" && !configByDir.has(dir)) configByDir.set(dir, p);
  }

  const cache = new Map<string, FileContext>();

  const contextForDir = (dir: string): FileContext => {
    const hit = cache.get(dir);
    if (hit) return hit;
    let pkg: string | null = null;
    let tsconfig: string | null = null;
    for (const d of ancestors(dir)) {
      if (pkg === null && packageRoots.has(d)) pkg = d;
      if (tsconfig === null) tsconfig = configByDir.get(d) ?? null;
      if (pkg !== null && tsconfig !== null) break;
    }
    const ctx = { pkg: pkg ?? "", tsconfig };
    cache.set(dir, ctx);
    return ctx;
  };

  const packages = [...packageRoots]
    .sort()
    .map((root) => ({ root, tsconfig: contextForDir(root).tsconfig }));

  return {
    packages,
    lookup: (filePath) => contextForDir(dirOf(filePath)),
  };
}
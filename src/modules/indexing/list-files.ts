// Fast; git reads its index, never enters node_modules
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { toRepoPath } from "../../core/ids.js";

const execFileAsync = promisify(execFile);

export interface RepoFileList {
  paths: string[];          // repo-relative POSIX, sorted, unique
  source: "git" | "walk";
}

const WALK_PRUNE = new Set([
  "node_modules", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit",
  "coverage", ".turbo", ".git", ".cache", "vendor",
]);

export async function listRepoFiles(root: string): Promise<RepoFileList> {
  const viaGit = await listWithGit(root);
  if (viaGit) return { paths: viaGit, source: "git" };
  return { paths: await listWithWalk(root), source: "walk" };
}

async function listWithGit(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root, maxBuffer: 256 * 1024 * 1024, windowsHide: true },
    );
    const unique = new Set(
      stdout.split("\0").filter(Boolean).map((p) => p.replace(/\\/g, "/")),
    );
    return [...unique].sort();
  } catch {
    return null; // not a git repo, or git missing
  }
}

async function listWithWalk(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!WALK_PRUNE.has(e.name)) stack.push(abs);
      } else if (e.isFile()) {
        out.push(toRepoPath(root, abs));
      }
    }
  }
  return out.sort();
}
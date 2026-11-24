// Fast; git reads its index, never enters node_modules
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { toRepoPath } from "../../core/ids.js";
import { resolveGitBin } from "./git-bin.js";

const execFileAsync = promisify(execFile);

export type WalkReason = "no_git_binary" | "not_git_top_level";

export interface RepoFileList {
	paths: string[];
	mode: "git" | "walk";
	walkReason?: WalkReason;
	/** Same as `mode` (legacy). */
	source: "git" | "walk";
}

const WALK_PRUNE = new Set([
	"node_modules",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	".svelte-kit",
	"coverage",
	".turbo",
	".git",
	".cache",
	"vendor",
]);

export async function listRepoFiles(root: string): Promise<RepoFileList> {
	const bin = await resolveGitBin();
	if (!bin) {
		const paths = await listWithWalk(root);
		return { paths, mode: "walk", walkReason: "no_git_binary", source: "walk" };
	}
	const viaGit = await listWithGit(root, bin);
	if (viaGit) {
		return { paths: viaGit, mode: "git", source: "git" };
	}
	const paths = await listWithWalk(root);
	return { paths, mode: "walk", walkReason: "not_git_top_level", source: "walk" };
}

async function listWithGit(root: string, gitBin: string): Promise<string[] | null> {
	try {
		const { stdout } = await execFileAsync(
			gitBin,
			["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
			{ cwd: root, maxBuffer: 256 * 1024 * 1024, windowsHide: true },
		);
		const unique = new Set(
			stdout.split("\0").filter(Boolean).map((p) => p.replace(/\\/g, "/")),
		);
		return [...unique].sort();
	} catch {
		return null;
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
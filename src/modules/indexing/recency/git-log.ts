import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveGitBin } from "../git-bin.js";

const execFileAsync = promisify(execFile);

async function gitBin(): Promise<string> {
	const bin = await resolveGitBin();
	if (!bin) throw new Error("git binary not found");
	return bin;
}

const RS = "\x1e";
const US = "\x1f";

export interface ChangeAt {
	sha: string;
	at: Date;
}

export interface FileChangeAt extends ChangeAt {
	/** Commit that introduced this path had at least one parent. */
	hasParents: boolean;
}

export interface CommitRecord extends ChangeAt {
	hasParents: boolean;
}

export interface GitLogResult {
	commits: CommitRecord[];
	fileLastChange: Map<string, FileChangeAt>;
	commitIndex: Map<string, number>;
	ms: number;
}

export interface GitLogOptions {
	maxCommits?: number;
}

function toPosixPath(p: string): string {
	return p.replace(/\\/g, "/");
}

function parseLog(stdout: string): {
	commits: CommitRecord[];
	fileLastChange: Map<string, FileChangeAt>;
} {
	const commits: CommitRecord[] = [];
	const fileLastChange = new Map<string, FileChangeAt>();

	const chunks = stdout.split(RS).filter((c) => c.trim().length > 0);
	for (const chunk of chunks) {
		const nl = chunk.indexOf("\n");
		if (nl < 0) continue;
		const header = chunk.slice(0, nl);
		const body = chunk.slice(nl + 1);
		const parts = header.split(US);
		if (parts.length < 2) continue;
		const sha = parts[0]!.trim();
		const ct = Number(parts[1]!.trim());
		const parentsRaw = (parts[2] ?? "").trim();
		const hasParents = parentsRaw.length > 0;
		if (!sha || !Number.isFinite(ct)) continue;
		const at = new Date(ct * 1000);
		commits.push({ sha, at, hasParents });

		for (const line of body.split("\n")) {
			const filePath = line.trim();
			if (!filePath || filePath.startsWith("\t")) continue;
			const posix = toPosixPath(filePath);
			if (!fileLastChange.has(posix)) {
				fileLastChange.set(posix, { sha, at, hasParents });
			}
		}
	}

	return { commits, fileLastChange };
}

export async function readGitLog(repoRoot: string, opts: GitLogOptions = {}): Promise<GitLogResult> {
	const maxCommits = opts.maxCommits ?? 2000;
	const t0 = performance.now();
	const bin = await gitBin();
	const { stdout } = await execFileAsync(
		bin,
		[
			"log",
			`--format=${RS}%H${US}%ct${US}%P`,
			"--name-only",
			"--no-renames",
			"-n",
			String(maxCommits),
		],
		{ cwd: repoRoot, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
	);
	const { commits, fileLastChange } = parseLog(stdout);
	const commitIndex = new Map<string, number>();
	for (let i = 0; i < commits.length; i++) {
		commitIndex.set(commits[i]!.sha, i);
	}
	return {
		commits,
		fileLastChange,
		commitIndex,
		ms: Math.round(performance.now() - t0),
	};
}

export async function isShallowRepo(repoRoot: string): Promise<boolean> {
	try {
		const bin = await resolveGitBin();
		if (!bin) return false;
		const { stdout } = await execFileAsync(
			bin,
			["rev-parse", "--is-shallow-repository"],
			{ cwd: repoRoot, windowsHide: true },
		);
		return stdout.trim() === "true";
	} catch {
		return false;
	}
}

export async function countCommits(repoRoot: string): Promise<number> {
	try {
		const bin = await resolveGitBin();
		if (!bin) return 0;
		const { stdout } = await execFileAsync(
			bin,
			["rev-list", "--count", "HEAD"],
			{ cwd: repoRoot, windowsHide: true },
		);
		const n = Number(stdout.trim());
		return Number.isFinite(n) ? n : 0;
	} catch {
		return 0;
	}
}
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveGitBin } from "../git-bin.js";
import type { ChangeAt } from "./git-log.js";

const execFileAsync = promisify(execFile);

export interface LineBlame {
	line: number;
	sha: string;
	at: Date;
}

const SHA_HEADER = /^([0-9a-f]{40}|\^[0-9a-f]{40}) \d+ (\d+) \d+/;

function parsePorcelain(stdout: string): Map<number, ChangeAt> {
	const byLine = new Map<number, ChangeAt>();
	let currentSha = "";
	let currentAt = new Date(0);
	let pendingStartLine = 0;
	let pendingCount = 0;

	const flushLines = (lines: string[]): void => {
		for (let i = 0; i < lines.length; i++) {
			const lineNo = pendingStartLine + i;
			const sha = currentSha.startsWith("^") ? currentSha.slice(1) : currentSha;
			if (sha) byLine.set(lineNo, { sha, at: currentAt });
		}
	};

	let codeLines: string[] = [];

	const lines = stdout.split(/\r?\n/);
	for (const line of lines) {
		const header = SHA_HEADER.exec(line);
		if (header) {
			if (codeLines.length > 0) {
				flushLines(codeLines);
				codeLines = [];
			}
			currentSha = header[1]!;
			pendingStartLine = Number(header[2]);
			pendingCount = 0;
			continue;
		}
		if (line.startsWith("committer-time ")) {
			const sec = Number(line.slice("committer-time ".length).trim().split(/\s+/)[0]);
			if (Number.isFinite(sec)) currentAt = new Date(sec * 1000);
			continue;
		}
		if (line.startsWith("\t")) {
			codeLines.push(line.slice(1));
			continue;
		}
		if (line === "" && codeLines.length > 0) {
			flushLines(codeLines);
			codeLines = [];
			continue;
		}
	}
	if (codeLines.length > 0) flushLines(codeLines);

	void pendingCount;
	return byLine;
}

export async function blameFile(
	repoRoot: string,
	repoPath: string,
	timeoutMs: number,
): Promise<Map<number, ChangeAt>> {
	const bin = await resolveGitBin();
	if (!bin) throw new Error("git binary not found");
	const run = execFileAsync(
		bin,
		["blame", "--porcelain", "-w", "--", repoPath],
		{ cwd: repoRoot, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
	);

	const { stdout } = await Promise.race([
		run,
		new Promise<never>((_, reject) => {
			setTimeout(() => reject(new Error("blame_timeout")), timeoutMs);
		}),
	]);
	return parsePorcelain(stdout);
}

export function newestInRange(
	byLine: Map<number, ChangeAt>,
	lineStart: number,
	lineEnd: number,
	commitIndex: Map<string, number>,
): ChangeAt | null {
	let best: ChangeAt | null = null;
	let bestIndex = Number.POSITIVE_INFINITY;
	for (let line = lineStart; line <= lineEnd; line++) {
		const hit = byLine.get(line);
		if (!hit) continue;
		const idx = commitIndex.get(hit.sha) ?? Number.POSITIVE_INFINITY;
		if (idx < bestIndex) {
			bestIndex = idx;
			best = hit;
		}
	}
	return best;
}

export async function mapConcurrent<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]!);
		}
	};
	const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
	await Promise.all(workers);
	return out;
}
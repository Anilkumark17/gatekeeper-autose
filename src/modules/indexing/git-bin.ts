import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const WIN_DEFAULT = "C:\\Program Files\\Git\\cmd\\git.exe";

let cached: string | null | undefined;

async function pathOnPathWorks(): Promise<string | null> {
	try {
		await execFileAsync("git", ["--version"], { windowsHide: true });
	} catch {
		return null;
	}
	if (process.platform === "win32") {
		try {
			const { stdout } = await execFileAsync("where.exe", ["git"], { windowsHide: true });
			const line = stdout
				.split(/\r?\n/)
				.map((s) => s.trim())
				.find((s) => /git\.exe$/i.test(s));
			if (line) return path.resolve(line);
		} catch {
			/* fall through */
		}
		try {
			await access(WIN_DEFAULT);
			return path.resolve(WIN_DEFAULT);
		} catch {
			return null;
		}
	}
	try {
		const { stdout } = await execFileAsync("which", ["git"], { windowsHide: true });
		const bin = stdout.trim();
		return bin ? path.resolve(bin) : null;
	} catch {
		return null;
	}
}

async function windowsDefaultWorks(): Promise<string | null> {
	try {
		await access(WIN_DEFAULT);
		await execFileAsync(WIN_DEFAULT, ["--version"], { windowsHide: true });
		return path.resolve(WIN_DEFAULT);
	} catch {
		return null;
	}
}

export async function resolveGitBin(): Promise<string | null> {
	if (cached !== undefined) return cached;
	const onPath = await pathOnPathWorks();
	if (onPath) {
		cached = onPath;
		return cached;
	}
	if (process.platform === "win32") {
		const win = await windowsDefaultWorks();
		if (win) {
			cached = win;
			return cached;
		}
	}
	cached = null;
	return null;
}

/** Clears cache (tests only). */
export function resetGitBinCacheForTests(): void {
	cached = undefined;
}
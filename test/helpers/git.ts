import { resolveGitBin } from "../../src/modules/indexing/git-bin.js";

export { resolveGitBin };

export async function hasGit(): Promise<boolean> {
	return (await resolveGitBin()) !== null;
}

export function assertGitForTests(): void {
	if (process.env.SKIP_GIT_TESTS === "1") return;
	if (gitTestBin === null) {
		throw new Error("git not found on PATH");
	}
}

export const gitTestBin = await resolveGitBin();
if (!gitTestBin && process.env.SKIP_GIT_TESTS !== "1") {
	throw new Error("git not found on PATH");
}
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { listRepoFiles } from "../../src/modules/indexing/list-files.js";
import { assertGitForTests, gitTestBin, hasGit } from "../helpers/git.js";

async function write(root: string, rel: string, body = "export {};\n") {
	const abs = path.join(root, ...rel.split("/"));
	await mkdir(path.dirname(abs), { recursive: true });
	await writeFile(abs, body);
}

function git(root: string, ...args: string[]) {
	const bin = gitTestBin ?? "git";
	execFileSync(bin, args, { cwd: root, stdio: "ignore", windowsHide: true, env: process.env });
}

describe("listRepoFiles", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "gk-list-"));
		await write(root, "src/main.js");
		await write(root, "src/utils/string.js");
		await write(root, "src/with space/file.ts");
		await write(root, "node_modules/react/index.js");
		await write(root, "dist/main.js");
		await write(root, "README.md", "# x\n");
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	const gitCase = process.env.SKIP_GIT_TESTS === "1" ? test.skip : test;

	gitCase("git repo: respects .gitignore and includes untracked files", async () => {
		assertGitForTests();
		expect(await hasGit()).toBe(true);

		await write(root, ".gitignore", "node_modules\ndist\n");
		git(root, "init", "-q");
		git(root, "add", "src/main.js", ".gitignore");

		const { paths, source, mode } = await listRepoFiles(root);

		expect(source).toBe("git");
		expect(mode).toBe("git");
		expect(paths).toEqual([
			".gitignore",
			"README.md",
			"src/main.js",
			"src/utils/string.js",
			"src/with space/file.ts",
		]);
	});

	test("plain folder: walk prunes ignored folders", async () => {
		const { paths, source } = await listRepoFiles(root);

		expect(source).toBe("walk");
		expect(paths).toEqual([
			"README.md",
			"src/main.js",
			"src/utils/string.js",
			"src/with space/file.ts",
		]);
	});

	test("returns POSIX paths only", async () => {
		const { paths } = await listRepoFiles(root);
		expect(paths.every((p) => !p.includes("\\"))).toBe(true);
	});
});
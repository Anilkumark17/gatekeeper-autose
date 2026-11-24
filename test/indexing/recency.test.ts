import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { discover } from "../../src/modules/indexing/discover.js";
import { extractFile } from "../../src/modules/indexing/extract-file.js";
import type { SymbolFact } from "../../src/modules/indexing/symbols.js";
import { blameSymbols, computeRecency } from "../../src/modules/indexing/recency/recency.js";
import { assertGitForTests, gitTestBin } from "../helpers/git.js";

const execFileAsync = promisify(execFile);

const gitBin = gitTestBin;

const describeGit = process.env.SKIP_GIT_TESTS === "1" ? describe.skip : describe;

let root: string;

async function git(args: string[], env: Record<string, string> = {}): Promise<void> {
	await execFileAsync(gitBin ?? "git", args, {
		cwd: root,
		env: { ...process.env, ...env },
		windowsHide: true,
	});
}

async function writeRel(rel: string, body: string): Promise<void> {
	const abs = path.join(root, ...rel.split("/"));
	await mkdir(path.dirname(abs), { recursive: true });
	await writeFile(abs, body);
}

async function symbolsMap(paths: { path: string; lang: "js" | "ts" }[]): Promise<Map<string, SymbolFact[]>> {
	const m = new Map<string, SymbolFact[]>();
	for (const p of paths) {
		const abs = path.join(root, p.path);
		const source = await readFile(abs, "utf8");
		const facts = extractFile(p.path, source, p.lang);
		m.set(p.path, facts.symbols);
	}
	return m;
}

beforeAll(async () => {
	assertGitForTests();
	root = await mkdtemp(path.join(tmpdir(), "gk-recency-"));
	await git(["init"]);
	await git(["config", "user.email", "t@test.dev"]);
	await git(["config", "user.name", "test"]);
	await writeRel("package.json", "{}");
	await writeRel("tsconfig.json", "{}");
}, 30_000);

afterAll(async () => {
	if (root) await rm(root, { recursive: true, force: true });
}, 30_000);

describeGit("computeRecency", () => {
	test(
		"symbol blame vs file-level on two commits",
		async () => {
			await writeRel(
				"a.ts",
				"export function f() { return 1; }\nexport function g() { return 1; }\n",
			);
			await git(["add", "a.ts"]);
			await git(["commit", "-m", "c1"], {
				GIT_AUTHOR_DATE: "2020-01-01T00:00:00",
				GIT_COMMITTER_DATE: "2020-01-01T00:00:00",
			});
			const { stdout: sha1 } = await execFileAsync(gitBin ?? "git", ["rev-parse", "HEAD"], {
				cwd: root,
				windowsHide: true,
			});
			const commit1 = sha1.trim();

			await writeRel(
				"a.ts",
				"export function f() { return 1; }\nexport function g() { return 2; }\n",
			);
			await git(["add", "a.ts"]);
			await git(["commit", "-m", "c2"], {
				GIT_AUTHOR_DATE: "2020-02-01T00:00:00",
				GIT_COMMITTER_DATE: "2020-02-01T00:00:00",
			});
			const { stdout: sha2 } = await execFileAsync(gitBin ?? "git", ["rev-parse", "HEAD"], {
				cwd: root,
				windowsHide: true,
			});
			const commit2 = sha2.trim();

			const discovery = await discover(root);
			const symbols = await symbolsMap([{ path: "a.ts", lang: "ts" }]);
			const f = symbols.get("a.ts")!.find((s) => s.name === "f")!;
			const g = symbols.get("a.ts")!.find((s) => s.name === "g")!;

			const { byNode: fileLevel } = await computeRecency(root, discovery, symbols, {
				maxCommits: 50,
				recentCommitWindow: 50,
				blame: "none",
			});
			expect(fileLevel.get("a.ts")?.sha).toBe(commit2);

			const { byNode: blameLevel } = await blameSymbols(root, ["a.ts"], symbols, { maxCommits: 50 });
			expect(blameLevel.get(f.id)?.sha).toBe(commit1);
			expect(blameLevel.get(g.id)?.sha).toBe(commit2);
			expect(blameLevel.get(f.id)?.source).toBe("blame");
		},
		30_000,
	);

	test(
		"file unchanged since first commit keeps commit 1",
		async () => {
			const repo = await mkdtemp(path.join(tmpdir(), "gk-recency-old-"));
			const bin = gitBin ?? "git";
			try {
				await writeFile(path.join(repo, "package.json"), "{}");
				await writeFile(path.join(repo, "tsconfig.json"), "{}");
				await execFileAsync(bin, ["init"], { cwd: repo, windowsHide: true });
				await execFileAsync(bin, ["config", "user.email", "t@test.dev"], { cwd: repo, windowsHide: true });
				await execFileAsync(bin, ["config", "user.name", "test"], { cwd: repo, windowsHide: true });
				const abs = path.join(repo, "old.ts");
				await writeFile(abs, "export const x = 1;\n");
				await execFileAsync(bin, ["add", "old.ts"], { cwd: repo, windowsHide: true });
				await execFileAsync(bin, ["commit", "-m", "only"], {
					cwd: repo,
					env: {
						...process.env,
						GIT_AUTHOR_DATE: "2019-06-01T00:00:00",
						GIT_COMMITTER_DATE: "2019-06-01T00:00:00",
					},
					windowsHide: true,
				});
				const { stdout: sha1 } = await execFileAsync(bin, ["rev-parse", "HEAD"], {
					cwd: repo,
					windowsHide: true,
				});
				await writeFile(path.join(repo, "touch.ts"), "export const y = 1;\n");
				await execFileAsync(bin, ["add", "touch.ts"], { cwd: repo, windowsHide: true });
				await execFileAsync(bin, ["commit", "-m", "other"], {
					cwd: repo,
					env: {
						...process.env,
						GIT_AUTHOR_DATE: "2021-01-01T00:00:00",
						GIT_COMMITTER_DATE: "2021-01-01T00:00:00",
					},
					windowsHide: true,
				});

				const discovery = await discover(repo);
				const symbols = new Map<string, SymbolFact[]>();
				for (const f of discovery.files) {
					if (f.path === "old.ts") {
						const src = await readFile(f.abs, "utf8");
						symbols.set(f.path, extractFile(f.path, src, f.lang).symbols);
					}
				}
				const { byNode } = await computeRecency(repo, discovery, symbols);
				expect(byNode.get("old.ts")?.sha).toBe(sha1.trim());
			} finally {
				await rm(repo, { recursive: true, force: true });
			}
		},
		30_000,
	);

	test("untracked file has no recency", async () => {
			const repo = await mkdtemp(path.join(tmpdir(), "gk-recency-untracked-"));
			const bin = gitBin ?? "git";
			try {
				await writeFile(path.join(repo, "package.json"), "{}");
				await writeFile(path.join(repo, "tsconfig.json"), "{}");
				await execFileAsync(bin, ["init"], { cwd: repo, windowsHide: true });
			await writeFile(path.join(repo, "tracked.js"), "export const a = 1;\n");
			await execFileAsync(bin, ["add", "tracked.js"], { cwd: repo, windowsHide: true });
			await execFileAsync(bin, ["config", "user.email", "t@test.dev"], { cwd: repo, windowsHide: true });
			await execFileAsync(bin, ["config", "user.name", "test"], { cwd: repo, windowsHide: true });
			await execFileAsync(bin, ["commit", "-m", "t"], {
				cwd: repo,
				env: {
					...process.env,
					GIT_AUTHOR_DATE: "2020-01-01T00:00:00",
					GIT_COMMITTER_DATE: "2020-01-01T00:00:00",
				},
				windowsHide: true,
			});
			await writeFile(path.join(repo, "new.js"), "export const b = 2;\n");

			const discovery = await discover(repo);
			expect(discovery.files.some((f) => f.path === "new.js")).toBe(true);
			const symbols = new Map<string, SymbolFact[]>();
			const { byNode } = await computeRecency(repo, discovery, symbols);
			expect(byNode.has("new.js")).toBe(false);
		} finally {
			await rm(repo, { recursive: true, force: true });
		}
	});

	test(
		"path with spaces",
		async () => {
			const repo = await mkdtemp(path.join(tmpdir(), "gk-recency-space-"));
			const bin = gitBin ?? "git";
			try {
				await writeFile(path.join(repo, "package.json"), "{}");
				await writeFile(path.join(repo, "tsconfig.json"), "{}");
				await execFileAsync(bin, ["init"], { cwd: repo, windowsHide: true });
				await execFileAsync(bin, ["config", "user.email", "t@test.dev"], { cwd: repo, windowsHide: true });
				await execFileAsync(bin, ["config", "user.name", "test"], { cwd: repo, windowsHide: true });
				const rel = "my dir/a file.js";
				const abs = path.join(repo, "my dir", "a file.js");
				await mkdir(path.dirname(abs), { recursive: true });
				await writeFile(abs, "export function spaced() { return 1; }\n");
				await execFileAsync(bin, ["add", "--", rel], { cwd: repo, windowsHide: true });
				await execFileAsync(bin, ["commit", "-m", "space"], {
					cwd: repo,
					env: {
						...process.env,
						GIT_AUTHOR_DATE: "2020-03-01T00:00:00",
						GIT_COMMITTER_DATE: "2020-03-01T00:00:00",
					},
					windowsHide: true,
				});
				const { stdout: sha } = await execFileAsync(bin, ["rev-parse", "HEAD"], {
					cwd: repo,
					windowsHide: true,
				});
				const discovery = await discover(repo);
				const file = discovery.files.find((f) => f.path === rel);
				expect(file).toBeDefined();
				const symbols = new Map<string, SymbolFact[]>();
				if (file) {
					const src = await readFile(file.abs, "utf8");
					symbols.set(file.path, extractFile(file.path, src, file.lang).symbols);
				}
				const { byNode } = await computeRecency(repo, discovery, symbols);
				expect(byNode.get(rel)?.sha).toBe(sha.trim());
			} finally {
				await rm(repo, { recursive: true, force: true });
			}
		},
		30_000,
	);
});
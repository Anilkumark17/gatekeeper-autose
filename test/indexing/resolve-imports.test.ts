import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { discover } from "../../src/modules/indexing/discover.js";
import { extractFile } from "../../src/modules/indexing/extract-file.js";
import type { RawImport } from "../../src/modules/indexing/imports.js";
import { createExtractPool } from "../../src/modules/indexing/extract-pool.js";
import { createResolver, resolutionRate } from "../../src/modules/indexing/resolve/resolve-imports.js";
import { clearTsconfigLoaderCacheForTests } from "../../src/modules/indexing/resolve/tsconfig-loader.js";
import type { FileFacts } from "../../src/modules/indexing/extract-file.js";

const sampleJsRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "sample-js");

async function writeTree(root: string, files: Record<string, string>) {
	for (const [rel, body] of Object.entries(files)) {
		const abs = path.join(root, ...rel.split("/"));
		await mkdir(path.dirname(abs), { recursive: true });
		await writeFile(abs, body);
	}
}

async function extractDiscovery(root: string) {
	const discovery = await discover(root);
	const pool = createExtractPool({ threads: 2 });
	const tasks = discovery.files.map((f) => ({ path: f.path, abs: f.abs, lang: f.lang }));
	const facts = new Map<string, FileFacts>();
	for await (const row of pool.run(tasks)) {
		if (row.ok) facts.set(row.path, row.facts);
	}
	await pool.destroy();
	return { discovery, facts };
}

function resolveOne(
	root: string,
	discovery: Awaited<ReturnType<typeof discover>>,
	fromPath: string,
	imp: RawImport,
) {
	const resolver = createResolver(root, discovery);
	const r = resolver.resolve(fromPath, imp);
	clearTsconfigLoaderCacheForTests();
	return r;
}

describe("resolve-imports", () => {
	test("sample-js: local imports resolve to discovered files", async () => {
		const { discovery, facts } = await extractDiscovery(sampleJsRoot);
		const resolver = createResolver(sampleJsRoot, discovery);

		const relativeTargets: string[] = [];
		for (const f of discovery.files) {
			const fileFacts = facts.get(f.path);
			expect(fileFacts).toBeDefined();
			for (const imp of fileFacts!.imports) {
				if (!imp.specifier?.startsWith(".")) continue;
				const r = resolver.resolve(f.path, imp);
				expect(r.target.kind, `${f.path}:${imp.line} ${imp.specifier}`).toBe("file");
				if (r.target.kind === "file") relativeTargets.push(r.target.path);
			}
		}
		expect(relativeTargets.length).toBeGreaterThan(0);
		expect(resolutionRate(resolver.stats())).toBe(100);
	});

	test("sample-js: index and extension resolution", async () => {
		const { discovery } = await extractDiscovery(sampleJsRoot);
		const resolver = createResolver(sampleJsRoot, discovery);

		const receipt = "receipt.js";
		const utilsIdx = resolver.resolve(receipt, {
			specifier: "./utils/index.js",
			kind: "static",
			defaultLocal: null,
			namespaceLocal: null,
			names: [],
			typeOnly: false,
			line: 1,
		});
		expect(utilsIdx.target).toEqual({ kind: "file", path: "utils/index.js" });

		const utilsShort = resolver.resolve(receipt, {
			specifier: "./utils",
			kind: "static",
			defaultLocal: null,
			namespaceLocal: null,
			names: [],
			typeOnly: false,
			line: 1,
		});
		expect(utilsShort.target).toEqual({ kind: "file", path: "utils/index.js" });

		const stringUtil = resolver.resolve(receipt, {
			specifier: "./utils/string.js",
			kind: "static",
			defaultLocal: null,
			namespaceLocal: null,
			names: [],
			typeOnly: false,
			line: 1,
		});
		expect(stringUtil.target).toEqual({ kind: "file", path: "utils/string.js" });

		const source = await readFile(path.join(sampleJsRoot, "main.js"), "utf8");
		const mainFacts = extractFile("main.js", source, "js");
		const dynamic = mainFacts.imports.find((i) => i.kind === "dynamic" && i.specifier === "./pricing.js");
		expect(dynamic).toBeDefined();
		const dyn = resolver.resolve("main.js", dynamic!);
		expect(dyn.target).toEqual({ kind: "file", path: "pricing.js" });
	});

	test("non-literal import -> unresolved non_literal", async () => {
		const { discovery } = await extractDiscovery(sampleJsRoot);
		const resolver = createResolver(sampleJsRoot, discovery);
		const r = resolver.resolve("main.js", {
			specifier: null,
			kind: "dynamic",
			defaultLocal: null,
			namespaceLocal: null,
			names: [],
			typeOnly: false,
			line: 1,
		});
		expect(r.target).toEqual({ kind: "unresolved", reason: "non_literal" });
	});

	test("tsconfig paths map @/* to src/*", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "gk-resolve-paths-"));
		try {
			await writeTree(root, {
				"package.json": "{}",
				"tsconfig.json": JSON.stringify({
					compilerOptions: {
						baseUrl: ".",
						paths: { "@/*": ["src/*"] },
					},
				}),
				"src/lib/db.ts": "export const db = 1;\n",
				"src/app.ts": 'import { db } from "@/lib/db";\nexport { db };\n',
			});
			const discovery = await discover(root);
			const r = resolveOne(root, discovery, "src/app.ts", {
				specifier: "@/lib/db",
				kind: "static",
				defaultLocal: null,
				namespaceLocal: null,
				names: [],
				typeOnly: false,
				line: 1,
			});
			expect(r.target).toEqual({ kind: "file", path: "src/lib/db.ts" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("jsconfig baseUrl resolves components/Button", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "gk-resolve-jsconfig-"));
		try {
			await writeTree(root, {
				"package.json": "{}",
				"jsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "." } }),
				"components/Button.jsx": "export function Button() { return null; }\n",
				"app.js": 'import { Button } from "components/Button";\n',
			});
			const discovery = await discover(root);
			const r = resolveOne(root, discovery, "app.js", {
				specifier: "components/Button",
				kind: "static",
				defaultLocal: null,
				namespaceLocal: null,
				names: [],
				typeOnly: false,
				line: 1,
			});
			expect(r.target).toEqual({ kind: "file", path: "components/Button.jsx" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test(".js specifier resolves to .ts source", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "gk-resolve-jsts-"));
		try {
			await writeTree(root, {
				"package.json": "{}",
				"tsconfig.json": "{}",
				"util.ts": "export const v = 1;\n",
				"main.js": 'import { v } from "./util.js";\n',
			});
			const discovery = await discover(root);
			const r = resolveOne(root, discovery, "main.js", {
				specifier: "./util.js",
				kind: "static",
				defaultLocal: null,
				namespaceLocal: null,
				names: [],
				typeOnly: false,
				line: 1,
			});
			expect(r.target).toEqual({ kind: "file", path: "util.ts" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("workspace via node_modules symlink resolves to source, not external", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "gk-resolve-ws-symlink-"));
		try {
			await writeTree(root, {
				"package.json": "{}",
				"apps/web/app.js":
					'import { x } from "@acme/lib";\nimport { d } from "@acme/lib/utils/date";\nexport { x, d };\n',
				"packages/lib/package.json": JSON.stringify({
					name: "@acme/lib",
					main: "dist/index.js",
				}),
				"packages/lib/src/index.ts": "export const x = 1;\n",
				"packages/lib/utils/date.ts": "export const d = 2;\n",
			});
			await mkdir(path.join(root, "node_modules", "@acme"), { recursive: true });
			await symlink(
				path.join(root, "packages", "lib"),
				path.join(root, "node_modules", "@acme", "lib"),
				process.platform === "win32" ? "junction" : "dir",
			);
			const discovery = await discover(root);
			const resolver = createResolver(root, discovery);
			expect(
				resolver.resolve("apps/web/app.js", {
					specifier: "@acme/lib",
					kind: "static",
					defaultLocal: null,
					namespaceLocal: null,
					names: [],
					typeOnly: false,
					line: 1,
				}).target,
			).toEqual({ kind: "file", path: "packages/lib/src/index.ts" });
			expect(
				resolver.resolve("apps/web/app.js", {
					specifier: "@acme/lib/utils/date",
					kind: "static",
					defaultLocal: null,
					namespaceLocal: null,
					names: [],
					typeOnly: false,
					line: 2,
				}).target,
			).toEqual({ kind: "file", path: "packages/lib/utils/date.ts" });
			expect(resolver.stats().workspaceAsExternal).toBe(0);
			expect(resolver.stats().byKind.external ?? 0).toBe(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("workspace package.json exports subpath", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "gk-resolve-ws-exports-"));
		try {
			await writeTree(root, {
				"package.json": "{}",
				"app.js": 'import { f } from "@acme/lib/format";\n',
				"packages/lib/package.json": JSON.stringify({
					name: "@acme/lib",
					exports: { "./format": "./src/format.ts" },
				}),
				"packages/lib/src/format.ts": "export const f = 1;\n",
			});
			const discovery = await discover(root);
			const r = resolveOne(root, discovery, "app.js", {
				specifier: "@acme/lib/format",
				kind: "static",
				defaultLocal: null,
				namespaceLocal: null,
				names: [],
				typeOnly: false,
				line: 1,
			});
			expect(r.target).toEqual({ kind: "file", path: "packages/lib/src/format.ts" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("workspace package maps to package source entry", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "gk-resolve-ws-"));
		try {
			await writeTree(root, {
				"package.json": "{}",
				"apps/web/app.js": 'import { Ui } from "@acme/ui";\nexport { Ui };\n',
				"packages/ui/package.json": JSON.stringify({ name: "@acme/ui", main: "src/index.ts" }),
				"packages/ui/src/index.ts": "export const Ui = 1;\n",
			});
			const discovery = await discover(root);
			const r = resolveOne(root, discovery, "apps/web/app.js", {
				specifier: "@acme/ui",
				kind: "static",
				defaultLocal: null,
				namespaceLocal: null,
				names: [],
				typeOnly: false,
				line: 1,
			});
			expect(r.target).toEqual({ kind: "file", path: "packages/ui/src/index.ts" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("external packages", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "gk-resolve-ext-"));
		try {
			await writeTree(root, {
				"package.json": "{}",
				"app.ts": 'import React from "react";\nimport { x } from "@tanstack/react-query/build";\nimport fs from "node:fs";\n',
			});
			const discovery = await discover(root);
			const resolver = createResolver(root, discovery);
			expect(resolver.resolve("app.ts", {
				specifier: "react",
				kind: "static",
				defaultLocal: "React",
				namespaceLocal: null,
				names: [],
				typeOnly: false,
				line: 1,
			}).target).toEqual({ kind: "external", pkg: "react" });
			expect(resolver.resolve("app.ts", {
				specifier: "@tanstack/react-query/build",
				kind: "static",
				defaultLocal: null,
				namespaceLocal: null,
				names: [{ imported: "x", local: "x", typeOnly: false }],
				typeOnly: false,
				line: 2,
			}).target).toEqual({ kind: "external", pkg: "@tanstack/react-query" });
			expect(resolver.resolve("app.ts", {
				specifier: "node:fs",
				kind: "static",
				defaultLocal: "fs",
				namespaceLocal: null,
				names: [],
				typeOnly: false,
				line: 3,
			}).target).toEqual({ kind: "external", pkg: "node:fs" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test(".d.ts resolution -> types (not skipped_target)", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "gk-resolve-dts-"));
		try {
			await writeTree(root, {
				"package.json": "{}",
				"tsconfig.json": JSON.stringify({ compilerOptions: { allowJs: true } }),
				"src/models.ts": 'import type { User } from "./types";\nexport const u: User = { id: 1 };\n',
				"src/types.d.ts": "export type User = { id: number };\n",
			});
			const discovery = await discover(root);
			const r = resolveOne(root, discovery, "src/models.ts", {
				specifier: "./types",
				kind: "static",
				defaultLocal: null,
				namespaceLocal: null,
				names: [{ imported: "User", local: "User", typeOnly: true }],
				typeOnly: true,
				line: 1,
			});
			expect(r.target).toEqual({ kind: "types", path: "src/types.d.ts" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("asset and missing specifiers", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "gk-resolve-asset-"));
		try {
			await writeTree(root, {
				"package.json": "{}",
				"app.js": 'import "./styles.css";\nimport "./nope";\n',
			});
			const discovery = await discover(root);
			const resolver = createResolver(root, discovery);
			expect(resolver.resolve("app.js", {
				specifier: "./styles.css",
				kind: "side_effect",
				defaultLocal: null,
				namespaceLocal: null,
				names: [],
				typeOnly: false,
				line: 1,
			}).target).toEqual({ kind: "asset", specifier: "./styles.css" });
			expect(resolver.resolve("app.js", {
				specifier: "./nope",
				kind: "static",
				defaultLocal: null,
				namespaceLocal: null,
				names: [],
				typeOnly: false,
				line: 2,
			}).target).toEqual({ kind: "unresolved", reason: "not_found" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
import path from "node:path";
import { inspectHead } from "./inspect-head.js";
import { detectLang, type Lang } from "./lang.js";
import { listRepoFiles } from "./list-files.js";
import { buildPackageMap, type PackageInfo } from "./package-map.js";
import { type SkipReason, skipReasonByPath } from "./skip.js";

export interface DiscoveredFile {
	path: string; // repo-relative POSIX, used in node IDs
	abs: string; // native absolute path, used for disk reads
	lang: Lang;
	size: number;
	pkg: string;
	tsconfig: string | null;
}

export interface SkippedFile {
	path: string;
	reason: Exclude<SkipReason, "not_source">;
	size?: number;
}

export interface DiscoveryResult {
	root: string;
	source: "git" | "walk";
	files: DiscoveredFile[];
	skipped: SkippedFile[];
	packages: PackageInfo[];
	counts: { listed: number; indexed: number; skipped: number; notSource: number };
	ms: number;
}

export interface DiscoverOptions {
	maxBytes?: number;
	concurrency?: number;
}

export async function discover(root: string, opts: DiscoverOptions = {}): Promise<DiscoveryResult> {
	const t0 = performance.now();
	const absRoot = path.resolve(root);

	const { paths, source } = await listRepoFiles(absRoot);
	const pkgMap = buildPackageMap(paths);

	const skipped: SkippedFile[] = [];
	const candidates: { path: string; lang: Lang }[] = [];
	let notSource = 0;

	for (const p of paths) {
		const reason = skipReasonByPath(p);
		if (reason === "not_source") {
			notSource++;
			continue;
		}
		if (reason) {
			skipped.push({ path: p, reason });
			continue;
		}
		const lang = detectLang(p);
		if (!lang) {
			notSource++;
			continue;
		}
		candidates.push({ path: p, lang });
	}

	const inspectOpts = opts.maxBytes === undefined ? {} : { maxBytes: opts.maxBytes };
	const inspected = await mapLimit(candidates, opts.concurrency ?? 64, async (c) => {
		const abs = path.join(absRoot, ...c.path.split("/"));
		try {
			return { ...c, abs, head: await inspectHead(abs, inspectOpts) };
		} catch {
			return { ...c, abs, head: null };
		}
	});

	const files: DiscoveredFile[] = [];
	for (const item of inspected) {
		if (!item.head) {
			skipped.push({ path: item.path, reason: "unreadable" });
			continue;
		}
		if (item.head.reason) {
			skipped.push({
				path: item.path,
				reason: item.head.reason as SkippedFile["reason"],
				size: item.head.size,
			});
			continue;
		}
		const ctx = pkgMap.lookup(item.path);
		files.push({
			path: item.path,
			abs: item.abs,
			lang: item.lang,
			size: item.head.size,
			pkg: ctx.pkg,
			tsconfig: ctx.tsconfig,
		});
	}

	const byPath = (a: { path: string }, b: { path: string }) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
	files.sort(byPath);
	skipped.sort(byPath);

	return {
		root: absRoot,
		source,
		files,
		skipped,
		packages: pkgMap.packages,
		counts: {
			listed: paths.length,
			indexed: files.length,
			skipped: skipped.length,
			notSource,
		},
		ms: Math.round(performance.now() - t0),
	};
}

async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}
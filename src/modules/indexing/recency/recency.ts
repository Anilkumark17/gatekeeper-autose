import type { DiscoveryResult } from "../discover.js";
import type { SymbolFact } from "../symbols.js";
import { blameFile, mapConcurrent, newestInRange } from "./blame.js";
import { countCommits, isShallowRepo, readGitLog, type ChangeAt, type FileChangeAt } from "./git-log.js";

export type RecencySource = "blame" | "file" | "boundary" | "root";

export interface NodeRecency {
	sha: string;
	at: Date;
	source: RecencySource;
}

export interface RecencyStats {
	commitsRead: number;
	filesWithHistory: number;
	filesBoundary: number;
	filesRealHistory: number;
	filesIndexed: number;
	filesWithHistoryPct: number;
	filesBoundaryPct: number;
	filesRealHistoryPct: number;
	blamedFiles: number;
	symbolsWithBlameRecency: number;
	symbolsTotal: number;
	shallowWarning: string | null;
	logMs: number;
	blameMs: number;
	ms: number;
}

export interface RecencyResult {
	byNode: Map<string, NodeRecency>;
	stats: RecencyStats;
	/** For blameSymbols: most recently changed indexed files (newest first). */
	recentFilePaths: string[];
}

export type BlameMode = "none" | "window";

export interface ComputeRecencyOptions {
	maxCommits?: number;
	recentCommitWindow?: number;
	blame?: BlameMode;
	blameConcurrency?: number;
	blameTimeoutMs?: number;
}

export interface BlameSymbolEntry {
	sha: string;
	at: Date;
	source: "blame";
}

export interface BlameSymbolsOptions {
	maxCommits?: number;
	blameConcurrency?: number;
	blameTimeoutMs?: number;
}

function fileSource(change: FileChangeAt, shallow: boolean): RecencySource {
	if (!change.hasParents) {
		return shallow ? "boundary" : "root";
	}
	return "file";
}

function isTreatableAsRecent(
	source: RecencySource,
	sha: string,
	commitIndex: Map<string, number>,
	window: number,
): boolean {
	if (source === "boundary" || source === "root") return false;
	const idx = commitIndex.get(sha);
	return idx !== undefined && idx < window;
}

function pct(part: number, total: number): number {
	return total > 0 ? Math.round((part / total) * 1000) / 10 : 0;
}

function buildStats(
	filesIndexed: number,
	filesWithHistory: number,
	filesBoundary: number,
	rest: Omit<
		RecencyStats,
		"filesWithHistory" | "filesBoundary" | "filesRealHistory" | "filesIndexed" | "filesWithHistoryPct" | "filesBoundaryPct" | "filesRealHistoryPct"
	>,
): RecencyStats {
	const filesRealHistory = filesWithHistory - filesBoundary;
	return {
		filesIndexed,
		filesWithHistory,
		filesBoundary,
		filesRealHistory,
		filesWithHistoryPct: pct(filesWithHistory, filesIndexed),
		filesBoundaryPct: pct(filesBoundary, filesIndexed),
		filesRealHistoryPct: pct(filesRealHistory, filesIndexed),
		...rest,
	};
}

export async function computeRecency(
	repoRoot: string,
	discovery: DiscoveryResult,
	symbolsByFile: ReadonlyMap<string, readonly SymbolFact[]>,
	opts: ComputeRecencyOptions = {},
): Promise<RecencyResult> {
	const t0 = performance.now();
	const maxCommits = opts.maxCommits ?? 2000;
	const recentWindow = opts.recentCommitWindow ?? 200;
	const blameMode = opts.blame ?? "none";
	const blameConcurrency = opts.blameConcurrency ?? 8;
	const blameTimeoutMs = opts.blameTimeoutMs ?? 15_000;

	const byNode = new Map<string, NodeRecency>();
	let shallowWarning: string | null = null;

	const shallow = await isShallowRepo(repoRoot);
	const commitCount = await countCommits(repoRoot);
	if (shallow && commitCount < 50) {
		shallowWarning = `shallow clone with only ${commitCount} commits (history may be incomplete)`;
	}

	const recentFilePaths: string[] = [];

	let symbolsTotal = 0;
	for (const syms of symbolsByFile.values()) symbolsTotal += syms.length;

	let log: Awaited<ReturnType<typeof readGitLog>>;
	try {
		log = await readGitLog(repoRoot, { maxCommits });
	} catch {
		return {
			byNode,
			recentFilePaths,
			stats: buildStats(discovery.files.length, 0, 0, {
				commitsRead: 0,
				blamedFiles: 0,
				symbolsWithBlameRecency: 0,
				symbolsTotal,
				shallowWarning,
				logMs: 0,
				blameMs: 0,
				ms: Math.round(performance.now() - t0),
			}),
		};
	}

	let filesWithHistory = 0;
	let filesBoundary = 0;
	const blameTargets: string[] = [];

	for (const f of discovery.files) {
		const fileChange = log.fileLastChange.get(f.path) ?? null;
		if (!fileChange) continue;

		filesWithHistory++;
		const source = fileSource(fileChange, shallow);
		if (source === "boundary") filesBoundary++;

		const rec: NodeRecency = { sha: fileChange.sha, at: fileChange.at, source };
		byNode.set(f.path, rec);

		const syms = symbolsByFile.get(f.path) ?? [];
		for (const sym of syms) {
			byNode.set(sym.id, { ...rec });
		}

		if (isTreatableAsRecent(source, fileChange.sha, log.commitIndex, recentWindow)) {
			recentFilePaths.push(f.path);
			if (blameMode === "window" && syms.length > 0) blameTargets.push(f.path);
		}
	}

	recentFilePaths.sort((a, b) => {
		const ra = byNode.get(a);
		const rb = byNode.get(b);
		const ia = ra ? (log.commitIndex.get(ra.sha) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
		const ib = rb ? (log.commitIndex.get(rb.sha) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
		return ia - ib;
	});

	const tBlame = performance.now();
	let blamedFiles = 0;
	let symbolsWithBlameRecency = 0;

	if (blameMode === "window") {
		const blamed = await runBlamePass(
			repoRoot,
			blameTargets,
			symbolsByFile,
			log.commitIndex,
			blameConcurrency,
			blameTimeoutMs,
			byNode,
		);
		blamedFiles = blamed.blamedFiles;
		symbolsWithBlameRecency = blamed.symbolsWithBlameRecency;
	}

	const blameMs = Math.round(performance.now() - tBlame);

	return {
		byNode,
		recentFilePaths,
		stats: buildStats(discovery.files.length, filesWithHistory, filesBoundary, {
			commitsRead: log.commits.length,
			blamedFiles,
			symbolsWithBlameRecency,
			symbolsTotal,
			shallowWarning,
			logMs: log.ms,
			blameMs,
			ms: Math.round(performance.now() - t0),
		}),
	};
}

async function runBlamePass(
	repoRoot: string,
	filePaths: readonly string[],
	symbolsByFile: ReadonlyMap<string, readonly SymbolFact[]>,
	commitIndex: Map<string, number>,
	concurrency: number,
	timeoutMs: number,
	into: Map<string, NodeRecency>,
): Promise<{ blamedFiles: number; symbolsWithBlameRecency: number }> {
	let blamedFiles = 0;
	let symbolsWithBlameRecency = 0;

	await mapConcurrent(filePaths, concurrency, async (filePath) => {
		try {
			const byLine = await blameFile(repoRoot, filePath, timeoutMs);
			blamedFiles++;
			const syms = symbolsByFile.get(filePath) ?? [];
			const fileFallback = into.get(filePath);

			for (const sym of syms) {
				const fromBlame = newestInRange(byLine, sym.lineStart, sym.lineEnd, commitIndex);
				const pick = pickSymbolRecency(fromBlame, fileFallback);
				if (!pick) continue;
				into.set(sym.id, pick);
				if (pick.source === "blame") symbolsWithBlameRecency++;
			}
		} catch {
			/* keep file-level inheritance */
		}
	});

	return { blamedFiles, symbolsWithBlameRecency };
}

export async function blameSymbols(
	repoRoot: string,
	filePaths: readonly string[],
	symbolsByFile: ReadonlyMap<string, readonly SymbolFact[]>,
	opts: BlameSymbolsOptions = {},
): Promise<{ byNode: Map<string, BlameSymbolEntry>; ms: number }> {
	const t0 = performance.now();
	const maxCommits = opts.maxCommits ?? 2000;
	const concurrency = opts.blameConcurrency ?? 8;
	const timeoutMs = opts.blameTimeoutMs ?? 15_000;

	const byNode = new Map<string, BlameSymbolEntry>();
	const log = await readGitLog(repoRoot, { maxCommits });

	await mapConcurrent(filePaths, concurrency, async (filePath) => {
		try {
			const byLine = await blameFile(repoRoot, filePath, timeoutMs);
			const syms = symbolsByFile.get(filePath) ?? [];
			for (const sym of syms) {
				const fromBlame = newestInRange(byLine, sym.lineStart, sym.lineEnd, log.commitIndex);
				if (!fromBlame) continue;
				byNode.set(sym.id, {
					sha: fromBlame.sha,
					at: fromBlame.at,
					source: "blame",
				});
			}
		} catch {
			/* skip file */
		}
	});

	return { byNode, ms: Math.round(performance.now() - t0) };
}

function pickSymbolRecency(
	fromBlame: ChangeAt | null,
	fileFallback: NodeRecency | undefined,
): NodeRecency | null {
	if (fromBlame) {
		return { sha: fromBlame.sha, at: fromBlame.at, source: "blame" };
	}
	if (fileFallback) {
		return { ...fileFallback };
	}
	return null;
}
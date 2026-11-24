import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { Piscina } from "piscina";
import type { Lang } from "./lang.js";
import type { FileFacts } from "./extract-file.js";

export interface ExtractTask {
	path: string;
	abs: string;
	lang: Lang;
}

export type ExtractResult =
	| { ok: true; path: string; facts: FileFacts; ms: number }
	| {
			ok: false;
			path: string;
			reason: "extract_error" | "extract_timeout";
			message: string;
			ms: number;
	  };

/** Active submitted-but-unfinished tasks (for bounded-concurrency tests). */
export let extractPoolSubmittedInFlight = 0;

export interface ExtractPool {
	run(tasks: readonly ExtractTask[], onProgress?: (done: number, total: number) => void): AsyncGenerator<ExtractResult>;
	close(): Promise<void>;
	destroy(): Promise<void>;
	threads: number;
}

export interface CreateExtractPoolOptions {
	threads?: number;
	timeoutMs?: number;
	maxInFlight?: number;
	workerFile?: string;
}

function defaultThreads(): number {
	const raw = process.env.INDEX_WORKERS;
	if (raw !== undefined && raw.trim() !== "") {
		const n = Number(raw);
		if (Number.isFinite(n) && n > 0) return Math.floor(n);
	}
	return Math.max(1, availableParallelism() - 1);
}

function workerPathAndExecArgv(workerFile?: string): { filename: string; execArgv: string[] } {
	if (workerFile) {
		const isTs = workerFile.endsWith(".ts");
		return { filename: workerFile, execArgv: isTs ? ["--import", "tsx"] : [] };
	}
	const poolPath = fileURLToPath(import.meta.url);
	const isTs = poolPath.endsWith(".ts");
	const url = new URL(isTs ? "./extract-worker.ts" : "./extract-worker.js", import.meta.url);
	return {
		filename: fileURLToPath(url),
		execArgv: isTs ? ["--import", "tsx"] : [],
	};
}

function waitImmediate(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

export function createExtractPool(opts: CreateExtractPoolOptions = {}): ExtractPool {
	const threads = opts.threads ?? defaultThreads();
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const maxInFlight = opts.maxInFlight ?? threads * 4;
	const { filename, execArgv } = workerPathAndExecArgv(opts.workerFile);

	const pool = new Piscina({
		filename,
		execArgv,
		minThreads: threads,
		maxThreads: threads,
		idleTimeout: 60_000,
	});

	let closed = false;
	let closing = false;
	let openRuns = 0;
	const inFlight = new Set<Promise<ExtractResult>>();

	const assertAcceptingRuns = (): void => {
		if (closed || closing) throw new Error("extract pool destroyed");
	};

	const drainInFlight = async (): Promise<void> => {
		while (inFlight.size > 0) {
			await Promise.allSettled([...inFlight]);
			await waitImmediate();
		}
	};

	const wrapTask = (task: ExtractTask): Promise<ExtractResult> => {
		const work = (async (): Promise<ExtractResult> => {
			const t0 = performance.now();
			const ac = new AbortController();
			const timer = setTimeout(() => ac.abort("extract_timeout"), timeoutMs);
			try {
				const facts = (await pool.run(task, { signal: ac.signal })) as FileFacts;
				return { ok: true, path: task.path, facts, ms: performance.now() - t0 };
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const timedOut =
					ac.signal.aborted ||
					(err instanceof Error && (err.name === "AbortError" || message.includes("aborted")));
				return {
					ok: false,
					path: task.path,
					reason: timedOut ? "extract_timeout" : "extract_error",
					message,
					ms: performance.now() - t0,
				};
			} finally {
				clearTimeout(timer);
			}
		})();
		inFlight.add(work);
		void work.finally(() => {
			inFlight.delete(work);
		});
		return work;
	};

	const close = async (): Promise<void> => {
		if (closed) return;
		closing = true;
		while (openRuns > 0) {
			await drainInFlight();
			await waitImmediate();
		}
		await drainInFlight();
		await pool.destroy();
		closed = true;
	};

	return {
		threads,
		async *run(tasks, onProgress) {
			assertAcceptingRuns();
			openRuns++;
			try {
				const total = tasks.length;
				if (total === 0) {
					onProgress?.(0, 0);
					return;
				}

				let nextIdx = 0;
				let done = 0;
				const pending = new Map<number, Promise<ExtractResult>>();
				let nextId = 0;

				const submit = (): void => {
					if (closing || closed) return;
					while (pending.size < maxInFlight && nextIdx < total) {
						const task = tasks[nextIdx++]!;
						const id = nextId++;
						extractPoolSubmittedInFlight++;
						const promise = wrapTask(task).finally(() => {
							extractPoolSubmittedInFlight--;
						});
						pending.set(id, promise);
					}
				};

				submit();

				while (done < total) {
					if (pending.size === 0) break;
					const raced = await Promise.race(
						[...pending.entries()].map(async ([id, promise]) => ({ id, result: await promise })),
					);
					pending.delete(raced.id);
					done++;
					yield raced.result;
					submit();
					if (onProgress && (done % 100 === 0 || done === total)) onProgress(done, total);
				}

				while (pending.size > 0) {
					const raced = await Promise.race(
						[...pending.entries()].map(async ([id, promise]) => ({ id, result: await promise })),
					);
					pending.delete(raced.id);
				}
			} finally {
				openRuns--;
			}
		},
		close,
		destroy: close,
	};
}
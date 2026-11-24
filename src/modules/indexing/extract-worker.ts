import { readFile } from "node:fs/promises";
import type { Lang } from "./lang.js";
import { extractFile, type FileFacts } from "./extract-file.js";

export default async function extractWorkerTask(task: {
	path: string;
	abs: string;
	lang: Lang;
}): Promise<FileFacts> {
	const source = await readFile(task.abs, "utf8");
	return extractFile(task.path, source, task.lang);
}
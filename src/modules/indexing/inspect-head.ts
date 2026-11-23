import { open, stat } from "node:fs/promises";
import type { SkipReason } from "./skip.js";

export interface HeadInfo {
  size: number;
  reason: SkipReason | null;
}

export interface InspectOptions {
  maxBytes?: number;
  headBytes?: number;
}

const GENERATED = /@generated|do not edit|auto-?generated/i;
const MAX_AVG_LINE = 300;
const MAX_LINE = 2000;

export async function inspectHead(absPath: string, opts: InspectOptions = {}): Promise<HeadInfo> {
  const maxBytes = opts.maxBytes ?? 500 * 1024;
  const headBytes = opts.headBytes ?? 4096;

  const { size } = await stat(absPath);
  if (size > maxBytes) return { size, reason: "too_large" };
  if (size === 0) return { size, reason: null };

  const head = await readHead(absPath, Math.min(headBytes, size));

  if (GENERATED.test(head.slice(0, 512))) return { size, reason: "generated" };
  if (looksMinified(head)) return { size, reason: "minified" };
  return { size, reason: null };
}

async function readHead(absPath: string, bytes: number): Promise<string> {
  const fh = await open(absPath, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await fh.close();
  }
}

export function looksMinified(text: string): boolean {
  const lines = text.split(/\r?\n/);
  let total = 0;
  for (const line of lines) {
    if (line.length > MAX_LINE) return true;
    total += line.length;
  }
  return total / lines.length > MAX_AVG_LINE;
}
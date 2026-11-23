import { detectLang } from "./lang.js";

export type SkipReason =
  | "ignored_dir"
  | "declaration"
  | "minified"
  | "not_source"
  | "too_large"
  | "generated"
  | "unreadable";

const IGNORED_DIRS = new Set([
  "node_modules", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit",
  "coverage", ".turbo", ".git", ".cache", "vendor",
]);

const DECLARATION = /\.d\.(ts|mts|cts)$/i;
const MINIFIED = /\.min\.(js|mjs|cjs)$|\.bundle\./i;

export function skipReasonByPath(path: string): SkipReason | null {
  const parts = path.split(/[\\/]/);
  const fileName = parts.pop() ?? "";

  for (const dir of parts) {
    if (IGNORED_DIRS.has(dir)) return "ignored_dir";
  }
  if (DECLARATION.test(fileName)) return "declaration";
  if (MINIFIED.test(fileName)) return "minified";
  if (detectLang(fileName) === null) return "not_source";
  return null;
}
// this is for the sake of the language detection for the source code


export type Lang = "js" | "jsx" | "ts" | "tsx";

const EXT_TO_LANG: Record<string, Lang> = {
  ".js": "js",
  ".mjs": "js",
  ".cjs": "js",
  ".jsx": "jsx",
  ".ts": "ts",
  ".mts": "ts",
  ".cts": "ts",
  ".tsx": "tsx",
};

export function detectLang(path: string): Lang | null {
  const dot = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (dot <= slash + 1) return null; // no extension, or a dotfile like ".eslintrc"
  return EXT_TO_LANG[path.slice(dot).toLowerCase()] ?? null;
}
import { sha256Hex } from "../../core/ids.js";
import type { Lang } from "./lang.js";
import { extractExports } from "./exports.js";
import { extractImports } from "./imports.js";
import { parseSource } from "./parser.js";
import { extractSymbols, type SymbolFact } from "./symbols.js";
import { tokenize } from "./tokens.js";
import { extractUsages, knownNamesForFile, type RawCall, type RawRef, type RawRender } from "./usages.js";
import type { RawExport } from "./exports.js";
import type { RawImport } from "./imports.js";

export interface FileFacts {
	path: string;
	lang: Lang;
	contentHash: string;
	parse: { hasError: boolean; errorCount: number; ms: number };
	symbols: SymbolFact[];
	imports: RawImport[];
	exports: RawExport[];
	calls: RawCall[];
	refs: RawRef[];
	renders: RawRender[];
	tokens: string[];
}

function namesForTokens(symbols: SymbolFact[], imports: RawImport[], exports: RawExport[]): string[] {
	const names: string[] = [];
	for (const s of symbols) names.push(s.name);
	for (const imp of imports) {
		if (imp.defaultLocal) names.push(imp.defaultLocal);
		if (imp.namespaceLocal) names.push(imp.namespaceLocal);
		for (const n of imp.names) names.push(n.local);
	}
	for (const e of exports) {
		if (e.exported) names.push(e.exported);
		if (e.local) names.push(e.local);
	}
	return names;
}

export function extractFile(path: string, source: string, lang: Lang): FileFacts {
	const parsed = parseSource(source, lang);
	const root = parsed.tree.rootNode;

	const symbols = extractSymbols(root, path);
	const imports = extractImports(root);
	const exports = extractExports(root);
	const known = knownNamesForFile(imports, symbols);
	const { calls, refs, renders } = extractUsages(root, symbols, known, path);

	return {
		path,
		lang,
		contentHash: sha256Hex(source),
		parse: { hasError: parsed.hasError, errorCount: parsed.errorCount, ms: parsed.ms },
		symbols,
		imports,
		exports,
		calls,
		refs,
		renders,
		tokens: tokenize(namesForTokens(symbols, imports, exports)),
	};
}
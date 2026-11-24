import Parser from "tree-sitter";
import { sha256Hex } from "../../core/ids.js";
import type { Lang } from "./lang.js";
import type { RawExport } from "./exports.js";
import { extractExports } from "./exports.js";
import type { RawImport } from "./imports.js";
import { extractImports } from "./imports.js";
import { GRAMMARS, walk } from "./parser.js";
import { extractSymbols, type SymbolFact } from "./symbols.js";
import { tokenize } from "./tokens.js";
import {
	extractUsages,
	knownNamesForFile,
	type RawCall,
	type RawRef,
	type RawNewLocal,
	type RawRender,
	type RawScopeParams,
} from "./usages.js";

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
	newLocals: RawNewLocal[];
	scopeParams: RawScopeParams[];
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

function countErrors(root: Parser.SyntaxNode): number {
	let errorCount = 0;
	walk(root, (node) => {
		if (node.isError || node.isMissing) errorCount++;
		return node.hasError;
	});
	return errorCount;
}

const extractParsers = new Map<Lang, Parser>();

function getExtractParser(lang: Lang): Parser {
	let parser = extractParsers.get(lang);
	if (!parser) {
		parser = new Parser();
		parser.setLanguage(GRAMMARS[lang] as Parser.Language);
		extractParsers.set(lang, parser);
	}
	return parser;
}

/** Dedicated parser pool (not parseSource cache); reset before each parse. */
function parseFresh(
	source: string,
	lang: Lang,
): { tree: Parser.Tree; hasError: boolean; errorCount: number; ms: number } {
	const t0 = performance.now();
	const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
	const bufferSize = Math.max(32 * 1024, text.length * 2 + 1);
	const parser = getExtractParser(lang);
	parser.reset();
	const tree = parser.parse(text, undefined, { bufferSize });
	const hasError = tree.rootNode.hasError;
	const errorCount = hasError ? countErrors(tree.rootNode) : 0;
	return { tree, hasError, errorCount, ms: Math.round(performance.now() - t0) };
}

export function extractFile(path: string, source: string, lang: Lang): FileFacts {
	const { tree, hasError, errorCount, ms } = parseFresh(source, lang);
	const root = tree.rootNode;
	const symbols = extractSymbols(root, path);
	const exports = extractExports(root);
	const known = knownNamesForFile(extractImports(root), symbols);
	const { calls, refs, renders, dynamicImports, newLocals, scopeParams } = extractUsages(
		root,
		symbols,
		known,
		path,
	);
	const imports = extractImports(root, dynamicImports);

	return {
		path,
		lang,
		contentHash: sha256Hex(source),
		parse: { hasError, errorCount, ms },
		symbols,
		imports,
		exports,
		calls,
		refs,
		renders,
		newLocals,
		scopeParams,
		tokens: tokenize(namesForTokens(symbols, imports, exports)),
	};
}
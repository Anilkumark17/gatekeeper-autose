import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import type { Lang } from "./lang.js";

const TS = TypeScript as { typescript: unknown; tsx: unknown };

export const GRAMMARS: Record<Lang, unknown> = {
	js: JavaScript,
	jsx: JavaScript,
	ts: TS.typescript,
	tsx: TS.tsx,
};

const parsers = new Map<Lang, Parser>();

export function getParser(lang: Lang): Parser {
	let parser = parsers.get(lang);
	if (!parser) {
		parser = new Parser();
		parser.setLanguage(GRAMMARS[lang] as Parser.Language);
		parsers.set(lang, parser);
	}
	return parser;
}

export interface ParseResult {
	tree: Parser.Tree;
	hasError: boolean;
	errorCount: number;
	ms: number;
}

export type LineRange = {
	start: number;
	end: number;
};

function cursorNode(cursor: Parser.TreeCursor): Parser.SyntaxNode {
	const current = cursor.currentNode as Parser.SyntaxNode | (() => Parser.SyntaxNode);
	return typeof current === "function" ? current() : current;
}

export function walk(root: Parser.SyntaxNode, visit: (node: Parser.SyntaxNode) => boolean): void {
	const cursor = root.walk();

	while (true) {
		const descend = visit(cursorNode(cursor));
		if (descend && cursor.gotoFirstChild()) {
			continue;
		}
		while (!cursor.gotoNextSibling()) {
			if (!cursor.gotoParent()) {
				return;
			}
		}
	}
}

function countErrors(root: Parser.SyntaxNode): number {
	let errorCount = 0;
	walk(root, (node) => {
		if (node.isError || node.isMissing) {
			errorCount++;
		}
		return node.hasError;
	});
	return errorCount;
}

export function lines(node: Parser.SyntaxNode): LineRange {
	return {
		start: node.startPosition.row + 1,
		end: node.endPosition.row + 1,
	};
}

export function parseSource(source: string, lang: Lang): ParseResult {
	const t0 = performance.now();
	const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
	const bufferSize = Math.max(32 * 1024, text.length * 2 + 1);
	const tree = getParser(lang).parse(text, undefined, { bufferSize });
	const hasError = tree.rootNode.hasError;
	const errorCount = hasError ? countErrors(tree.rootNode) : 0;
	return {
		tree,
		hasError,
		errorCount,
		ms: Math.round(performance.now() - t0),
	};
}
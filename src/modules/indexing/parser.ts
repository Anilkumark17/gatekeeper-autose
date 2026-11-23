import Parser from "tree-sitter";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import type { SupportedLanguage } from "../../core/types.js";

const TS = TypeScript.typescript as unknown as Parser.Language;
const TSX = TypeScript.tsx as unknown as Parser.Language;
const JS = JavaScript as unknown as Parser.Language;

const languageMap: Record<SupportedLanguage, Parser.Language> = {
	javascript: JS,
	typescript: TS,
	tsx: TSX,
};

const parsers = new Map<SupportedLanguage, Parser>();

function getParser(language: SupportedLanguage): Parser {
	let parser = parsers.get(language);
	if (!parser) {
		parser = new Parser();
		parser.setLanguage(languageMap[language]);
		parsers.set(language, parser);
	}
	return parser;
}

export function parseSource(source: string, language: SupportedLanguage): Parser.Tree {
	return getParser(language).parse(source);
}

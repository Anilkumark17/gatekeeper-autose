import type { SyntaxNode } from "tree-sitter";
import type { Lang } from "./lang.js";
import { parseSource, walk } from "./parser.js";

export type CodeSmell = {
	type: string;
	message: string;
	line: number;
	column: number;
};

export type SmellReport = {
	language: Lang;
	smells: CodeSmell[];
	parseErrors: string[];
};

function collectSmells(root: SyntaxNode): CodeSmell[] {
	const smells: CodeSmell[] = [];
	walk(root, (node) => {
		if (node.type === "debugger_statement") {
			smells.push({
				type: "debugger_statement",
				message: "Debugger statement should not be committed to source.",
				line: node.startPosition.row + 1,
				column: node.startPosition.column + 1,
			});
		}
		if (node.type === "empty_statement") {
			smells.push({
				type: "empty_statement",
				message: "Stray empty statement (often a double semicolon).",
				line: node.startPosition.row + 1,
				column: node.startPosition.column + 1,
			});
		}
		return true;
	});
	return smells;
}

export function detectSmells(source: string, language: Lang): SmellReport {
	const parseErrors: string[] = [];
	let smells: CodeSmell[] = [];

	try {
		const parsed = parseSource(source, language);
		if (parsed.hasError) {
			parseErrors.push("Source contains syntax errors (partial AST).");
		}
		smells = collectSmells(parsed.tree.rootNode);
	} catch (err) {
		parseErrors.push(err instanceof Error ? err.message : "Failed to parse source.");
	}

	return { language, smells, parseErrors };
}
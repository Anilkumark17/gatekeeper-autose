import type { SyntaxNode } from "tree-sitter";
import type { SupportedLanguage } from "../../core/types.js";
import { parseSource } from "./parser.js";

export type CodeSmell = {
	type: string;
	message: string;
	line: number;
	column: number;
};

export type SmellReport = {
	language: SupportedLanguage;
	smells: CodeSmell[];
	parseErrors: string[];
};

function collectSmells(root: SyntaxNode): CodeSmell[] {
	const smells: CodeSmell[] = [];
	const stack: SyntaxNode[] = [root];

	while (stack.length > 0) {
		const node = stack.pop();
		if (!node) {
			continue;
		}

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

		for (let i = node.namedChildCount - 1; i >= 0; i--) {
			const child = node.namedChild(i);
			if (child) {
				stack.push(child);
			}
		}
	}

	return smells;
}

export function detectSmells(source: string, language: SupportedLanguage): SmellReport {
	const parseErrors: string[] = [];
	let smells: CodeSmell[] = [];

	try {
		const tree = parseSource(source, language);
		if (tree.rootNode.hasError) {
			parseErrors.push("Source contains syntax errors (partial AST).");
		}
		smells = collectSmells(tree.rootNode);
	} catch (err) {
		parseErrors.push(err instanceof Error ? err.message : "Failed to parse source.");
	}

	return { language, smells, parseErrors };
}

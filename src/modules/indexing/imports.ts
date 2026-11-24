import type Parser from "tree-sitter";
import { lines } from "./parser.js";

type Node = Parser.SyntaxNode;

export interface ImportedName {
	imported: string;
	local: string;
	typeOnly: boolean;
}

export interface RawImport {
	specifier: string | null;
	kind: "static" | "side_effect" | "require" | "dynamic";
	defaultLocal: string | null;
	namespaceLocal: string | null;
	names: ImportedName[];
	typeOnly: boolean;
	line: number;
}

function literal(node: Node | null | undefined): string | null {
	if (!node) return null;
	if (node.type === "string") return node.text.slice(1, -1);
	if (node.type === "template_string" && !node.namedChildren.some((c) => c.type === "template_substitution")) {
		return node.text.slice(1, -1);
	}
	return null;
}

function hasToken(node: Node, token: string): boolean {
	return node.children.some((c) => c.type === token);
}

function fromStatic(stmt: Node): RawImport | null {
	const source = stmt.childForFieldName("source");
	const specifier = literal(source);
	if (specifier === null) return null;

	const imp: RawImport = {
		specifier,
		kind: "static",
		defaultLocal: null,
		namespaceLocal: null,
		names: [],
		typeOnly: hasToken(stmt, "type"),
		line: lines(stmt).start,
	};

	const clause = stmt.namedChildren.find((c) => c.type === "import_clause");
	if (!clause) {
		imp.kind = "side_effect";
		return imp;
	}

	for (const part of clause.namedChildren) {
		if (part.type === "identifier") {
			imp.defaultLocal = part.text;
		} else if (part.type === "namespace_import") {
			imp.namespaceLocal = part.namedChildren.find((c) => c.type === "identifier")?.text ?? null;
		} else if (part.type === "named_imports") {
			for (const spec of part.namedChildren) {
				if (spec.type !== "import_specifier") continue;
				const imported = spec.childForFieldName("name")?.text;
				if (!imported) continue;
				const local = spec.childForFieldName("alias")?.text ?? imported;
				imp.names.push({ imported, local, typeOnly: imp.typeOnly || hasToken(spec, "type") });
			}
		}
	}
	return imp;
}

function bindRequire(call: Node, imp: RawImport): void {
	const declarator = call.parent;
	if (declarator?.type !== "variable_declarator") return;
	const target = declarator.childForFieldName("name");
	if (!target) return;
	if (target.type === "identifier") {
		imp.namespaceLocal = target.text;
	} else if (target.type === "object_pattern") {
		for (const p of target.namedChildren) {
			if (p.type === "shorthand_property_identifier_pattern") {
				imp.names.push({ imported: p.text, local: p.text, typeOnly: false });
			} else if (p.type === "pair_pattern") {
				const key = p.childForFieldName("key")?.text;
				const value = p.childForFieldName("value");
				if (key && value?.type === "identifier") imp.names.push({ imported: key, local: value.text, typeOnly: false });
			}
		}
	}
}

/** Record dynamic `import()` / `require()` from a call_expression node (usages walk). */
export function recordCallSiteImport(call: Node, knownNames: Set<string> | null): RawImport | null {
	const fn = call.childForFieldName("function");
	const firstArg = call.childForFieldName("arguments")?.namedChildren[0];
	const base = {
		defaultLocal: null,
		namespaceLocal: null,
		names: [] as ImportedName[],
		typeOnly: false,
		line: lines(call).start,
	};

	if (fn?.type === "import") {
		return { ...base, specifier: literal(firstArg), kind: "dynamic" };
	}
	if (fn?.type === "identifier" && fn.text === "require" && firstArg) {
		const imp: RawImport = { ...base, specifier: literal(firstArg), kind: "require" };
		bindRequire(call, imp);
		if (knownNames) {
			if (imp.namespaceLocal) knownNames.add(imp.namespaceLocal);
			for (const n of imp.names) knownNames.add(n.local);
		}
		return imp;
	}
	return null;
}

/** Top-level `import` statements only (no full-tree walk). */
export function collectStaticImports(root: Node): RawImport[] {
	const out: RawImport[] = [];
	for (const stmt of root.namedChildren) {
		if (stmt.type === "import_statement") {
			const imp = fromStatic(stmt);
			if (imp) out.push(imp);
		}
	}
	return out;
}

export function extractImports(root: Node, dynamic: readonly RawImport[] = []): RawImport[] {
	return [...collectStaticImports(root), ...dynamic].sort((a, b) => a.line - b.line);
}
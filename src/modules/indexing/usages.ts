import type Parser from "tree-sitter";
import type { NodeId } from "../../core/ids.js";
import { fileId } from "../../core/ids.js";
import { lines, walk } from "./parser.js";
import type { SymbolFact } from "./symbols.js";

type Node = Parser.SyntaxNode;

const SKIP = new Set(["string", "template_string", "comment", "regex"]);

const LITERALS = new Set([
	"string",
	"number",
	"true",
	"false",
	"null",
	"undefined",
	"regex",
	"template_string",
]);
const FN_NODES = new Set([
	"arrow_function",
	"function_expression",
	"function",
	"generator_function",
]);

export type CalleeKind = "name" | "member" | "this" | "super" | "other";

export interface RawArg {
	index: number;
	kind: "identifier" | "member" | "literal" | "function" | "spread" | "other";
	text: string | null;
}

export interface RawCall {
	fromId: NodeId;
	callee: {
		kind: CalleeKind;
		name: string | null;
		chain: string | null;
	};
	args: RawArg[];
	line: number;
	isNew: boolean;
}

export interface RawRef {
	fromId: NodeId;
	name: string;
	role: "argument" | "value";
	line: number;
}

export interface RawRender {
	fromId: NodeId;
	component: string;
	props: string[];
	line: number;
}

const PASCAL = /^[A-Z]/;
const stripWs = (s: string) => s.replace(/\s+/g, "");

function enclosingFromId(symbols: SymbolFact[], index: number, moduleId: NodeId): NodeId {
	let best: SymbolFact | null = null;
	let bestSpan = Number.POSITIVE_INFINITY;
	for (const s of symbols) {
		if (s.startIndex > index || index >= s.endIndex) continue;
		const span = s.endIndex - s.startIndex;
		if (span < bestSpan) {
			bestSpan = span;
			best = s;
		}
	}
	return best ? (best.id as NodeId) : moduleId;
}

function rightmostProperty(member: Node): string | null {
	let cur: Node | null = member;
	while (cur?.type === "member_expression") {
		const prop = cur.childForFieldName("property");
		if (prop?.type === "property_identifier" || prop?.type === "identifier") return prop.text;
		cur = cur.childForFieldName("object") ?? null;
	}
	return null;
}

function parseMemberCallee(member: Node): { kind: CalleeKind; name: string | null; chain: string | null } {
	const chain = stripWs(member.text);
	const name = rightmostProperty(member) ?? null;
	const root = member.childForFieldName("object");
	if (root?.type === "this") return { kind: "this", name, chain };
	if (root?.type === "super") return { kind: "super", name, chain };
	return { kind: "member", name, chain };
}

function parseCallee(fn: Node | null): { kind: CalleeKind; name: string | null; chain: string | null } {
	if (!fn) return { kind: "other", name: null, chain: null };
	if (fn.type === "identifier") return { kind: "name", name: fn.text, chain: null };
	if (fn.type === "member_expression") return parseMemberCallee(fn);
	return { kind: "other", name: null, chain: null };
}

function isImportOrRequireCall(node: Node): boolean {
	if (node.type !== "call_expression") return false;
	const fn = node.childForFieldName("function");
	if (fn?.type === "import") return true;
	return fn?.type === "identifier" && fn.text === "require";
}

function classifyArg(arg: Node, index: number): RawArg {
	if (arg.type === "spread_element") return { index, kind: "spread", text: null };
	if (arg.type === "identifier") return { index, kind: "identifier", text: arg.text };
	if (arg.type === "member_expression") return { index, kind: "member", text: stripWs(arg.text) };
	if (FN_NODES.has(arg.type)) return { index, kind: "function", text: null };
	if (LITERALS.has(arg.type)) {
		const text = arg.text.length <= 80 ? arg.text : null;
		return { index, kind: "literal", text };
	}
	return { index, kind: "other", text: null };
}

function parseArgs(call: Node): RawArg[] {
	const argsNode = call.childForFieldName("arguments");
	if (!argsNode) return [];
	return argsNode.namedChildren.map((arg, i) => classifyArg(arg, i));
}

function isCalleeIdentifier(node: Node): boolean {
	const parent = node.parent;
	if (!parent) return false;
	if (parent.type === "call_expression" && parent.childForFieldName("function") === node) return true;
	if (parent.type === "new_expression" && parent.childForFieldName("constructor") === node) return true;
	return false;
}

function isDeclarationBinding(node: Node): boolean {
	const parent = node.parent;
	if (!parent) return false;

	if (parent.type === "variable_declarator" && parent.childForFieldName("name") === node) return true;
	if (parent.type === "import_specifier" && parent.childForFieldName("name") === node) return true;
	if (parent.type === "function_declaration" && parent.childForFieldName("name") === node) return true;
	if (parent.type === "class_declaration" && parent.childForFieldName("name") === node) return true;
	if (parent.type === "method_definition") {
		const n = parent.childForFieldName("name") ?? parent.childForFieldName("property");
		if (n === node) return true;
	}
	if (parent.type === "field_definition" || parent.type === "public_field_definition") {
		const n = parent.childForFieldName("property") ?? parent.childForFieldName("name");
		if (n === node) return true;
	}
	if (parent.type === "member_expression" && parent.childForFieldName("property") === node) return true;
	if (parent.type === "pair" && parent.childForFieldName("key") === node) return true;
	if (parent.type === "jsx_attribute") {
		const name = parent.namedChildren[0];
		if (name === node) return true;
	}
	return false;
}

function refRole(node: Node): "argument" | "value" {
	const parent = node.parent;
	if (parent?.type === "arguments" && parent.parent?.type === "call_expression") {
		if (parent.namedChildren.includes(node)) return "argument";
	}
	return "value";
}

function jsxComponentName(nameNode: Node | null): string | null {
	if (!nameNode) return null;
	if (nameNode.type === "identifier") {
		return PASCAL.test(nameNode.text) ? nameNode.text : null;
	}
	if (nameNode.type === "member_expression") {
		return stripWs(nameNode.text);
	}
	return null;
}

function jsxProps(el: Node): string[] {
	const props: string[] = [];
	for (const child of el.namedChildren) {
		if (child.type === "jsx_attribute") {
			const id = child.namedChildren.find((c) => c.type === "property_identifier" || c.type === "jsx_name");
			if (id) props.push(id.text);
		} else if (child.type === "jsx_expression") {
			if (child.namedChildren.some((c) => c.type === "spread_element")) props.push("...");
		} else if (child.type === "jsx_spread_attribute") {
			props.push("...");
		}
	}
	return props;
}

export function extractUsages(
	root: Node,
	symbols: SymbolFact[],
	knownNames: Set<string>,
	filePath: string,
): { calls: RawCall[]; refs: RawRef[]; renders: RawRender[] } {
	const moduleId = fileId(filePath);
	const calls: RawCall[] = [];
	const refSeen = new Map<string, RawRef>();
	const renders: RawRender[] = [];

	walk(root, (node) => {
		if (SKIP.has(node.type)) return false;

		if (node.type === "call_expression" && !isImportOrRequireCall(node)) {
			const fromId = enclosingFromId(symbols, node.startIndex, moduleId);
			const fn = node.childForFieldName("function");
			calls.push({
				fromId,
				callee: parseCallee(fn),
				args: parseArgs(node),
				line: lines(node).start,
				isNew: false,
			});
		}

		if (node.type === "new_expression") {
			const fromId = enclosingFromId(symbols, node.startIndex, moduleId);
			const ctor = node.childForFieldName("constructor");
			calls.push({
				fromId,
				callee: parseCallee(ctor),
				args: parseArgs(node),
				line: lines(node).start,
				isNew: true,
			});
		}

		if (node.type === "identifier" && knownNames.has(node.text)) {
			if (!isCalleeIdentifier(node) && !isDeclarationBinding(node)) {
				const fromId = enclosingFromId(symbols, node.startIndex, moduleId);
				const role = refRole(node);
				const key = `${fromId}|${node.text}|${role}`;
				if (!refSeen.has(key)) {
					refSeen.set(key, { fromId, name: node.text, role, line: lines(node).start });
				}
			}
		}

		if (node.type === "jsx_opening_element" || node.type === "jsx_self_closing_element") {
			const component = jsxComponentName(node.childForFieldName("name"));
			if (component) {
				const fromId = enclosingFromId(symbols, node.startIndex, moduleId);
				renders.push({
					fromId,
					component,
					props: jsxProps(node),
					line: lines(node).start,
				});
			}
		}

		return true;
	});

	return { calls, refs: [...refSeen.values()], renders };
}

/** Test helper: mirror extractFile known-name set. */
export function knownNamesForFile(
	imports: { defaultLocal: string | null; namespaceLocal: string | null; names: { local: string }[] }[],
	symbols: SymbolFact[],
): Set<string> {
	const names = new Set<string>();
	for (const imp of imports) {
		if (imp.defaultLocal) names.add(imp.defaultLocal);
		if (imp.namespaceLocal) names.add(imp.namespaceLocal);
		for (const n of imp.names) names.add(n.local);
	}
	for (const s of symbols) {
		if (!s.qualifiedName.includes(".")) names.add(s.name);
	}
	return names;
}
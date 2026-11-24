import type Parser from "tree-sitter";
import type { NodeId } from "../../core/ids.js";
import { fileId } from "../../core/ids.js";
import { walk } from "./parser.js";
import type { RawImport } from "./imports.js";
import { recordCallSiteImport } from "./imports.js";
import type { SymbolFact } from "./symbols.js";

type Node = Parser.SyntaxNode;

/** tree-sitter may return distinct wrapper objects for the same span; never use `===` on SyntaxNode. */
function sameNode(a: Node, b: Node): boolean {
	return a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;
}

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
const FUNCTION_DECLS = new Set(["function_declaration", "generator_function_declaration"]);

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
		optional?: boolean;
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

export interface RawNewLocal {
	fromId: NodeId;
	local: string;
	className: string;
	line: number;
}

export interface RawScopeParams {
	fromId: NodeId;
	names: string[];
	types: Record<string, string>;
}

const PASCAL = /^[A-Z]/;

function memberStepOptional(node: Node): boolean {
	return node.namedChildren.some((c) => c.type === "optional_chain");
}

function memberChainMeta(node: Node): { chain: string; optional: boolean } {
	if (node.type === "identifier") return { chain: node.text, optional: false };
	if (node.type === "this") return { chain: "this", optional: false };
	if (node.type === "super") return { chain: "super", optional: false };
	if (node.type !== "member_expression") return { chain: "", optional: false };

	const prop = node.childForFieldName("property");
	const obj = node.childForFieldName("object");
	const tail =
		prop?.type === "property_identifier" || prop?.type === "identifier" ? prop.text : "";
	const stepOptional = memberStepOptional(node);

	if (!obj) return { chain: tail, optional: stepOptional };
	if (obj.type === "this") return { chain: `this.${tail}`, optional: stepOptional };
	if (obj.type === "super") return { chain: `super.${tail}`, optional: stepOptional };
	if (obj.type === "identifier") return { chain: `${obj.text}.${tail}`, optional: stepOptional };
	if (obj.type === "member_expression") {
		const left = memberChainMeta(obj);
		const chain = left.chain ? `${left.chain}.${tail}` : tail;
		return { chain, optional: left.optional || stepOptional };
	}
	return { chain: tail, optional: stepOptional };
}

function memberChain(node: Node): string {
	return memberChainMeta(node).chain;
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

type ParsedCallee = RawCall["callee"];

function parseMemberCallee(member: Node): ParsedCallee {
	const { chain, optional } = memberChainMeta(member);
	const name = rightmostProperty(member) ?? null;
	const root = member.childForFieldName("object");
	const base: ParsedCallee =
		root?.type === "this"
			? { kind: "this", name, chain }
			: root?.type === "super"
				? { kind: "super", name, chain }
				: { kind: "member", name, chain };
	if (optional) base.optional = true;
	return base;
}

function parseCallee(fn: Node | null): ParsedCallee {
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
	if (arg.type === "member_expression") return { index, kind: "member", text: memberChain(arg) };
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

function calleeAt(fn: Node | null): Node | null {
	if (!fn) return null;
	if (fn.type === "identifier") return fn;
	if (fn.type === "member_expression") {
		const prop = fn.childForFieldName("property");
		if (prop?.type === "identifier" || prop?.type === "property_identifier") return prop;
	}
	return null;
}

function isCalleeIdentifier(node: Node): boolean {
	const parent = node.parent;
	if (!parent) return false;
	if (parent.type === "call_expression") {
		const fn = calleeAt(parent.childForFieldName("function"));
		if (fn && sameNode(fn, node)) return true;
	}
	if (parent.type === "new_expression") {
		const ctor = calleeAt(parent.childForFieldName("constructor"));
		if (ctor && sameNode(ctor, node)) return true;
	}
	return false;
}

function isDeclarationBinding(node: Node): boolean {
	const parent = node.parent;
	if (!parent) return false;

	const fieldIs = (field: string) => {
		const child = parent.childForFieldName(field);
		return child !== null && sameNode(child, node);
	};
	if (parent.type === "variable_declarator" && fieldIs("name")) return true;
	if (parent.type === "import_specifier" && fieldIs("name")) return true;
	if (parent.type === "function_declaration" && fieldIs("name")) return true;
	if (parent.type === "export_statement") {
		const decl = parent.childForFieldName("declaration");
		const name = decl?.childForFieldName("name") ?? null;
		if (name !== null && sameNode(name, node)) return true;
	}
	if (parent.type === "class_declaration" && fieldIs("name")) return true;
	if (parent.type === "method_definition") {
		const n = parent.childForFieldName("name") ?? parent.childForFieldName("property");
		if (n !== null && sameNode(n, node)) return true;
	}
	if (parent.type === "field_definition" || parent.type === "public_field_definition") {
		const n = parent.childForFieldName("property") ?? parent.childForFieldName("name");
		if (n !== null && sameNode(n, node)) return true;
	}
	if (parent.type === "member_expression" && fieldIs("property")) return true;
	if (parent.type === "pair" && fieldIs("key")) return true;
	if (parent.type === "jsx_attribute") {
		const name = parent.namedChildren[0];
		if (name != null && sameNode(name, node)) return true;
	}
	return false;
}

function refRole(node: Node): "argument" | "value" {
	const parent = node.parent;
	if (parent?.type === "arguments" && parent.parent?.type === "call_expression") {
		if (parent.namedChildren.some((c) => sameNode(c, node))) return "argument";
	}
	return "value";
}

function jsxComponentName(nameNode: Node | null): string | null {
	if (!nameNode) return null;
	if (nameNode.type === "identifier") {
		return PASCAL.test(nameNode.text) ? nameNode.text : null;
	}
	if (nameNode.type === "member_expression") {
		return memberChain(nameNode);
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

/** Innermost symbol by byte span; tie-break on id for stability. */
export function enclosingFromId(symbols: SymbolFact[], index: number, moduleId: NodeId): NodeId {
	let best: SymbolFact | null = null;
	let bestSpan = Number.POSITIVE_INFINITY;
	for (const s of symbols) {
		if (s.startIndex > index || index >= s.endIndex) continue;
		const span = s.endIndex - s.startIndex;
		if (span > bestSpan) continue;
		if (span < bestSpan || best === null || s.id < best.id) {
			bestSpan = span;
			best = s;
		}
	}
	return best ? (best.id as NodeId) : moduleId;
}

const ENCLOSING_BUCKET_SHIFT = 12;

export function makeEnclosingFromId(symbols: SymbolFact[], moduleId: NodeId): (index: number) => NodeId {
	if (symbols.length === 0) return () => moduleId;
	const buckets = new Map<number, SymbolFact[]>();
	for (const s of symbols) {
		const b0 = s.startIndex >> ENCLOSING_BUCKET_SHIFT;
		const endByte = Math.max(s.endIndex - 1, s.startIndex);
		const b1 = endByte >> ENCLOSING_BUCKET_SHIFT;
		for (let b = b0; b <= b1; b++) {
			let list = buckets.get(b);
			if (!list) {
				list = [];
				buckets.set(b, list);
			}
			list.push(s);
		}
	}

	return (index: number): NodeId => {
		const b = index >> ENCLOSING_BUCKET_SHIFT;
		let best: SymbolFact | null = null;
		let bestSpan = Number.POSITIVE_INFINITY;
		const seen = new Set<string>();
		for (const bb of [b - 1, b, b + 1]) {
			const list = buckets.get(bb);
			if (!list) continue;
			for (const s of list) {
				if (seen.has(s.id)) continue;
				seen.add(s.id);
				if (s.startIndex > index || index >= s.endIndex) continue;
				const span = s.endIndex - s.startIndex;
				if (span > bestSpan) continue;
				if (span < bestSpan || best === null || s.id < best.id) {
					bestSpan = span;
					best = s;
				}
			}
		}
		return best ? (best.id as NodeId) : moduleId;
	};
}

type AncestorFrame = { parentType: string; field: string };

/** parentType:field keys that bind a name (skip ref extraction). */
const DECL_BINDING_FIELD = new Set([
	"import_specifier:name",
	"variable_declarator:name",
	"function_declaration:name",
	"class_declaration:name",
	"method_definition:name",
	"method_definition:property",
	"field_definition:property",
	"field_definition:name",
	"public_field_definition:property",
	"public_field_definition:name",
	"member_expression:property",
	"pair:key",
	"jsx_attribute:name",
]);

/** Test hook: full-tree walks from extractUsages. */
export let usageFullWalkCount = 0;
export function resetUsageFullWalkCount(): void {
	usageFullWalkCount = 0;
}

function isCalleeByFrames(frames: readonly AncestorFrame[], nodeType: string): boolean {
	const depth = frames.length;
	if (depth === 0) return false;
	const leaf = frames[depth - 1]!;
	const isName = nodeType === "identifier" || nodeType === "property_identifier";
	if (!isName) return false;
	if (leaf.parentType === "call_expression" && leaf.field === "function") return true;
	if (leaf.parentType === "new_expression" && leaf.field === "constructor") return true;
	if (leaf.parentType === "member_expression" && leaf.field === "property") {
		for (let i = depth - 2; i >= 0; i--) {
			const f = frames[i]!;
			if (f.parentType === "call_expression" && f.field === "function") return true;
			if (f.parentType === "new_expression" && f.field === "constructor") return true;
			if (f.parentType !== "member_expression" || f.field !== "object") break;
		}
	}
	return false;
}

function isDeclBindingByFrames(frames: readonly AncestorFrame[], nodeType: string): boolean {
	if (nodeType !== "identifier" && nodeType !== "property_identifier") return false;
	const f = frames[frames.length - 1];
	if (!f) return false;
	if (f.parentType === "variable_declarator" && f.field === "name") return true;
	if (f.parentType === "import_specifier" && f.field === "name") return true;
	if (f.parentType === "function_declaration" && f.field === "name") return true;
	if (f.parentType === "class_declaration" && f.field === "name") return true;
	if (f.parentType === "method_definition" && (f.field === "name" || f.field === "property")) return true;
	if ((f.parentType === "field_definition" || f.parentType === "public_field_definition") &&
		(f.field === "property" || f.field === "name")
	) {
		return true;
	}
	if (f.parentType === "member_expression" && f.field === "property") return true;
	if (f.parentType === "pair" && f.field === "key") return true;
	if (f.parentType === "jsx_attribute" && f.field === "name") return true;
	const g = frames[frames.length - 2];
	if (g?.parentType === "export_statement" && g.field === "declaration") {
		if (f.parentType === "function_declaration" && f.field === "name") return true;
		if (f.parentType === "class_declaration" && f.field === "name") return true;
	}
	return false;
}

function refRoleByFrames(frames: readonly AncestorFrame[]): "argument" | "value" {
	const f = frames[frames.length - 1];
	if (!f || f.parentType !== "arguments") return "value";
	const g = frames[frames.length - 2];
	return g?.parentType === "call_expression" ? "argument" : "value";
}

type WalkCtx = {
	readonly nodeType: string;
	readonly startIndex: number;
	readonly endIndex: number;
	readonly line: number;
	readonly text: string;
	readonly frames: readonly AncestorFrame[];
	materialize: () => Node;
};

function walkWithFields(root: Node, visit: (ctx: WalkCtx) => boolean): void {
	usageFullWalkCount++;
	const cursor = root.walk();
	const frames: AncestorFrame[] = [];

	while (true) {
		const isNamed = cursor.nodeIsNamed;
		let descend = true;

		let parentType = "";
		if (isNamed) {
			parentType = cursor.nodeType;
			const startIndex = cursor.startIndex;
			const endIndex = cursor.endIndex;
			const line = cursor.startPosition.row + 1;
			const text =
				parentType === "identifier" || parentType === "property_identifier" ? cursor.nodeText : "";

			descend = visit({
				nodeType: parentType,
				startIndex,
				endIndex,
				line,
				text,
				frames,
				materialize: () => cursor.currentNode as Node,
			});
		}

		if (descend && cursor.gotoFirstChild()) {
			if (parentType) frames.push({ parentType, field: cursor.currentFieldName ?? "" });
			continue;
		}
		if (cursor.gotoNextSibling()) {
			const top = frames.at(-1);
			if (top) top.field = cursor.currentFieldName ?? "";
			continue;
		}
		do {
			if (frames.length > 0) frames.pop();
			if (!cursor.gotoParent()) return;
		} while (!cursor.gotoNextSibling());
		const top = frames.at(-1);
		if (top) top.field = cursor.currentFieldName ?? "";
	}
}

function cmpString(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

type SiteCall = RawCall & { startIndex: number };
type SiteRender = RawRender & { startIndex: number };

function sortCalls(calls: SiteCall[]): RawCall[] {
	return [...calls]
		.sort(
			(a, b) =>
				cmpString(a.fromId, b.fromId) ||
				a.line - b.line ||
				a.startIndex - b.startIndex,
		)
		.map(({ startIndex: _i, ...rest }) => rest);
}

function sortRenders(renders: SiteRender[]): RawRender[] {
	return [...renders]
		.sort(
			(a, b) =>
				cmpString(a.fromId, b.fromId) ||
				a.line - b.line ||
				a.startIndex - b.startIndex,
		)
		.map(({ startIndex: _i, ...rest }) => rest);
}

function finalizeRefs(raw: Array<RawRef & { startIndex: number }>): RawRef[] {
	const byKey = new Map<string, RawRef & { startIndex: number }>();
	for (const r of raw) {
		const key = `${r.fromId}|${r.name}|${r.role}`;
		const prev = byKey.get(key);
		if (!prev || r.line < prev.line || (r.line === prev.line && r.startIndex < prev.startIndex)) {
			byKey.set(key, r);
		}
	}
	return [...byKey.values()]
		.sort(
			(a, b) =>
				cmpString(a.fromId, b.fromId) ||
				a.line - b.line ||
				cmpString(a.name, b.name) ||
				cmpString(a.role, b.role),
		)
		.map(({ startIndex: _i, ...rest }) => rest);
}

export function extractUsages(
	root: Node,
	symbols: SymbolFact[],
	knownNames: Set<string>,
	filePath: string,
): {
	calls: RawCall[];
	refs: RawRef[];
	renders: RawRender[];
	dynamicImports: RawImport[];
	newLocals: RawNewLocal[];
	scopeParams: RawScopeParams[];
} {
	const moduleId = fileId(filePath);
	const enclosing = makeEnclosingFromId(symbols, moduleId);
	const calls: SiteCall[] = [];
	const rawRefs: Array<RawRef & { startIndex: number }> = [];
	const renders: SiteRender[] = [];
	const dynamicImports: RawImport[] = [];
	const newLocals: RawNewLocal[] = [];
	const scopeParams = new Map<NodeId, { names: Set<string>; types: Record<string, string> }>();

	function typeName(node: Node | null | undefined): string | null {
		if (!node) return null;
		if (node.type === "type_annotation") {
			return typeName(
				node.childForFieldName("type") ??
					node.namedChildren.find((c) => c.type === "type_identifier" || c.type === "nested_type_identifier"),
			);
		}
		if (node.type === "type_identifier" || node.type === "nested_type_identifier") return node.text;
		return null;
	}

	function recordParams(fromId: NodeId, params: Node) {
		const entry = scopeParams.get(fromId) ?? { names: new Set<string>(), types: {} };
		for (const child of params.namedChildren) {
			if (child.type !== "required_parameter" && child.type !== "optional_parameter") continue;
			const pattern =
				child.childForFieldName("pattern") ?? child.namedChildren.find((c) => c.type === "identifier");
			if (pattern?.type !== "identifier" && pattern?.type !== "property_identifier") continue;
			entry.names.add(pattern.text);
			const tn =
				typeName(child.childForFieldName("type")) ??
				typeName(child.namedChildren.find((c) => c.type === "type_annotation") ?? null);
			if (tn) entry.types[pattern.text] = tn;
		}
		if (entry.names.size === 0) return;
		scopeParams.set(fromId, entry);
	}

	walkWithFields(root, (ctx) => {
		const { nodeType, startIndex, line, text, frames } = ctx;
		if (SKIP.has(nodeType)) return false;

		if (nodeType === "identifier") {
			if (!knownNames.has(text)) return true;
			const leaf = frames.at(-1);
			if (leaf && DECL_BINDING_FIELD.has(`${leaf.parentType}:${leaf.field}`)) return true;
			if (
				leaf &&
				((leaf.parentType === "call_expression" && leaf.field === "function") ||
					(leaf.parentType === "new_expression" && leaf.field === "constructor"))
			) {
				return true;
			}
		}

		const site = startIndex;

		if (nodeType === "call_expression") {
			const call = ctx.materialize();
			const dyn = recordCallSiteImport(call, knownNames);
			if (dyn) {
				dynamicImports.push(dyn);
				return true;
			}
			const fn = call.childForFieldName("function");
			calls.push({
				fromId: enclosing(startIndex),
				callee: parseCallee(fn),
				args: parseArgs(call),
				line,
				isNew: false,
				startIndex: site,
			});
			return true;
		}

		if (nodeType === "new_expression") {
			const neu = ctx.materialize();
			const ctor = neu.childForFieldName("constructor");
			calls.push({
				fromId: enclosing(startIndex),
				callee: parseCallee(ctor),
				args: parseArgs(neu),
				line,
				isNew: true,
				startIndex: site,
			});
			return true;
		}

		if (nodeType === "formal_parameters") {
			const parent = ctx.materialize().parent;
			if (
				parent &&
				(FUNCTION_DECLS.has(parent.type) ||
					parent.type === "method_definition" ||
					parent.type === "arrow_function" ||
					parent.type === "function_expression")
			) {
				recordParams(enclosing(startIndex), ctx.materialize());
			}
			return true;
		}

		if (nodeType === "variable_declarator") {
			const declarator = ctx.materialize();
			const nameNode = declarator.childForFieldName("name");
			const value = declarator.childForFieldName("value");
			if (nameNode?.type === "identifier" && value?.type === "new_expression") {
				const ctor = value.childForFieldName("constructor");
				const callee = parseCallee(ctor);
				if (callee.name) {
					newLocals.push({
						fromId: enclosing(startIndex),
						local: nameNode.text,
						className: callee.name,
						line,
					});
				}
			}
			return true;
		}

		if (nodeType === "identifier") {
			if (!isCalleeByFrames(frames, nodeType) && !isDeclBindingByFrames(frames, nodeType)) {
				rawRefs.push({
					fromId: enclosing(startIndex),
					name: text,
					role: refRoleByFrames(frames),
					line,
					startIndex: site,
				});
			}
			return true;
		}

		if (nodeType === "jsx_opening_element" || nodeType === "jsx_self_closing_element") {
			const el = ctx.materialize();
			const component = jsxComponentName(el.childForFieldName("name"));
			if (component) {
				renders.push({
					fromId: enclosing(startIndex),
					component,
					props: jsxProps(el),
					line,
					startIndex: site,
				});
			}
			return true;
		}

		return true;
	});

	newLocals.sort(
		(a, b) =>
			cmpString(a.fromId, b.fromId) ||
			a.line - b.line ||
			cmpString(a.local, b.local) ||
			cmpString(a.className, b.className),
	);

	const scopeParamsOut: RawScopeParams[] = [...scopeParams.entries()]
		.map(([fromId, row]) => ({
			fromId,
			names: [...row.names].sort(cmpString),
			types: row.types,
		}))
		.sort((a, b) => cmpString(a.fromId, b.fromId));

	return {
		calls: sortCalls(calls),
		refs: finalizeRefs(rawRefs),
		renders: sortRenders(renders),
		dynamicImports,
		newLocals,
		scopeParams: scopeParamsOut,
	};
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
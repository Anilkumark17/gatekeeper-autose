import type { NodeId } from "../../../core/ids.js";
import { externalId, fileId, parseNodeId, symbolId, unresolvedId } from "../../../core/ids.js";
import type { FileFacts } from "../extract-file.js";
import type { RawExport } from "../exports.js";
import type { RawImport } from "../imports.js";
import type { ImportResolver, ResolvedImport, ResolvedTarget } from "../resolve/resolve-imports.js";
import type { SymbolFact, SymbolKind } from "../symbols.js";
import type { RawArg, RawCall, RawRef, RawRender } from "../usages.js";
import type { ExportTarget, MemberUnboundBucket } from "./types.js";

const MAX_EXPORT_DEPTH = 10;

const INTRINSIC_METHODS = new Set([
	"map",
	"filter",
	"forEach",
	"reduce",
	"find",
	"findIndex",
	"some",
	"every",
	"includes",
	"slice",
	"splice",
	"push",
	"pop",
	"shift",
	"unshift",
	"sort",
	"flat",
	"flatMap",
	"then",
	"catch",
	"finally",
	"split",
	"join",
	"trim",
	"trimStart",
	"trimEnd",
	"toLowerCase",
	"toUpperCase",
	"replace",
	"replaceAll",
	"match",
	"test",
	"toString",
	"valueOf",
	"bind",
	"call",
	"apply",
	"keys",
	"values",
	"entries",
	"add",
	"delete",
	"has",
	"get",
	"set",
]);

const GLOBAL_NAMES = new Set([
	"console",
	"Promise",
	"describe",
	"expect",
	"it",
	"test",
	"beforeEach",
	"afterEach",
	"beforeAll",
	"afterAll",
	"setTimeout",
	"clearTimeout",
	"setInterval",
	"clearInterval",
	"JSON",
	"Math",
	"Object",
	"Array",
	"String",
	"Number",
	"Boolean",
	"Map",
	"Set",
	"WeakMap",
	"WeakSet",
	"Symbol",
	"BigInt",
	"Date",
	"Error",
	"RegExp",
	"Intl",
	"Reflect",
	"Proxy",
	"parseInt",
	"parseFloat",
	"isNaN",
	"isFinite",
	"decodeURI",
	"decodeURIComponent",
	"encodeURI",
	"encodeURIComponent",
	"eval",
	"undefined",
	"NaN",
	"Infinity",
	"globalThis",
	"process",
	"Buffer",
	"require",
	"module",
	"exports",
	"__dirname",
	"__filename",
]);

export interface ImportBinding {
	local: string;
	imported: string;
	target: ResolvedTarget;
	specifier: string | null;
	typeOnly: boolean;
	dynamic: boolean;
}

export interface FileScope {
	path: string;
	locals: Map<string, NodeId>;
	methods: Map<string, NodeId>;
	imports: Map<string, ImportBinding>;
	symbolKind: Map<NodeId, SymbolKind>;
	classFieldTypes: Map<string, Record<string, string>>;
}

export interface GraphBindContext {
	factsByPath: Map<string, FileFacts>;
	resolver: ImportResolver;
	resolvedByFile: Map<string, ResolvedImport[]>;
	scopes: Map<string, FileScope>;
	exportMemo: Map<string, ExportTarget>;
	resolveTargetMemo: Map<string, string | null>;
	bindNameMemo: Map<string, ExportTarget>;
	newLocalsByFromId: Map<NodeId, Map<string, string>>;
	paramTypesByFromId: Map<NodeId, Map<string, string>>;
	classSymbols: Map<string, Map<string, NodeId>>;
	exportResolver: ExportResolver;
}

export interface ExportResolver {
	resolveExport(filePath: string, name: string, depth?: number): ExportTarget;
}

function cmpPath(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function staticImportFrom(filePath: string, specifier: string, typeOnly: boolean): RawImport {
	return {
		specifier,
		kind: "static",
		defaultLocal: null,
		namespaceLocal: null,
		names: [],
		typeOnly,
		line: 0,
	};
}

function resolveTargetPath(from: string, target: ResolvedTarget): string | null {
	if (target.kind === "file" || target.kind === "types") return target.path;
	return null;
}

function findLocalSymbol(facts: FileFacts, localName: string): SymbolFact | undefined {
	const matches = facts.symbols.filter((s) => s.name === localName);
	if (matches.length === 0) return undefined;
	const top = matches.find((s) => !s.qualifiedName.includes("."));
	return top ?? matches[0];
}

function findDefaultSymbol(facts: FileFacts, localHint: string | null): SymbolFact | undefined {
	if (localHint) {
		const hit = findLocalSymbol(facts, localHint);
		if (hit) return hit;
	}
	return facts.symbols.find((s) => s.isDefault);
}

function exportLocalToTarget(facts: FileFacts, local: string | null, typeOnly: boolean): ExportTarget {
	if (!local) return { kind: "module", id: fileId(facts.path) };
	const sym = findLocalSymbol(facts, local) ?? (local === "default" ? findDefaultSymbol(facts, null) : undefined);
	if (sym) return { kind: "symbol", id: sym.id as NodeId };
	if (typeOnly) return { kind: "module", id: fileId(facts.path) };
	return { kind: "module", id: fileId(facts.path) };
}

function targetFileFromResolver(ctx: GraphBindContext, from: string, specifier: string, typeOnly: boolean): string | null {
	const key = `${from}\0${specifier}\0${typeOnly ? 1 : 0}`;
	const cached = ctx.resolveTargetMemo.get(key);
	if (cached !== undefined) return cached;
	const resolved = ctx.resolver.resolve(from, staticImportFrom(from, specifier, typeOnly));
	const path = resolveTargetPath(from, resolved.target);
	ctx.resolveTargetMemo.set(key, path);
	return path;
}

function createExportResolver(ctx: GraphBindContext): ExportResolver {
	const inflight = new Map<string, Set<string>>();

	const resolveOnce = (filePath: string, name: string, depth: number): ExportTarget => {
		const memoKey = `${filePath}\0${name}`;
		const hit = ctx.exportMemo.get(memoKey);
		if (hit) return hit;

		if (depth > MAX_EXPORT_DEPTH) {
			const unresolved: ExportTarget = { kind: "unresolved" };
			ctx.exportMemo.set(memoKey, unresolved);
			return unresolved;
		}

		let visiting = inflight.get(filePath);
		if (!visiting) {
			visiting = new Set();
			inflight.set(filePath, visiting);
		}
		if (visiting.has(name)) {
			const unresolved: ExportTarget = { kind: "unresolved" };
			ctx.exportMemo.set(memoKey, unresolved);
			return unresolved;
		}
		visiting.add(name);

		const facts = ctx.factsByPath.get(filePath);
		if (!facts) {
			visiting.delete(name);
			const unresolved: ExportTarget = { kind: "unresolved" };
			ctx.exportMemo.set(memoKey, unresolved);
			return unresolved;
		}

		let result: ExportTarget = { kind: "unresolved" };

		for (const ex of facts.exports) {
			if (ex.exported !== name) continue;
			result = exportEntryTarget(ctx, facts, ex, name, depth);
			if (result.kind !== "unresolved") break;
		}

		if (result.kind === "unresolved") {
			for (const ex of facts.exports) {
				if (ex.kind !== "reexport_all" || !ex.source) continue;
				const sourcePath = targetFileFromResolver(ctx, filePath, ex.source, ex.typeOnly);
				if (!sourcePath) continue;
				const nested = resolveOnce(sourcePath, name, depth + 1);
				if (nested.kind !== "unresolved") {
					result = nested;
					break;
				}
			}
		}

		visiting.delete(name);
		ctx.exportMemo.set(memoKey, result);
		return result;
	};

	return {
		resolveExport(filePath: string, name: string, depth = 0) {
			return resolveOnce(filePath, name, depth);
		},
	};
}

function exportEntryTarget(
	ctx: GraphBindContext,
	facts: FileFacts,
	ex: RawExport,
	name: string,
	depth: number,
): ExportTarget {
	switch (ex.kind) {
		case "local":
			return exportLocalToTarget(facts, ex.local ?? ex.exported ?? name, ex.typeOnly);
		case "commonjs":
			return exportLocalToTarget(facts, ex.local ?? ex.exported ?? name, false);
		case "reexport": {
			if (!ex.source) return { kind: "unresolved" };
			const sourcePath = targetFileFromResolver(ctx, facts.path, ex.source, ex.typeOnly);
			if (!sourcePath) return { kind: "unresolved" };
			const imported = ex.imported ?? name;
			return ctx.exportResolver.resolveExport(sourcePath, imported, depth + 1);
		}
		case "reexport_namespace": {
			if (!ex.source) return { kind: "unresolved" };
			const sourcePath = targetFileFromResolver(ctx, facts.path, ex.source, ex.typeOnly);
			if (!sourcePath) return { kind: "unresolved" };
			return { kind: "module", id: fileId(sourcePath) };
		}
		case "reexport_all":
			return { kind: "unresolved" };
		default:
			return { kind: "unresolved" };
	}
}

function resolveImportTarget(target: ResolvedTarget): ExportTarget | "skip" {
	switch (target.kind) {
		case "file":
		case "types":
			return { kind: "module", id: fileId(target.path) };
		case "external":
			return { kind: "external", id: externalId(target.pkg) };
		case "asset":
			return "skip";
		case "unresolved":
			return target.reason === "non_literal" || !target.reason
				? { kind: "unresolved" }
				: { kind: "unresolved" };
	}
}

export function buildImportBindings(filePath: string, facts: FileFacts, resolved: ResolvedImport[]): ImportBinding[] {
	const out: ImportBinding[] = [];
	for (let i = 0; i < facts.imports.length; i++) {
		const imp = facts.imports[i]!;
		const row = resolved[i];
		if (!row) continue;
		const dynamic = imp.kind === "dynamic";
		if (imp.defaultLocal) {
			out.push({
				local: imp.defaultLocal,
				imported: "default",
				target: row.target,
				specifier: imp.specifier,
				typeOnly: imp.typeOnly,
				dynamic,
			});
		}
		if (imp.namespaceLocal) {
			out.push({
				local: imp.namespaceLocal,
				imported: "namespace",
				target: row.target,
				specifier: imp.specifier,
				typeOnly: imp.typeOnly,
				dynamic,
			});
		}
		for (const name of imp.names) {
			out.push({
				local: name.local,
				imported: name.imported,
				target: row.target,
				specifier: imp.specifier,
				typeOnly: imp.typeOnly || name.typeOnly,
				dynamic,
			});
		}
	}
	return out;
}

export function buildFileScope(path: string, facts: FileFacts, bindings: ImportBinding[]): FileScope {
	const locals = new Map<string, NodeId>();
	const methods = new Map<string, NodeId>();
	const symbolKind = new Map<NodeId, SymbolKind>();
	const classFieldTypes = new Map<string, Record<string, string>>();
	for (const sym of facts.symbols) {
		symbolKind.set(sym.id as NodeId, sym.kind);
		if (sym.kind === "class" && sym.fieldTypes) classFieldTypes.set(sym.name, sym.fieldTypes);
		if (sym.qualifiedName.includes(".")) {
			methods.set(sym.qualifiedName, sym.id as NodeId);
		} else if (!sym.qualifiedName.includes("~")) {
			locals.set(sym.name, sym.id as NodeId);
		}
	}
	const imports = new Map<string, ImportBinding>();
	for (const b of bindings) imports.set(b.local, b);
	return { path, locals, methods, imports, symbolKind, classFieldTypes };
}

function symbolKindAt(ctx: GraphBindContext, id: NodeId): SymbolKind | undefined {
	const scope = ctx.scopes.get(nodeFilePath(id));
	return scope?.symbolKind.get(id);
}

function enclosingClassFieldTypes(scope: FileScope, fromId: NodeId): Record<string, string> | undefined {
	const cls = classPrefix(fromId);
	if (!cls) return undefined;
	return scope.classFieldTypes.get(cls);
}

function newLocalClassName(ctx: GraphBindContext, fromId: NodeId, local: string): string | null {
	return ctx.newLocalsByFromId.get(fromId)?.get(local) ?? null;
}

function classNameFromTarget(ctx: GraphBindContext, target: ExportTarget): string | null {
	if (target.kind === "symbol") {
		const parsed = parseNodeId(target.id);
		if (parsed.kind === "symbol") {
			const base = parsed.qualifiedName.split(".")[0] ?? null;
			return base;
		}
	}
	return null;
}

function resolveClassMethod(
	ctx: GraphBindContext,
	classTarget: ExportTarget,
	method: string,
): ExportTarget | null {
	if (classTarget.kind !== "symbol" && classTarget.kind !== "module") return null;
	let repoPath: string | null = null;
	let className: string | null = null;
	if (classTarget.kind === "symbol") {
		const parsed = parseNodeId(classTarget.id);
		if (parsed.kind !== "symbol") return null;
		repoPath = parsed.repoPath;
		className = classNameFromTarget(ctx, classTarget);
	} else {
		const parsed = parseNodeId(classTarget.id);
		if (parsed.kind === "file") repoPath = parsed.repoPath;
	}
	if (repoPath && className) {
		const mid = ctx.scopes.get(repoPath)?.methods.get(`${className}.${method}`);
		if (mid) return { kind: "symbol", id: mid };
	}
	if (repoPath) {
		const hit = ctx.exportResolver.resolveExport(repoPath, method);
		if (hit.kind !== "unresolved") return hit;
	}
	return null;
}

function resolveMethodOnType(
	ctx: GraphBindContext,
	scope: FileScope,
	exportResolver: ExportResolver,
	typeName: string,
	method: string,
): ExportTarget | null {
	const typeTarget = bindName(ctx, scope, exportResolver, typeName);
	if (typeTarget.kind === "unresolved") {
		const hit = ctx.exportResolver.resolveExport(scope.path, typeName);
		if (hit.kind === "unresolved") return null;
		return resolveClassMethod(ctx, hit, method);
	}
	return resolveClassMethod(ctx, typeTarget, method);
}

export function classifyMemberUnbound(
	ctx: GraphBindContext,
	scope: FileScope,
	exportResolver: ExportResolver,
	call: RawCall,
): MemberUnboundBucket {
	const callee = call.callee;
	if (callee.kind !== "member" || !callee.chain || !callee.name) return "other";
	const parts = callee.chain.split(".");
	const root = parts[0] ?? "";
	if (root === "this" && parts.length >= 3) return "root_this_field";
	if (newLocalClassName(ctx, call.fromId, root)) return "root_new_local";
	const imp = scope.imports.get(root);
	if (imp?.target.kind === "external") return "root_external";
	if (
		root &&
		root !== "this" &&
		!GLOBAL_NAMES.has(root) &&
		!scope.imports.has(root) &&
		!scope.locals.has(root)
	) {
		return "root_param_or_local";
	}
	const rootTarget = bindName(ctx, scope, exportResolver, root);
	if (rootTarget.kind === "symbol" && symbolKindAt(ctx, rootTarget.id) === "class") return "root_imported_class";
	if (rootTarget.kind === "external") return "root_external";
	if (imp && rootTarget.kind !== "unresolved") return "root_imported_class";
	return "other";
}

export function nodeFilePath(fromId: NodeId): string {
	const parsed = parseNodeId(fromId);
	if (parsed.kind === "symbol") return parsed.repoPath;
	if (parsed.kind === "file") return parsed.repoPath;
	return "";
}

export function bindName(
	ctx: GraphBindContext,
	scope: FileScope,
	exportResolver: ExportResolver,
	name: string,
): ExportTarget {
	const memoKey = `${scope.path}\0${name}`;
	const memoHit = ctx.bindNameMemo.get(memoKey);
	if (memoHit) return memoHit;
	const local = scope.locals.get(name);
	if (local) {
		const hit: ExportTarget = { kind: "symbol", id: local };
		ctx.bindNameMemo.set(memoKey, hit);
		return hit;
	}
	const imp = scope.imports.get(name);
	let result: ExportTarget;
	if (!imp) {
		result = { kind: "unresolved" };
		ctx.bindNameMemo.set(memoKey, result);
		return result;
	}
	if (imp.imported === "namespace") {
		const modulePath = resolveTargetPath(scope.path, imp.target);
		if (modulePath) result = { kind: "module", id: fileId(modulePath) };
		else {
			const alt = resolveImportTarget(imp.target);
			result = alt === "skip" ? { kind: "unresolved" } : alt;
		}
		ctx.bindNameMemo.set(memoKey, result);
		return result;
	}
	const modulePath = resolveTargetPath(scope.path, imp.target);
	if (!modulePath) {
		const alt = resolveImportTarget(imp.target);
		result = alt === "skip" ? { kind: "unresolved" } : alt;
	} else {
		result = exportResolver.resolveExport(modulePath, imp.imported);
	}
	ctx.bindNameMemo.set(memoKey, result);
	return result;
}

function classPrefix(fromId: NodeId): string | null {
	const parsed = parseNodeId(fromId);
	if (parsed.kind !== "symbol") return null;
	const qn = parsed.qualifiedName;
	const dot = qn.indexOf(".");
	if (dot < 0) return null;
	return qn.slice(0, dot);
}

export function bindThisMember(scope: FileScope, fromId: NodeId, member: string): ExportTarget {
	const cls = classPrefix(fromId);
	if (!cls) return { kind: "unresolved" };
	const q = `${cls}.${member}`;
	const method = scope.methods.get(q);
	if (method) return { kind: "symbol", id: method };
	const fieldLike = scope.locals.get(member);
	if (fieldLike) return { kind: "symbol", id: fieldLike };
	return { kind: "unresolved" };
}

export function bindCallee(
	ctx: GraphBindContext,
	scope: FileScope,
	exportResolver: ExportResolver,
	call: RawCall,
): {
	target: ExportTarget | null;
	category: "bound" | "global" | "member_unbound" | "unresolved_import";
	memberBucket?: MemberUnboundBucket;
} {
	const memberUnbound = (bucket: MemberUnboundBucket) => ({
		target: null as ExportTarget | null,
		category: "member_unbound" as const,
		memberBucket: bucket,
	});

	const { callee } = call;
	if (callee.kind === "this" && callee.name) {
		const t = bindThisMember(scope, call.fromId, callee.name);
		return t.kind === "unresolved" ? memberUnbound("other") : { target: t, category: "bound" };
	}
	if (callee.kind === "super") {
		return memberUnbound("other");
	}
	if (callee.kind === "name" && callee.name) {
		if (GLOBAL_NAMES.has(callee.name)) return { target: null, category: "global" };
		const imp = scope.imports.get(callee.name);
		const bound = bindName(ctx, scope, exportResolver, callee.name);
		if (bound.kind !== "unresolved") return { target: bound, category: "bound" };
		if (imp) return { target: null, category: "unresolved_import" };
		if (!scope.locals.has(callee.name)) return { target: null, category: "global" };
		return memberUnbound("root_param_or_local");
	}
	if (callee.kind === "member" && callee.chain && callee.name) {
		const parts = callee.chain.split(".");
		const root = parts[0] ?? "";
		if (root === "this") {
			if (parts.length >= 3) {
				const field = parts[1]!;
				const fieldTypes = enclosingClassFieldTypes(scope, call.fromId);
				const typeName = fieldTypes?.[field];
				if (typeName) {
					const t = resolveMethodOnType(ctx, scope, exportResolver, typeName, callee.name);
					if (t) return { target: t, category: "bound" };
				}
			}
			if (parts.length >= 2) {
				const t = bindThisMember(scope, call.fromId, callee.name);
				if (t.kind !== "unresolved") return { target: t, category: "bound" };
			}
			return memberUnbound(classifyMemberUnbound(ctx, scope, exportResolver, call));
		}
		if (GLOBAL_NAMES.has(root)) return { target: null, category: "global" };
		if (
			parts.length === 2 &&
			root &&
			!scope.imports.has(root) &&
			!scope.locals.has(root) &&
			INTRINSIC_METHODS.has(callee.name)
		) {
			return { target: null, category: "global" };
		}
		const impRoot = scope.imports.get(root);
		if (impRoot && callee.name && parts.length >= 2) {
			const modulePath = resolveTargetPath(scope.path, impRoot.target);
			if (modulePath) {
				const t = exportResolver.resolveExport(modulePath, callee.name);
				if (t) return { target: t, category: "bound" };
			}
			if (impRoot.target.kind === "external") {
				return memberUnbound("root_external");
			}
		}
		const ns = scope.imports.get(root);
		if (ns && (ns.imported === "namespace" || ns.target.kind === "external")) {
			if (ns.target.kind === "external") {
				return memberUnbound("root_external");
			}
			const modulePath = resolveTargetPath(scope.path, ns.target);
			if (modulePath && callee.name) {
				const t = exportResolver.resolveExport(modulePath, callee.name);
				if (t.kind !== "unresolved") return { target: t, category: "bound" };
			}
		}
		const newClass = newLocalClassName(ctx, call.fromId, root);
		if (newClass) {
			const classTarget = bindName(ctx, scope, exportResolver, newClass);
			const t = resolveClassMethod(ctx, classTarget, callee.name);
			if (t) return { target: t, category: "bound" };
		}
		const paramType = ctx.paramTypesByFromId.get(call.fromId)?.get(root);
		if (paramType && parts.length >= 2) {
			const t = resolveMethodOnType(ctx, scope, exportResolver, paramType, callee.name);
			if (t) return { target: t, category: "bound" };
		}
		if (parts.length >= 2 && root) {
			const boundRoot = bindName(ctx, scope, exportResolver, root);
			if (boundRoot.kind === "symbol" && symbolKindAt(ctx, boundRoot.id) === "class") {
				const t = resolveClassMethod(ctx, boundRoot, callee.name);
				if (t) return { target: t, category: "bound" };
			}
			if (boundRoot.kind === "module") {
				const parsed = parseNodeId(boundRoot.id);
				if (parsed.kind === "file") {
					const t = exportResolver.resolveExport(parsed.repoPath, callee.name);
					if (t.kind !== "unresolved") return { target: t, category: "bound" };
				}
			}
			if (boundRoot.kind !== "unresolved" && boundRoot.kind !== "external") {
				const t = resolveClassMethod(ctx, boundRoot, callee.name);
				if (t) return { target: t, category: "bound" };
			}
			if (boundRoot.kind === "external") {
				return memberUnbound("root_external");
			}
		}
		return memberUnbound(classifyMemberUnbound(ctx, scope, exportResolver, call));
	}
	return memberUnbound("other");
}

export function bindRefName(
	ctx: GraphBindContext,
	scope: FileScope,
	exportResolver: ExportResolver,
	name: string,
): ExportTarget {
	return bindName(ctx, scope, exportResolver, name);
}

export function bindComponent(
	ctx: GraphBindContext,
	scope: FileScope,
	exportResolver: ExportResolver,
	render: RawRender,
): ExportTarget {
	return bindName(ctx, scope, exportResolver, render.component);
}

export function bindArgIdentifier(
	ctx: GraphBindContext,
	scope: FileScope,
	exportResolver: ExportResolver,
	arg: RawArg,
): ExportTarget {
	if (arg.kind !== "identifier" || !arg.text) return { kind: "unresolved" };
	return bindName(ctx, scope, exportResolver, arg.text);
}

export function isConstTarget(ctx: GraphBindContext, target: ExportTarget): boolean {
	if (target.kind !== "symbol") return false;
	return ctx.scopes.get(nodeFilePath(target.id))?.symbolKind.get(target.id) === "const";
}

export function createGraphBindContext(
	factsByPath: Map<string, FileFacts>,
	resolver: ImportResolver,
): GraphBindContext {
	const resolvedByFile = new Map<string, ResolvedImport[]>();
	const scopes = new Map<string, FileScope>();
	const newLocalsByFromId = new Map<NodeId, Map<string, string>>();
	const paramTypesByFromId = new Map<NodeId, Map<string, string>>();
	const classSymbols = new Map<string, Map<string, NodeId>>();
	const paths = [...factsByPath.keys()].sort(cmpPath);
	for (const filePath of paths) {
		const facts = factsByPath.get(filePath)!;
		const resolved = facts.imports.map((imp) => resolver.resolve(filePath, imp));
		resolvedByFile.set(filePath, resolved);
		const bindings = buildImportBindings(filePath, facts, resolved);
		const scope = buildFileScope(filePath, facts, bindings);
		scopes.set(filePath, scope);
		const byClass = new Map<string, NodeId>();
		for (const sym of facts.symbols) {
			if (sym.kind === "class") byClass.set(sym.name, sym.id as NodeId);
		}
		if (byClass.size) classSymbols.set(filePath, byClass);
		for (const row of facts.newLocals ?? []) {
			let map = newLocalsByFromId.get(row.fromId);
			if (!map) {
				map = new Map();
				newLocalsByFromId.set(row.fromId, map);
			}
			map.set(row.local, row.className);
		}
		for (const row of facts.scopeParams ?? []) {
			if (Object.keys(row.types).length === 0) continue;
			paramTypesByFromId.set(row.fromId, new Map(Object.entries(row.types)));
		}
	}
	const ctx: GraphBindContext = {
		factsByPath,
		resolver,
		resolvedByFile,
		scopes,
		exportMemo: new Map(),
		resolveTargetMemo: new Map(),
		bindNameMemo: new Map(),
		newLocalsByFromId,
		paramTypesByFromId,
		classSymbols,
		exportResolver: { resolveExport: () => ({ kind: "unresolved" }) },
	};
	ctx.exportResolver = createExportResolver(ctx);
	return ctx;
}

export function importEdgeTarget(target: ResolvedTarget): NodeId | null {
	switch (target.kind) {
		case "file":
		case "types":
			return fileId(target.path);
		case "external":
			return externalId(target.pkg);
		case "unresolved":
			return null;
		case "asset":
			return target.specifier ? unresolvedId(target.specifier) : null;
	}
}
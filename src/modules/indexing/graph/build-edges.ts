import type { NodeId } from "../../../core/ids.js";
import { fileId, parseNodeId } from "../../../core/ids.js";
import { unresolvedId } from "../../../core/ids.js";
import type { FileFacts } from "../extract-file.js";
import type { ImportResolver } from "../resolve/resolve-imports.js";
import {
	bindArgIdentifier,
	bindCallee,
	bindComponent,
	bindRefName,
	createGraphBindContext,
	importEdgeTarget,
	isConstTarget,
	nodeFilePath,
	type GraphBindContext,
} from "./bind.js";
import type {
	CallBindingStats,
	EdgeRow,
	ExportTarget,
	GraphBuildResult,
	GraphEdgeType,
	MemberUnboundBreakdown,
} from "./types.js";

function cmpString(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function edgeKey(e: EdgeRow): string {
	return `${e.src}|${e.dst}|${e.type}|${e.path}|${e.line}`;
}

function pushEdge(edges: EdgeRow[], seen: Set<string>, row: EdgeRow): void {
	const key = edgeKey(row);
	if (seen.has(key)) return;
	seen.add(key);
	edges.push(row);
}

function targetToNode(target: ExportTarget | null): NodeId | null {
	if (!target || target.kind === "unresolved") return null;
	return target.id;
}

function sortEdges(edges: EdgeRow[]): EdgeRow[] {
	return [...edges].sort(
		(a, b) =>
			cmpString(a.path, b.path) ||
			a.line - b.line ||
			cmpString(a.type, b.type) ||
			cmpString(a.src, b.src) ||
			cmpString(a.dst, b.dst),
	);
}

function countByType(edges: EdgeRow[]): Record<GraphEdgeType, number> {
	const out: Record<GraphEdgeType, number> = {
		contains: 0,
		imports: 0,
		calls: 0,
		uses_hook: 0,
		references: 0,
		flows_into: 0,
		renders: 0,
	};
	for (const e of edges) out[e.type]++;
	return out;
}

function computeInDegree(edges: EdgeRow[]): Map<NodeId, number> {
	const types = new Set<GraphEdgeType>(["calls", "references", "renders"]);
	const inDegree = new Map<NodeId, number>();
	for (const e of edges) {
		if (!types.has(e.type)) continue;
		inDegree.set(e.dst, (inDegree.get(e.dst) ?? 0) + 1);
	}
	return inDegree;
}

function isExternalOrUnresolved(id: NodeId): boolean {
	const s = String(id);
	return s.startsWith("external:") || s.startsWith("unresolved:");
}

function computeHubs(inDegree: Map<NodeId, number>, limit = 20, internalOnly = false): { id: NodeId; inDegree: number }[] {
	return [...inDegree.entries()]
		.filter(([id]) => !internalOnly || !isExternalOrUnresolved(id))
		.sort((a, b) => b[1] - a[1] || cmpString(a[0], b[0]))
		.slice(0, limit)
		.map(([id, degree]) => ({ id, inDegree: degree }));
}

function emptyMemberBreakdown(): MemberUnboundBreakdown {
	return {
		root_external: 0,
		root_imported_class: 0,
		root_new_local: 0,
		root_this_field: 0,
		root_param_or_local: 0,
		other: 0,
	};
}

function bindingRatePct(stats: CallBindingStats): number {
	const denom = stats.bound + stats.memberUnbound + stats.unresolvedImport;
	if (denom === 0) return 100;
	return Number(((stats.bound / denom) * 100).toFixed(2));
}

function internalBindingRatePct(stats: CallBindingStats): number {
	const b = stats.memberUnboundBreakdown;
	const denom =
		stats.bound +
		b.root_imported_class +
		b.root_new_local +
		b.root_this_field +
		b.root_param_or_local +
		b.other +
		stats.unresolvedImport;
	if (denom === 0) return 100;
	return Number(((stats.bound / denom) * 100).toFixed(2));
}

/** Same as internalBindingRatePct but excludes `root_param_or_local` (domain receivers). */
export function bindableMemberRatePct(stats: CallBindingStats): number {
	const b = stats.memberUnboundBreakdown;
	const denom =
		stats.bound +
		b.root_imported_class +
		b.root_new_local +
		b.root_this_field +
		b.other +
		stats.unresolvedImport;
	if (denom === 0) return 100;
	return Number(((stats.bound / denom) * 100).toFixed(2));
}

function addContains(ctx: GraphBindContext, edges: EdgeRow[], seen: Set<string>): void {
	for (const [path, facts] of ctx.factsByPath) {
		const file = fileId(path);
		const classMethods = new Map<string, { id: NodeId; line: number }[]>();
		const classes = new Map<string, { id: NodeId; line: number }>();
		for (const sym of facts.symbols) {
			const id = sym.id as NodeId;
			pushEdge(edges, seen, { src: file, dst: id, type: "contains", path, line: sym.lineStart });
			const dot = sym.qualifiedName.indexOf(".");
			if (dot >= 0) {
				const cls = sym.qualifiedName.slice(0, dot);
				const list = classMethods.get(cls) ?? [];
				list.push({ id, line: sym.lineStart });
				classMethods.set(cls, list);
				continue;
			}
			if (sym.kind === "class") classes.set(sym.name, { id, line: sym.lineStart });
		}
		for (const [clsName, methods] of classMethods) {
			const cls = classes.get(clsName);
			if (!cls) continue;
			for (const m of methods) {
				pushEdge(edges, seen, {
					src: cls.id,
					dst: m.id,
					type: "contains",
					path,
					line: m.line,
				});
			}
		}
	}
}

function addImports(ctx: GraphBindContext, edges: EdgeRow[], seen: Set<string>): void {
	for (const [path, facts] of ctx.factsByPath) {
		const file = fileId(path);
		const resolved = ctx.resolvedByFile.get(path) ?? [];
		for (let i = 0; i < facts.imports.length; i++) {
			const imp = facts.imports[i]!;
			const row = resolved[i];
			if (!row) continue;
			let dst = importEdgeTarget(row.target);
			if (row.target.kind === "unresolved" && imp.specifier) dst = unresolvedId(imp.specifier);
			if (!dst) continue;
			const typeOnly = row.target.kind === "types" || imp.typeOnly || row.typeOnly;
			pushEdge(edges, seen, {
				src: file,
				dst,
				type: "imports",
				path,
				line: imp.line,
				meta: {
					specifier: imp.specifier ?? undefined,
					typeOnly: typeOnly || undefined,
					dynamic: imp.kind === "dynamic" || undefined,
				},
			});
		}
	}
}

function callEdgeType(ctx: GraphBindContext, target: NodeId): GraphEdgeType {
	const kind = ctx.scopes.get(nodeFilePath(target))?.symbolKind.get(target);
	return kind === "hook" ? "uses_hook" : "calls";
}

function addUsages(ctx: GraphBindContext, edges: EdgeRow[], seen: Set<string>, callBinding: CallBindingStats): void {
	for (const [path, facts] of ctx.factsByPath) {
		const scope = ctx.scopes.get(path)!;
		for (const call of facts.calls) {
			const { target, category, memberBucket } = bindCallee(ctx, scope, ctx.exportResolver, call);
			if (category === "bound") callBinding.bound++;
			else if (category === "global") callBinding.global++;
			else if (category === "member_unbound") {
				callBinding.memberUnbound++;
				const bucket = memberBucket ?? "other";
				callBinding.memberUnboundBreakdown[bucket]++;
			} else callBinding.unresolvedImport++;
			const dst = targetToNode(target);
			if (dst) {
				pushEdge(edges, seen, {
					src: call.fromId,
					dst,
					type: callEdgeType(ctx, dst),
					path,
					line: call.line,
				});
				for (const arg of call.args) {
					const argTarget = bindArgIdentifier(ctx, scope, ctx.exportResolver, arg);
					if (!isConstTarget(ctx, argTarget)) continue;
					const argNode = targetToNode(argTarget);
					if (!argNode) continue;
					pushEdge(edges, seen, {
						src: argNode,
						dst,
						type: "flows_into",
						path,
						line: call.line,
						meta: { argIndex: arg.index },
					});
				}
			}
		}

		for (const ref of facts.refs) {
			const refPath = nodeFilePath(ref.fromId) || path;
			const refScope = ctx.scopes.get(refPath) ?? scope;
			const bound = bindRefName(ctx, refScope, ctx.exportResolver, ref.name);
			const dst = targetToNode(bound);
			if (!dst) continue;
			pushEdge(edges, seen, {
				src: ref.fromId,
				dst,
				type: "references",
				path: refPath,
				line: ref.line,
				meta: { role: ref.role },
			});
		}

		for (const render of facts.renders) {
			const bound = bindComponent(ctx, scope, ctx.exportResolver, render);
			const dst = targetToNode(bound);
			if (!dst) continue;
			const componentKind = scope.symbolKind.get(dst);
			const parsed = parseNodeId(dst);
			const remoteKind =
				parsed.kind === "symbol" ? ctx.scopes.get(parsed.repoPath)?.symbolKind.get(dst) : undefined;
			const kind = componentKind ?? remoteKind;
			if (kind !== "component" && kind !== "function" && kind !== "hook") continue;
			pushEdge(edges, seen, {
				src: render.fromId,
				dst,
				type: "renders",
				path,
				line: render.line,
				meta: render.props.length ? { props: render.props } : undefined,
			});
		}
	}
}

export function buildEdgesFromContext(ctx: GraphBindContext): GraphBuildResult {
	const edges: EdgeRow[] = [];
	const seen = new Set<string>();
	const callBinding: CallBindingStats = {
		bound: 0,
		global: 0,
		memberUnbound: 0,
		unresolvedImport: 0,
		memberUnboundBreakdown: emptyMemberBreakdown(),
	};

	addContains(ctx, edges, seen);
	addImports(ctx, edges, seen);
	addUsages(ctx, edges, seen, callBinding);

	const sorted = sortEdges(edges);
	const inDegree = computeInDegree(sorted);
	return {
		edges: sorted,
		edgesByType: countByType(sorted),
		callBinding,
		bindingRatePct: bindingRatePct(callBinding),
		internalBindingRatePct: internalBindingRatePct(callBinding),
		inDegree,
		hubs: computeHubs(inDegree, 20, true),
		topExternalHubs: computeHubs(inDegree, 200).filter((h) => isExternalOrUnresolved(h.id)).slice(0, 20),
	};
}

export function buildEdges(factsByPath: Map<string, FileFacts>, resolver: ImportResolver): GraphBuildResult {
	return buildEdgesFromContext(createGraphBindContext(factsByPath, resolver));
}

export function edgesPerFile(edges: EdgeRow[]): { path: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const e of edges) counts.set(e.path, (counts.get(e.path) ?? 0) + 1);
	return [...counts.entries()]
		.sort((a, b) => cmpString(a[0], b[0]))
		.map(([path, count]) => ({ path, count }));
}
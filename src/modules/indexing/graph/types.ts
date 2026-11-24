import type { NodeId } from "../../../core/ids.js";
import type { RelationType } from "../../../core/types.js";

export type GraphEdgeType = Extract<
	RelationType,
	"contains" | "imports" | "calls" | "uses_hook" | "references" | "flows_into" | "renders"
>;

export type EdgeMeta = {
	specifier?: string;
	typeOnly?: boolean;
	dynamic?: boolean;
	role?: "argument" | "value";
	argIndex?: number;
	props?: string[];
};

export interface EdgeRow {
	src: NodeId;
	dst: NodeId;
	type: GraphEdgeType;
	path: string;
	line: number;
	meta?: EdgeMeta;
}

export type ExportTarget =
	| { kind: "symbol"; id: NodeId }
	| { kind: "module"; id: NodeId }
	| { kind: "external"; id: NodeId }
	| { kind: "unresolved" };

export type MemberUnboundBucket =
	| "root_external"
	| "root_imported_class"
	| "root_new_local"
	| "root_this_field"
	| "root_param_or_local"
	| "other";

export type MemberUnboundBreakdown = Record<MemberUnboundBucket, number>;

export interface CallBindingStats {
	bound: number;
	global: number;
	memberUnbound: number;
	unresolvedImport: number;
	memberUnboundBreakdown: MemberUnboundBreakdown;
}

export interface GraphBuildResult {
	edges: EdgeRow[];
	edgesByType: Record<GraphEdgeType, number>;
	callBinding: CallBindingStats;
	bindingRatePct: number;
	internalBindingRatePct: number;
	topExternalHubs: { id: NodeId; inDegree: number }[];
	inDegree: Map<NodeId, number>;
	hubs: { id: NodeId; inDegree: number }[];
}
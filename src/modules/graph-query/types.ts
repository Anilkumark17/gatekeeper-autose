export interface QueryOpts {
	types?: string[];
	limit?: number;
}

export interface DependentEdge {
	src: string;
	type: string;
	line: number;
}

export interface DependencyEdge {
	dst: string;
	type: string;
	line: number;
}

export interface WalkVia {
	from: string;
	type: string;
	line: number;
}

export interface WalkNode {
	id: string;
	depth: number;
	via?: WalkVia;
}

export interface WalkOpts {
	direction: "in" | "out";
	types?: string[];
	maxDepth?: number;
	maxNodes?: number;
}

export interface WalkResult {
	nodes: WalkNode[];
	truncated: boolean;
}

export interface PathEdge {
	src: string;
	dst: string;
	type: string;
	line: number;
}

export interface PathOpts {
	types?: string[];
	maxDepth?: number;
}

export interface FindByNameOpts {
	kind?: string;
	limit?: number;
}

export interface NameMatch {
	id: string;
	kind: string;
	name: string;
	path: string;
	exported: boolean;
}

export interface LevelEdge {
	src: string;
	dst: string;
	type: string;
	line: number;
}
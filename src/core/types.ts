export const entityKinds = [
	"folder",
	"file",
	"function",
	"class",
	"method",
	"const",
	"component",
	"hook",
	"test",
	"external",
] as const;

export type EntityKind = (typeof entityKinds)[number];

export const relationTypes = [
	"contains",
	"imports",
	"calls",
	"references",
	"flows_into",
	"renders",
	"passes_prop",
	"uses_hook",
	"tests",
	"constrains",
] as const;

export type RelationType = (typeof relationTypes)[number];

export type SupportedLanguage = "javascript" | "typescript" | "tsx";

export type Dir = string;

export type RepoRow = {
	id: string;
	root: string;
	name: string;
	createdAt: Date;
	graphVersion: number;
};

export type FileRow = {
	repoId: string;
	path: string;
	pkg: string | null;
	contentHash: string | null;
	size: number | null;
	skipped: boolean;
	error: string | null;
	indexedAt: Date | null;
};

export type NodeRow = {
	repoId: string;
	id: string;
	kind: EntityKind | string;
	name: string;
	path: string;
	lineStart: number;
	lineEnd: number;
	exported: boolean;
	bodyHash: string | null;
	exportHash: string | null;
	lastChangeSha: string | null;
	lastChangeAt: Date | null;
	inDegree: number;
};

export type EdgeRow = {
	repoId: string;
	src: string;
	dst: string;
	type: RelationType | string;
	path: string;
	line: number;
	meta: Record<string, unknown> | null;
};

export type ContractRow = {
	repoId: string;
	id: string;
	type: string;
	text: string;
	attachedTo: string;
	source: string;
	status: string;
};

export type SearchDocRow = {
	repoId: string;
	nodeId: string;
	tsv: string;
	bodyHash: string;
};

export type Subgraph = {
	nodes: NodeRow[];
	edges: EdgeRow[];
};

export type WalkOptions = {
	maxDepth?: number;
	followSymlinks?: boolean;
};

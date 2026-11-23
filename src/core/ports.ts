import type { ContractRow, EdgeRow, FileRow, NodeRow, RepoRow, SearchDocRow } from "./types.js";

export interface GraphStore {
	insertRepo(repo: RepoRow): Promise<void>;
	upsertFiles(files: FileRow[]): Promise<void>;
	replaceNodes(nodes: NodeRow[]): Promise<void>;
	replaceEdges(edges: EdgeRow[]): Promise<void>;
}

export interface SearchIndex {
	upsertDocs(docs: SearchDocRow[]): Promise<void>;
}

export interface ContractStore {
	upsertContracts(contracts: ContractRow[]): Promise<void>;
}

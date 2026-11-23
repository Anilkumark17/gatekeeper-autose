import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { AppError } from "./errors.js";

export type NodeId = string & { readonly __brand: "NodeId" };

export function newRepoId(): string {
	return randomUUID();
}

export function newNodeId(): string {
	return randomUUID();
}

export function sha256Hex(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}

export function toRepoPath(repoRoot: string, absOrRel: string): string {
	const normalizedRoot = path.resolve(repoRoot);
	const absolute = path.isAbsolute(absOrRel) ? absOrRel : path.join(normalizedRoot, absOrRel);
	const relative = path.relative(normalizedRoot, path.resolve(absolute));
	const posix = relative.split(path.sep).join("/");
	const stripped = posix.replace(/^\.\//, "");
	if (stripped.startsWith("../") || stripped === "..") {
		throw new AppError(`Path escapes repository root: ${absOrRel}`, "PATH_OUTSIDE_REPO");
	}
	return stripped;
}

export function asNodeId(value: string): NodeId {
	return value as NodeId;
}

export function fileId(repoPath: string): NodeId {
	return asNodeId(repoPath);
}

export function folderId(dir: string): NodeId {
	const normalized = dir.endsWith("/") ? dir : `${dir}/`;
	return asNodeId(normalized);
}

export function symbolId(repoPath: string, qualifiedName: string): NodeId {
	return asNodeId(`${repoPath}#${qualifiedName}`);
}

export function externalId(pkg: string): NodeId {
	return asNodeId(`external:${pkg}`);
}

export function unresolvedId(spec: string): NodeId {
	return asNodeId(`unresolved:${spec}`);
}

export type ParsedNodeId =
	| { kind: "symbol"; repoPath: string; qualifiedName: string; id: NodeId }
	| { kind: "file"; repoPath: string; id: NodeId }
	| { kind: "folder"; dir: string; id: NodeId }
	| { kind: "external"; pkg: string; id: NodeId }
	| { kind: "unresolved"; spec: string; id: NodeId };

export function parseNodeId(id: string): ParsedNodeId {
	const nodeId = asNodeId(id);
	if (id.startsWith("external:")) {
		return { kind: "external", pkg: id.slice("external:".length), id: nodeId };
	}
	if (id.startsWith("unresolved:")) {
		return { kind: "unresolved", spec: id.slice("unresolved:".length), id: nodeId };
	}
	const hash = id.indexOf("#");
	if (hash >= 0) {
		return {
			kind: "symbol",
			repoPath: id.slice(0, hash),
			qualifiedName: id.slice(hash + 1),
			id: nodeId,
		};
	}
	if (id.endsWith("/")) {
		return { kind: "folder", dir: id, id: nodeId };
	}
	return { kind: "file", repoPath: id, id: nodeId };
}

export function isResolved(id: string): boolean {
	return !id.startsWith("external:") && !id.startsWith("unresolved:");
}

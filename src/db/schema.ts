import {
	bigint,
	boolean,
	char,
	customType,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({
	dataType() {
		return "tsvector";
	},
});

export const repos = pgTable("repos", {
	id: text("id").primaryKey(),
	root: text("root").notNull(),
	name: text("name").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
	graphVersion: bigint("graph_version", { mode: "number" }).notNull().default(0),
});

export const files = pgTable(
	"files",
	{
		repoId: text("repo_id")
			.notNull()
			.references(() => repos.id),
		path: text("path").notNull(),
		pkg: text("pkg"),
		contentHash: char("content_hash", { length: 64 }),
		size: integer("size"),
		skipped: boolean("skipped").notNull().default(false),
		error: text("error"),
		indexedAt: timestamp("indexed_at", { withTimezone: true, mode: "date" }),
	},
	(table) => [primaryKey({ columns: [table.repoId, table.path] })],
);

export const nodes = pgTable(
	"nodes",
	{
		repoId: text("repo_id")
			.notNull()
			.references(() => repos.id),
		id: text("id").notNull(),
		kind: text("kind").notNull(),
		name: text("name").notNull(),
		path: text("path").notNull(),
		lineStart: integer("line_start").notNull(),
		lineEnd: integer("line_end").notNull(),
		exported: boolean("exported").notNull().default(false),
		bodyHash: char("body_hash", { length: 64 }),
		exportHash: char("export_hash", { length: 64 }),
		lastChangeSha: text("last_change_sha"),
		lastChangeAt: timestamp("last_change_at", { withTimezone: true, mode: "date" }),
		inDegree: integer("in_degree").notNull().default(0),
	},
	(table) => [primaryKey({ columns: [table.repoId, table.id] })],
);

export const edges = pgTable(
	"edges",
	{
		repoId: text("repo_id")
			.notNull()
			.references(() => repos.id),
		src: text("src").notNull(),
		dst: text("dst").notNull(),
		type: text("type").notNull(),
		path: text("path").notNull(),
		line: integer("line").notNull(),
		meta: jsonb("meta"),
	},
	(table) => [
		primaryKey({
			columns: [table.repoId, table.src, table.dst, table.type, table.path, table.line],
		}),
		index("edges_repo_dst_type_idx").on(table.repoId, table.dst, table.type),
		index("edges_repo_src_type_idx").on(table.repoId, table.src, table.type),
		index("edges_repo_path_idx").on(table.repoId, table.path),
	],
);

export const contracts = pgTable(
	"contracts",
	{
		repoId: text("repo_id")
			.notNull()
			.references(() => repos.id),
		id: text("id").notNull(),
		type: text("type").notNull(),
		text: text("text").notNull(),
		attachedTo: text("attached_to").notNull(),
		source: text("source").notNull(),
		status: text("status").notNull(),
	},
	(table) => [primaryKey({ columns: [table.repoId, table.id] })],
);

export const fileRecency = pgTable(
	"file_recency",
	{
		repoId: text("repo_id")
			.notNull()
			.references(() => repos.id, { onDelete: "cascade" }),
		path: text("path").notNull(),
		lastSha: text("last_sha").notNull(),
		lastAt: timestamp("last_at", { withTimezone: true, mode: "date" }).notNull(),
		atBoundary: boolean("at_boundary").notNull().default(false),
	},
	(table) => [primaryKey({ columns: [table.repoId, table.path] })],
);

export const searchDocs = pgTable(
	"search_docs",
	{
		repoId: text("repo_id")
			.notNull()
			.references(() => repos.id),
		nodeId: text("node_id").notNull(),
		tsv: tsvector("tsv").notNull(),
		bodyHash: char("body_hash", { length: 64 }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.repoId, table.nodeId] }),
		index("search_docs_tsv_gin_idx").using("gin", table.tsv),
	],
);

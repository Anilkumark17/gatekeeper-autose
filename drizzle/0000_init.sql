CREATE TABLE "repos" (
	"id" text PRIMARY KEY NOT NULL,
	"root" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"graph_version" integer DEFAULT 0 NOT NULL
);

CREATE TABLE "files" (
	"repo_id" text NOT NULL,
	"path" text NOT NULL,
	"pkg" text,
	"content_hash" char(64),
	"size" integer,
	"skipped" boolean DEFAULT false NOT NULL,
	"error" text,
	"indexed_at" timestamp with time zone,
	CONSTRAINT "files_repo_id_path_pk" PRIMARY KEY("repo_id","path")
);

ALTER TABLE "files" ADD CONSTRAINT "files_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;

CREATE TABLE "nodes" (
	"repo_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"line_start" integer NOT NULL,
	"line_end" integer NOT NULL,
	"exported" boolean DEFAULT false NOT NULL,
	"body_hash" char(64),
	"export_hash" char(64),
	"last_change_sha" text,
	"last_change_at" timestamp with time zone,
	"in_degree" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "nodes_repo_id_id_pk" PRIMARY KEY("repo_id","id")
);

ALTER TABLE "nodes" ADD CONSTRAINT "nodes_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;

CREATE TABLE "edges" (
	"repo_id" text NOT NULL,
	"src" text NOT NULL,
	"dst" text NOT NULL,
	"type" text NOT NULL,
	"path" text NOT NULL,
	"line" integer NOT NULL,
	"meta" jsonb,
	CONSTRAINT "edges_repo_id_src_dst_type_path_line_pk" PRIMARY KEY("repo_id","src","dst","type","path","line")
);

CREATE INDEX "edges_repo_dst_type_idx" ON "edges" USING btree ("repo_id","dst","type");
CREATE INDEX "edges_repo_src_type_idx" ON "edges" USING btree ("repo_id","src","type");
CREATE INDEX "edges_repo_path_idx" ON "edges" USING btree ("repo_id","path");

ALTER TABLE "edges" ADD CONSTRAINT "edges_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;

CREATE TABLE "contracts" (
	"repo_id" text NOT NULL,
	"id" text NOT NULL,
	"type" text NOT NULL,
	"text" text NOT NULL,
	"attached_to" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "contracts_repo_id_id_pk" PRIMARY KEY("repo_id","id")
);

ALTER TABLE "contracts" ADD CONSTRAINT "contracts_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;

CREATE TABLE "search_docs" (
	"repo_id" text NOT NULL,
	"node_id" text NOT NULL,
	"tsv" tsvector NOT NULL,
	"body_hash" char(64) NOT NULL,
	CONSTRAINT "search_docs_repo_id_node_id_pk" PRIMARY KEY("repo_id","node_id")
);

CREATE INDEX "search_docs_tsv_gin_idx" ON "search_docs" USING gin ("tsv");

ALTER TABLE "search_docs" ADD CONSTRAINT "search_docs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE no action ON UPDATE no action;

CREATE UNLOGGED TABLE "stage_nodes" (
	"repo_id" text NOT NULL,
	"id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"line_start" integer NOT NULL,
	"line_end" integer NOT NULL,
	"exported" boolean DEFAULT false NOT NULL,
	"body_hash" char(64),
	"export_hash" char(64),
	"last_change_sha" text,
	"last_change_at" timestamp with time zone,
	"in_degree" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "stage_nodes_repo_id_id_pk" PRIMARY KEY("repo_id","id")
);

CREATE UNLOGGED TABLE "stage_edges" (
	"repo_id" text NOT NULL,
	"src" text NOT NULL,
	"dst" text NOT NULL,
	"type" text NOT NULL,
	"path" text NOT NULL,
	"line" integer NOT NULL,
	"meta" jsonb,
	CONSTRAINT "stage_edges_repo_id_src_dst_type_path_line_pk" PRIMARY KEY("repo_id","src","dst","type","path","line")
);
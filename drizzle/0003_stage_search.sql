CREATE UNLOGGED TABLE IF NOT EXISTS "stage_search" (
	"repo_id" text NOT NULL,
	"node_id" text NOT NULL,
	"name_tokens" text NOT NULL,
	"path_tokens" text NOT NULL,
	CONSTRAINT "stage_search_repo_id_node_id_pk" PRIMARY KEY("repo_id","node_id")
);
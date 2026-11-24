CREATE TABLE IF NOT EXISTS "file_recency" (
	"repo_id" text NOT NULL,
	"path" text NOT NULL,
	"last_sha" text NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"at_boundary" boolean NOT NULL DEFAULT false,
	CONSTRAINT "file_recency_repo_id_path_pk" PRIMARY KEY ("repo_id", "path")
);

ALTER TABLE "file_recency" ADD CONSTRAINT "file_recency_repo_id_repos_id_fk"
  FOREIGN KEY ("repo_id") REFERENCES "public"."repos" ("id") ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE UNLOGGED TABLE IF NOT EXISTS "stage_file_recency" (
	"repo_id" text NOT NULL,
	"path" text NOT NULL,
	"last_sha" text NOT NULL,
	"last_at" timestamp with time zone NOT NULL,
	"at_boundary" boolean NOT NULL DEFAULT false,
	CONSTRAINT "stage_file_recency_repo_id_path_pk" PRIMARY KEY ("repo_id", "path")
);
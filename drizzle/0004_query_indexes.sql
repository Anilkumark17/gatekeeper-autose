DROP INDEX IF EXISTS "edges_repo_dst_type_idx";
CREATE INDEX "edges_repo_dst_type_idx" ON "edges" USING btree ("repo_id", "dst", "type") INCLUDE ("src", "line");

DROP INDEX IF EXISTS "edges_repo_src_type_idx";
CREATE INDEX "edges_repo_src_type_idx" ON "edges" USING btree ("repo_id", "src", "type") INCLUDE ("dst", "line");

CREATE INDEX IF NOT EXISTS "nodes_repo_name_pattern_idx" ON "nodes" USING btree ("repo_id", "name" text_pattern_ops);
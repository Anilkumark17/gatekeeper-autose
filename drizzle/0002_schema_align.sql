ALTER TABLE "repos" ALTER COLUMN "graph_version" SET DATA TYPE bigint;
--> statement-breakpoint
ALTER TABLE "repos" ALTER COLUMN "graph_version" SET DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_source_chk" CHECK ("source" IN ('doc', 'test', 'code', 'agent', 'user'));
--> statement-breakpoint
ALTER TABLE "contracts" ADD CONSTRAINT "contracts_status_chk" CHECK ("status" IN ('declared', 'verified', 'violated', 'unmapped'));
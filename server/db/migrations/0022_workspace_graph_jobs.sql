-- The knowledge graph is workspace-wide: nodes, edges and communities outlive
-- the run that first wrote them, so deleting a run must not cascade them away.
ALTER TABLE "kg_nodes" ALTER COLUMN "run_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "kg_nodes" DROP CONSTRAINT "kg_nodes_run_id_fkey";
--> statement-breakpoint
ALTER TABLE "kg_nodes" ADD CONSTRAINT "kg_nodes_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_edges" ALTER COLUMN "run_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "kg_edges" DROP CONSTRAINT "kg_edges_run_id_fkey";
--> statement-breakpoint
ALTER TABLE "kg_edges" ADD CONSTRAINT "kg_edges_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_communities" ALTER COLUMN "run_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "kg_communities" DROP CONSTRAINT "kg_communities_run_id_fkey";
--> statement-breakpoint
ALTER TABLE "kg_communities" ADD CONSTRAINT "kg_communities_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."workspace_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
-- Stable fingerprint of a community's members, so unchanged communities keep
-- their summary and vector when the workspace graph is re-clustered.
ALTER TABLE "kg_communities" ADD COLUMN "member_hash" text;
--> statement-breakpoint
-- Per-document support for an edge. Edge weight is the sum of its evidence,
-- so re-extracting a document replaces exactly that document's contribution.
CREATE TABLE "kg_edge_evidence" (
	"edge_id" text NOT NULL,
	"document_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"confidence" numeric(5, 4) DEFAULT '0.5' NOT NULL,
	CONSTRAINT "kg_edge_evidence_pkey" PRIMARY KEY("edge_id","document_id")
);
--> statement-breakpoint
ALTER TABLE "kg_edge_evidence" ADD CONSTRAINT "kg_edge_evidence_edge_id_fkey" FOREIGN KEY ("edge_id") REFERENCES "public"."kg_edges"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_edge_evidence" ADD CONSTRAINT "kg_edge_evidence_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_edge_evidence" ADD CONSTRAINT "kg_edge_evidence_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "kg_edge_evidence_document_idx" ON "kg_edge_evidence" USING btree ("document_id");
--> statement-breakpoint
-- Which graph settings each document was last extracted with, so the
-- workspace can tell covered, stale and missing documents apart.
CREATE TABLE "kg_document_state" (
	"document_id" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"config_hash" text NOT NULL,
	"source" text NOT NULL,
	"windows" integer DEFAULT 0 NOT NULL,
	"entities" integer DEFAULT 0 NOT NULL,
	"relationships" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "kg_document_state_source_check" CHECK ("source" IN ('llm', 'heuristic'))
);
--> statement-breakpoint
ALTER TABLE "kg_document_state" ADD CONSTRAINT "kg_document_state_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "kg_document_state" ADD CONSTRAINT "kg_document_state_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "kg_document_state_workspace_idx" ON "kg_document_state" USING btree ("workspace_id","config_hash");
--> statement-breakpoint
-- Workspace graph rebuilds: re-extract stale (or all) current documents from
-- stored chunks without re-parsing, then re-cluster communities.
CREATE TABLE "graph_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"phase" text DEFAULT 'queued' NOT NULL,
	"config" jsonb NOT NULL,
	"config_hash" text NOT NULL,
	"model" text NOT NULL,
	"estimate" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"max_cost_cents" numeric(12, 4),
	"documents_total" integer DEFAULT 0 NOT NULL,
	"documents_processed" integer DEFAULT 0 NOT NULL,
	"documents_failed" integer DEFAULT 0 NOT NULL,
	"windows_processed" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" numeric(12, 4) DEFAULT 0 NOT NULL,
	"cursor" text,
	"error" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "graph_jobs_mode_check" CHECK ("mode" IN ('stale', 'full')),
	CONSTRAINT "graph_jobs_status_check" CHECK ("status" IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "graph_jobs_phase_check" CHECK ("phase" IN ('queued', 'extracting', 'communities', 'done'))
);
--> statement-breakpoint
ALTER TABLE "graph_jobs" ADD CONSTRAINT "graph_jobs_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "graph_jobs" ADD CONSTRAINT "graph_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "graph_jobs" ADD CONSTRAINT "graph_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "graph_jobs_one_active_per_workspace" ON "graph_jobs" USING btree ("workspace_id") WHERE "status" IN ('queued', 'running');
--> statement-breakpoint
CREATE INDEX "graph_jobs_claim_idx" ON "graph_jobs" USING btree ("status","created_at");
--> statement-breakpoint
CREATE INDEX "graph_jobs_workspace_idx" ON "graph_jobs" USING btree ("workspace_id","created_at");

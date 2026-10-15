-- LanceDB write queue (docs/scaling-1000-workers.md, "Vector index writes").
-- One LanceDB table per org and embedding model takes every document's chunks.
-- Lance commits are optimistic, so 128 slots writing one table directly failed
-- runs with "Too many concurrent writers". Instead, each document enqueues one
-- outbox row pointing at its embedding artifact, and the single holder of the
-- table's write lease drains all pending rows into one merge-insert commit.
-- Row leases rather than advisory locks: session locks do not survive a
-- transaction-mode pooler.
CREATE TABLE IF NOT EXISTS "vector_index_outbox" (
  "id" bigserial PRIMARY KEY NOT NULL,
  -- <lance uri>#<table>: the physical Lance table the rows go to.
  "table_key" text NOT NULL,
  "lance_uri" text NOT NULL,
  "lance_table" text NOT NULL,
  "org_id" text,
  "document_id" text NOT NULL,
  "run_id" text,
  -- Object-storage key of the document's embedding artifact (chunks + vectors).
  "artifact_key" text NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "record_count" integer DEFAULT 0 NOT NULL,
  -- Bumped on every re-enqueue so a drain of an older payload cannot mark a newer one written.
  "generation" integer DEFAULT 1 NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "enqueued_at" timestamptz DEFAULT now() NOT NULL,
  "written_at" timestamptz,
  CONSTRAINT "vector_index_outbox_status_check" CHECK ("status" IN ('pending', 'written', 'failed')),
  CONSTRAINT "vector_index_outbox_table_document_unique" UNIQUE ("table_key", "document_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vector_index_outbox_pending_idx"
  ON "vector_index_outbox" ("table_key", "id") WHERE "status" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vector_index_outbox_written_idx"
  ON "vector_index_outbox" ("table_key", "written_at") WHERE "status" = 'written';
--> statement-breakpoint
-- One row per Lance table: the write lease (one drainer fleet-wide), the
-- maintenance lease (one optimize/cleanup fleet-wide) and the counters that
-- decide when maintenance is due.
CREATE TABLE IF NOT EXISTS "vector_index_tables" (
  "table_key" text PRIMARY KEY NOT NULL,
  "write_holder" text,
  "write_expires_at" timestamptz DEFAULT now() NOT NULL,
  "maint_holder" text,
  "maint_expires_at" timestamptz DEFAULT now() NOT NULL,
  "rows_since_optimize" bigint DEFAULT 0 NOT NULL,
  "commits_since_optimize" integer DEFAULT 0 NOT NULL,
  "last_drained_at" timestamptz,
  "last_optimized_at" timestamptz,
  "last_maintenance_error" text,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);

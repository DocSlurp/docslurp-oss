-- Extract mode: uploads whose files and derived assets live under
-- extracts/<org>/<extract>/ and are deleted when the retention window ends.
-- See docs/extract.md.
--
-- extracts is the durable expiry record. It is deliberately not a foreign key
-- target or child: workspace, run and user deletion must not cascade it away,
-- because the row is what names the storage prefix the sweeper still has to
-- empty, and it keeps the extract's usage measurable after its run is gone.
CREATE TABLE IF NOT EXISTS extracts (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  workspace_id text NOT NULL,
  user_id text NOT NULL,
  api_key_id text,
  -- Set when intake creates the run (one run per extract).
  run_id text,
  -- extracts/<org_id>/<id>; every object the extract writes is under it.
  storage_prefix text NOT NULL UNIQUE,
  -- active: being processed or kept; deleting: past expiry, cleanup started; deleted: nothing left.
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deleting', 'deleted')),
  retention_hours integer NOT NULL CHECK (retention_hours > 0),
  paid_retention boolean NOT NULL DEFAULT false,
  expires_at timestamp with time zone NOT NULL,
  notify_email boolean NOT NULL DEFAULT true,
  download_content text NOT NULL DEFAULT 'markdown' CHECK (download_content IN ('markdown', 'all')),
  -- The run finished (completed or failed) and the extract was settled: stored size measured, retention charged, export queued.
  completed_at timestamp with time zone,
  run_status text,
  pages integer,
  stored_bytes bigint,
  retention_credits numeric(24, 12),
  charged_at timestamp with time zone,
  export_id text,
  -- No download is built (the run produced no completed document); the email reports the failure.
  export_skipped boolean NOT NULL DEFAULT false,
  emailed_at timestamp with time zone,
  email_attempts integer NOT NULL DEFAULT 0,
  next_email_at timestamp with time zone,
  -- Deletion progress and metrics.
  deletion_started_at timestamp with time zone,
  -- Objects are listed and deleted only after this (a grace period for late writes of a cancelled run).
  purge_after timestamp with time zone,
  deleted_at timestamp with time zone,
  deleted_objects bigint NOT NULL DEFAULT 0,
  deleted_bytes bigint NOT NULL DEFAULT 0,
  deletion_attempts integer NOT NULL DEFAULT 0,
  -- One sweeper instance works on an extract at a time; a crashed one's lease runs out.
  lease_expires_at timestamp with time zone,
  last_error text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS extracts_expiry_idx ON extracts (expires_at) WHERE state <> 'deleted';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS extracts_settle_idx ON extracts (created_at) WHERE state = 'active' AND completed_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS extracts_email_idx ON extracts (next_email_at) WHERE notify_email AND emailed_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS extracts_org_created_idx ON extracts (org_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS extracts_run_idx ON extracts (run_id) WHERE run_id IS NOT NULL;
--> statement-breakpoint
-- An extract run writes its artifacts under storage_prefix instead of <user>/<run>/,
-- and extract_id separates its usage and cost in reporting.
ALTER TABLE workspace_runs ADD COLUMN IF NOT EXISTS extract_id text;
--> statement-breakpoint
ALTER TABLE workspace_runs ADD COLUMN IF NOT EXISTS storage_prefix text;
--> statement-breakpoint
ALTER TABLE workspace_runs DROP CONSTRAINT IF EXISTS workspace_runs_storage_prefix_check;
--> statement-breakpoint
ALTER TABLE workspace_runs ADD CONSTRAINT workspace_runs_storage_prefix_check
  CHECK (storage_prefix IS NULL OR (extract_id IS NOT NULL AND storage_prefix LIKE 'extracts/%' AND storage_prefix NOT LIKE '%/'));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workspace_runs_extract_idx ON workspace_runs (extract_id) WHERE extract_id IS NOT NULL;
--> statement-breakpoint
-- A direct upload session created by POST /v1/extracts/direct/sessions stores its sources under the extract prefix.
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS extract_id text;
--> statement-breakpoint
-- An extract's download is a run-scoped export whose link never outlives the extract.
ALTER TABLE document_exports ADD COLUMN IF NOT EXISTS run_id text;
--> statement-breakpoint
ALTER TABLE document_exports ADD COLUMN IF NOT EXISTS max_expires_at timestamp with time zone;

-- Processing eligibility is explicit. Age only expires abandoned preparation.
ALTER TABLE workspace_runs
  ADD COLUMN IF NOT EXISTS creation_ready_at timestamptz,
  ADD COLUMN IF NOT EXISTS creation_source_keys text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS creation_expires_at timestamptz DEFAULT (now() + interval '5 minutes');
--> statement-breakpoint
-- Existing started/non-queued Runs already belong to processing. Only complete
-- queued manifests can be published; incomplete ones retain a cleanup lease.
UPDATE workspace_runs r
SET creation_ready_at = now(), creation_expires_at = null
WHERE r.creation_ready_at IS NULL
  AND (r.status <> 'queued' OR r.workflow_started_at IS NOT NULL
   OR (r.total_documents > 0 AND r.total_documents = (SELECT count(*) FROM documents d WHERE d.run_id = r.id)));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workspace_runs_creation_pending_idx ON workspace_runs (creation_expires_at)
WHERE creation_ready_at IS NULL AND workflow_started_at IS NULL;

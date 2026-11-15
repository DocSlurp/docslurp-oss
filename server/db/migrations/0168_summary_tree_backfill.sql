-- Summary tree backfill (packages/shared/src/summary-tree.ts, worker/src/summary-tree/backfill-job.ts).
--
-- 1. document_summary_trees.build_owner: who holds a `building` row (`run:<runId>` for a run's own stage,
--    `job:<jobId>` for the backfill job). A build keeps its row alive by touching `updated_at`; a `building` row that
--    has not been touched for SUMMARY_TREE_BUILD_STALE_MS was left by a dead worker and blocks nothing. The owner lets
--    a build notice that another one took its document over, and lets a resumed job recognise its own documents.
--    Neither column is in the readiness trigger's column list (migration 0165), so a heartbeat sends no hint.
ALTER TABLE document_summary_trees ADD COLUMN IF NOT EXISTS build_owner text;
--> statement-breakpoint
-- 2. summary_tree_jobs: builds trees for a project's already indexed documents. A sibling of graph_jobs: leased, so a
--    crashed worker's job resumes elsewhere; a cursor over document ids; cancellable; a mandatory cost cap.
--    `blocked` is a parked job (the deployment's build switch is off, the provider balance probe reports below its
--    floor, the organization may not spend): it holds no lease and is looked at again after `resume_after`.
--    The table holds counters and settings only: no document text and no summary text.
CREATE TABLE IF NOT EXISTS summary_tree_jobs (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'blocked', 'completed', 'failed', 'cancelled')),
  blocked_reason text CHECK (blocked_reason IS NULL OR blocked_reason IN ('build-off', 'balance', 'credits', 'policy')),
  resume_after timestamptz,
  estimate jsonb NOT NULL DEFAULT '{}'::jsonb,
  max_cost_cents numeric(12, 4) NOT NULL CHECK (max_cost_cents > 0),
  documents_total integer NOT NULL DEFAULT 0 CHECK (documents_total >= 0),
  documents_ready integer NOT NULL DEFAULT 0 CHECK (documents_ready >= 0),
  documents_skipped integer NOT NULL DEFAULT 0 CHECK (documents_skipped >= 0),
  documents_partial integer NOT NULL DEFAULT 0 CHECK (documents_partial >= 0),
  nodes_built integer NOT NULL DEFAULT 0 CHECK (nodes_built >= 0),
  model_calls integer NOT NULL DEFAULT 0 CHECK (model_calls >= 0),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_cents numeric(12, 4) NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  -- The last document id the job has finished with; the next batch starts after it.
  cursor text,
  error text,
  lease_owner text,
  lease_expires_at timestamptz,
  cancel_requested_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS summary_tree_jobs_one_active_per_project ON summary_tree_jobs (project_id) WHERE status IN ('queued', 'running', 'blocked');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS summary_tree_jobs_claim_idx ON summary_tree_jobs (status, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS summary_tree_jobs_project_idx ON summary_tree_jobs (project_id, created_at);
--> statement-breakpoint
-- The worker claims and runs the jobs. server/db/roles.mjs reconciles the same grant after every migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_worker') THEN
    REVOKE ALL ON public.summary_tree_jobs FROM docslurp_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.summary_tree_jobs TO docslurp_worker;
  END IF;
END $$;

-- Durable admission before any remote request. Ambiguous requests never auto-resubmit.
CREATE TABLE remote_media_jobs (
  id text PRIMARY KEY,
  request_key text NOT NULL UNIQUE,
  org_id text NOT NULL REFERENCES organizations(id),
  workspace_id text NOT NULL REFERENCES workspaces(id),
  run_id text NOT NULL REFERENCES workspace_runs(id),
  document_id text NOT NULL REFERENCES documents(id),
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('submitting', 'completed', 'uncertain')),
  reserve_cents numeric(24,12) NOT NULL CHECK (reserve_cents > 0),
  cost_cents numeric(24,12) CHECK (cost_cents >= 0),
  result_key text,
  usage_settled boolean NOT NULL DEFAULT false,
  pricing_uncertain boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX remote_media_jobs_admission_idx ON remote_media_jobs(status, created_at);
--> statement-breakpoint
CREATE INDEX remote_media_jobs_run_idx ON remote_media_jobs(run_id);

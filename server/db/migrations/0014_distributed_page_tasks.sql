CREATE TABLE IF NOT EXISTS page_work_tasks (
  run_id text NOT NULL REFERENCES workspace_runs(id) ON DELETE CASCADE,
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page_number integer NOT NULL CHECK (page_number > 0),
  status text NOT NULL DEFAULT 'queued',
  lease_id text,
  lease_expires_at timestamptz,
  worker_id text,
  attempts integer NOT NULL DEFAULT 0,
  result jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (run_id, document_id, page_number)
);
CREATE INDEX IF NOT EXISTS page_work_tasks_pending_idx ON page_work_tasks(run_id, status);

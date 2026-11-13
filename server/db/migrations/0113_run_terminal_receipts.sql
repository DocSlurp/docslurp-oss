CREATE TABLE IF NOT EXISTS run_terminal_receipts (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES workspace_runs(id) ON DELETE CASCADE,
  execution_generation text,
  outcome text NOT NULL CHECK (outcome IN ('failed', 'completed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS run_terminal_receipts_generation ON run_terminal_receipts (run_id, execution_generation) NULLS NOT DISTINCT;

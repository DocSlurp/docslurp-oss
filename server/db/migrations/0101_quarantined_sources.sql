-- Source files whose parser command could not be verifiably torn down on a
-- worker (CommandTeardownError). The worker that hit it quarantines itself and
-- restarts; this denylist stops the same bytes (by the server-computed
-- documents.source_sha256) from quarantining another worker. A worker refuses to
-- run any parser command for a document whose source is listed, and fails that
-- document without retrying it. Deliberately global: one hostile file must not
-- quarantine one worker per uploading organization. Rows are attribution for
-- the incident; delete one to admit its source again after investigation.
CREATE TABLE IF NOT EXISTS quarantined_sources (
  source_sha256 text PRIMARY KEY,
  org_id text,
  workspace_id text,
  run_id text,
  document_id text,
  stage text,
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

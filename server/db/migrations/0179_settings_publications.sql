CREATE TABLE IF NOT EXISTS project_settings_publications (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id text NOT NULL,
  request_id text NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, actor_id, request_id)
);

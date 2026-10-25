-- Zip exports of a document or a workspace, built by the worker and staged in
-- object storage under exports/<org>/<workspace>/. Each export's link lives
-- seven days (expires_at); the maintenance sweep deletes the object after that.
CREATE TABLE IF NOT EXISTS document_exports (
  id text PRIMARY KEY,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  document_id text REFERENCES documents(id) ON DELETE CASCADE,
  content text NOT NULL CHECK (content IN ('markdown', 'all')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired')),
  filename text NOT NULL,
  object_key text NOT NULL,
  document_count integer NOT NULL DEFAULT 0,
  estimated_bytes bigint NOT NULL DEFAULT 0,
  size_bytes bigint,
  file_count integer,
  skipped_count integer,
  notify_email boolean NOT NULL DEFAULT false,
  emailed_at timestamp with time zone,
  error text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  expires_at timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_exports_user_created_idx ON document_exports (user_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_exports_sweep_idx ON document_exports (expires_at) WHERE status <> 'expired';

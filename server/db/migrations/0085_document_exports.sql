-- Zip exports of a document or a workspace, built by the worker and staged in
-- object storage under exports/<org>/<workspace>/<export>/. Each export's link
-- lives seven days from when it becomes ready (expires_at); the maintenance
-- sweep deletes the object after that.
--
-- The owner columns are deliberately not foreign keys: a cascade would drop the
-- row that names the zip's storage key and orphan the object. When a document
-- in the export, its workspace or the requester is deleted (or a document
-- purged), the sweep deletes the object first and then the row
-- (document-exports.ts).
CREATE TABLE IF NOT EXISTS document_exports (
  id text PRIMARY KEY,
  org_id text NOT NULL,
  workspace_id text NOT NULL,
  user_id text NOT NULL,
  document_id text,
  content text NOT NULL CHECK (content IN ('markdown', 'all')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ready', 'failed', 'expired')),
  filename text NOT NULL,
  -- The export's storage prefix until ready, then the finished zip's key (one per attempt).
  object_key text NOT NULL,
  -- The documents the finished zip holds, so deleting or purging any of them withdraws it.
  document_ids text[] NOT NULL DEFAULT '{}',
  document_count integer NOT NULL DEFAULT 0,
  estimated_bytes bigint NOT NULL DEFAULT 0,
  size_bytes bigint,
  file_count integer,
  skipped_count integer,
  attempts integer NOT NULL DEFAULT 0,
  notify_email boolean NOT NULL DEFAULT false,
  emailed_at timestamp with time zone,
  email_attempts integer NOT NULL DEFAULT 0,
  next_email_at timestamp with time zone,
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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_exports_email_idx ON document_exports (next_email_at) WHERE notify_email AND emailed_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_exports_documents_idx ON document_exports USING gin (document_ids) WHERE status <> 'expired';

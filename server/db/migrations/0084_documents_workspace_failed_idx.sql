-- Chat suggestions mode counts a workspace's current failed documents on every
-- dashboard turn. Partial index so that count reads only live failed versions.
CREATE INDEX IF NOT EXISTS documents_workspace_failed_idx ON documents USING btree (workspace_id)
  WHERE status = 'failed' AND superseded_at IS NULL AND archived_at IS NULL AND purged_at IS NULL;

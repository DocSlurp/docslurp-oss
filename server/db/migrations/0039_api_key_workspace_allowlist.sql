-- Per-key workspace allowlist and search-only client keys (security gap G-03).
--
-- workspace_ids: the workspaces a key may touch. Empty means every workspace
-- the key's owner can access in the key's organization (server keys only by
-- default). The API enforces it wherever an API key actor resolves a
-- workspace: loadActorScopedWorkspace, the default-workspace resolver and the
-- access-list queries.
--
-- Client (browser, dslp_pub_) keys used to default to ingest, search and
-- artifacts, so a "docs search" key shipped in public JavaScript could read and
-- upload into every workspace. They are search-only now; ingest and artifacts
-- need an explicit opt-in plus a workspace allowlist. Existing client keys have
-- no allowlist, so they lose those scopes here.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS workspace_ids text[] DEFAULT '{}'::text[] NOT NULL;
--> statement-breakpoint
UPDATE api_keys
SET scopes = CASE
  WHEN array_length(array_remove(array_remove(scopes, 'ingest'), 'artifacts'), 1) IS NULL THEN ARRAY['search']::text[]
  ELSE array_remove(array_remove(scopes, 'ingest'), 'artifacts')
END
WHERE key_type = 'client'
  AND (scopes && ARRAY['ingest', 'artifacts']::text[]);

-- Document versions, retention and config-change jobs.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_path text NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN IF NOT EXISTS archived_at timestamptz;
--> statement-breakpoint
ALTER TABLE documents ADD COLUMN IF NOT EXISTS index_config_hash text;
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS retain_document_versions integer;
--> statement-breakpoint
ALTER TABLE organizations ADD CONSTRAINT organizations_retain_document_versions_check
  CHECK (retain_document_versions IS NULL OR retain_document_versions BETWEEN 1 AND 100);
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS retain_document_versions integer;
--> statement-breakpoint
ALTER TABLE workspaces ADD CONSTRAINT workspaces_retain_document_versions_check
  CHECK (retain_document_versions IS NULL OR retain_document_versions BETWEEN 1 AND 100);
--> statement-breakpoint
-- The retention sweep only revisits archived chains of an organization or workspace whose retention
-- setting or plan changed (retention_changed_at) since it was last fully applied (retention_swept_at).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS retention_changed_at timestamptz;
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS retention_swept_at timestamptz;
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS retention_changed_at timestamptz;
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS retention_swept_at timestamptz;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION docslurp_org_retention_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.retain_document_versions IS DISTINCT FROM OLD.retain_document_versions
     OR NEW.plan_id IS DISTINCT FROM OLD.plan_id THEN
    NEW.retention_changed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER organizations_retention_changed BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION docslurp_org_retention_changed();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION docslurp_workspace_retention_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.retain_document_versions IS DISTINCT FROM OLD.retain_document_versions THEN
    NEW.retention_changed_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER workspaces_retention_changed BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION docslurp_workspace_retention_changed();
--> statement-breakpoint
-- {index_config_hash: IndexConfig} for every index config a live document in the workspace is built with
-- (the current one included); search serves each document from the config it was indexed under.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS index_configs jsonb;
--> statement-breakpoint
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS auto_confirm_reindex boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE workspace_runs ADD COLUMN IF NOT EXISTS blocked_reason text;
--> statement-breakpoint
-- Groups the runs of one config-change/full-index job; the job id is the first run's id.
ALTER TABLE workspace_runs ADD COLUMN IF NOT EXISTS job_id text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS workspace_runs_job_id_idx ON workspace_runs (job_id) WHERE job_id IS NOT NULL;
--> statement-breakpoint
-- Set on a document created by a re-index/full-index of this source version; it replaces the source without taking a retention slot.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS reindex_of text;
--> statement-breakpoint
ALTER TABLE workspace_runs ADD CONSTRAINT workspace_runs_blocked_reason_check
  CHECK (blocked_reason IS NULL OR blocked_reason IN ('credits', 'budget', 'policy'));
--> statement-breakpoint
-- Mirrors documentVersionKey in packages/shared: "path:" + first 32 hex chars of
-- sha256(workspaceId || E'\n' || normPath || '/' || normName), where each part is
-- NFC-normalized, ASCII-lower-cased (collation independent, so SQL and TS agree),
-- backslash -> '/', repeated '/' collapsed and leading/trailing '/', space, tab,
-- CR and LF trimmed.
CREATE OR REPLACE FUNCTION docslurp_version_key(ws text, path text, name text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT 'path:' || left(encode(sha256(convert_to(
    ws || E'\n' ||
    btrim(regexp_replace(replace(translate(normalize(coalesce(path, ''), NFC), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), E'\\', '/'), '/+', '/', 'g'), E'/ \t\r\n') ||
    '/' ||
    btrim(regexp_replace(replace(translate(normalize(coalesce(name, ''), NFC), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), E'\\', '/'), '/+', '/', 'g'), E'/ \t\r\n'),
    'UTF8')), 'hex'), 32)
$$;
--> statement-breakpoint
-- Backfill version keys for live documents that never got one. Old rows carry no
-- folder, so same-named files are only one version chain when previous_version_id
-- links them. Per (workspace, key('', filename)) group, rows reachable from the
-- newest live row through previous_version_id share the path key; every other
-- row becomes its own independent 'legacy:<id>' chain.
WITH RECURSIVE cand AS (
  SELECT id, workspace_id, previous_version_id, created_at,
         docslurp_version_key(workspace_id, '', filename) AS gkey
  FROM documents
  WHERE canonical_id IS NULL AND purged_at IS NULL AND superseded_at IS NULL
),
heads AS (
  SELECT DISTINCT ON (workspace_id, gkey) id, workspace_id, gkey
  FROM cand
  ORDER BY workspace_id, gkey, created_at DESC, id DESC
),
chain AS (
  SELECT h.id, h.workspace_id, h.gkey FROM heads h
  UNION
  SELECT c.id, ch.workspace_id, ch.gkey
  FROM chain ch
  JOIN cand h ON h.id = ch.id
  JOIN cand c ON c.id = h.previous_version_id AND c.workspace_id = ch.workspace_id
)
UPDATE documents d
SET canonical_id = coalesce((SELECT ch.gkey FROM chain ch WHERE ch.id = d.id), 'legacy:' || d.id)
WHERE d.canonical_id IS NULL AND d.purged_at IS NULL AND d.superseded_at IS NULL;
--> statement-breakpoint
-- Keep only the newest completed live row per (workspace_id, canonical_id);
-- older completed, failed and cancelled rows are superseded (as the 0021 trigger).
UPDATE documents d
SET superseded_at = now(), superseded_by_document_id = n.id, updated_at = now()
FROM (
  SELECT DISTINCT ON (workspace_id, canonical_id) workspace_id, canonical_id, id, created_at
  FROM documents
  WHERE status = 'completed' AND superseded_at IS NULL AND purged_at IS NULL AND canonical_id IS NOT NULL
  ORDER BY workspace_id, canonical_id, created_at DESC, id DESC
) n
WHERE d.workspace_id = n.workspace_id
  AND d.canonical_id = n.canonical_id
  AND d.status IN ('completed', 'failed', 'cancelled')
  AND d.superseded_at IS NULL
  AND d.purged_at IS NULL
  AND d.id <> n.id
  AND (d.created_at, d.id) < (n.created_at, n.id);

-- Workers need only this correction-presence bit, never access to human correction rows.
ALTER TABLE documents ADD COLUMN geo_has_correction boolean NOT NULL DEFAULT false;
--> statement-breakpoint
UPDATE documents d SET geo_has_correction=true WHERE EXISTS
 (SELECT 1 FROM document_corrections c WHERE c.document_id=d.id AND c.corrected_structured_data IS NOT NULL);
--> statement-breakpoint
-- Operational status/progress writes must not supersede an accepted extraction.
CREATE OR REPLACE FUNCTION bump_projection_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.projection_revision IS DISTINCT FROM OLD.projection_revision
    OR (NEW.source_key,NEW.source_sha256,NEW.workspace_id,NEW.org_id,NEW.run_id,NEW.geo_has_correction,NEW.deduped_from_document_id,NEW.archived_at,NEW.superseded_at,NEW.purged_at)
       IS DISTINCT FROM (OLD.source_key,OLD.source_sha256,OLD.workspace_id,OLD.org_id,OLD.run_id,OLD.geo_has_correction,OLD.deduped_from_document_id,OLD.archived_at,OLD.superseded_at,OLD.purged_at)
    OR (NEW.status IN ('pii_blocked','failed')) IS DISTINCT FROM (OLD.status IN ('pii_blocked','failed'))
  THEN NEW.projection_revision := OLD.projection_revision + 1;
  ELSE NEW.projection_revision := OLD.projection_revision;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION invalidate_corrected_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND NEW.corrected_structured_data IS NOT DISTINCT FROM OLD.corrected_structured_data
    AND NEW.corrected_markdown IS NOT DISTINCT FROM OLD.corrected_markdown THEN RETURN NULL; END IF;
  UPDATE documents SET projection_revision = projection_revision + 1,
    geo_has_correction = CASE WHEN TG_OP='DELETE' THEN false ELSE NEW.corrected_structured_data IS NOT NULL END
    WHERE id = COALESCE(NEW.document_id, OLD.document_id);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION invalidate_workspace_projection() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.pipeline IS DISTINCT FROM OLD.pipeline OR NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    UPDATE documents SET projection_revision = projection_revision + 1 WHERE workspace_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TABLE geo_accepted_sources (
  document_id text PRIMARY KEY,
  workspace_id text NOT NULL,
  org_id text NOT NULL,
  source_revision bigint NOT NULL,
  run_id text REFERENCES workspace_runs(id) ON DELETE CASCADE,
  schema_digest text NOT NULL CHECK (schema_digest ~ '^[0-9a-f]{64}$'),
  result_digest text NOT NULL CHECK (result_digest ~ '^[0-9a-f]{64}$'),
  features jsonb NOT NULL CHECK (jsonb_typeof(features) = 'array' AND jsonb_array_length(features) <= 1000 AND octet_length(features::text) <= 1048576),
  FOREIGN KEY (document_id,workspace_id,org_id) REFERENCES documents(id,workspace_id,org_id) ON DELETE CASCADE
);
--> statement-breakpoint
-- This entrypoint participates in the caller's successful stage transaction.
-- It never reads a partial object-store artifact or accepts a caller-provided authority adapter.
CREATE FUNCTION commit_geo_final_source(doc text, ws text, tenant text, rev bigint, run text, schema_hash text, result_hash text, admitted jsonb)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM workspaces WHERE id=ws AND org_id=tenant AND archived_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Geo workspace is unavailable'; END IF;
  PERFORM 1 FROM documents d WHERE d.id=doc AND d.workspace_id=ws AND d.org_id=tenant
    AND d.projection_revision=rev AND d.status NOT IN ('pii_blocked','failed')
    AND NOT d.geo_has_correction AND d.deduped_from_document_id IS NULL AND d.archived_at IS NULL AND d.superseded_at IS NULL AND d.purged_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stale or ineligible geo source'; END IF;
  -- A lost COMMIT response may retry an already completed, identical checkpoint.
  IF EXISTS (SELECT 1 FROM geo_accepted_sources a JOIN document_run_stage_states s
    ON s.run_id=a.run_id AND s.document_id=a.document_id AND s.stage_name='structured-extract'
    WHERE a.document_id=doc AND a.source_revision=rev AND a.run_id=run AND a.schema_digest=schema_hash
      AND a.result_digest=result_hash AND a.features=admitted AND s.status='completed') THEN RETURN; END IF;
  PERFORM 1 FROM workspace_runs r JOIN document_run_stage_states s ON s.run_id=r.id
    WHERE r.id=run AND r.workspace_id=ws AND r.org_id=tenant AND s.document_id=doc
    AND s.stage_name='structured-extract' AND s.status='processing';
  IF NOT FOUND THEN RAISE EXCEPTION 'Geo source has no active structured attempt'; END IF;
  IF EXISTS (SELECT 1 FROM geo_accepted_sources WHERE document_id=doc AND source_revision=rev
    AND (schema_digest<>schema_hash OR result_digest<>result_hash OR features<>admitted))
    THEN RAISE EXCEPTION 'Conflicting geo source retry'; END IF;
  INSERT INTO geo_accepted_sources VALUES(doc,ws,tenant,rev,run,schema_hash,result_hash,admitted)
    ON CONFLICT(document_id) DO UPDATE SET workspace_id=excluded.workspace_id,org_id=excluded.org_id,
    source_revision=excluded.source_revision,run_id=excluded.run_id,schema_digest=excluded.schema_digest,
    result_digest=excluded.result_digest,features=excluded.features;
  IF to_regprocedure('publish_accepted_geo_source(text)') IS NULL
    THEN RAISE EXCEPTION 'Geo spatial migrations are not installed'; END IF;
  EXECUTE 'SELECT publish_accepted_geo_source($1)' USING doc;
END $$;

--> statement-breakpoint
CREATE FUNCTION commit_geo_corrected_source(doc text, ws text, tenant text, rev bigint, expected jsonb, schema_hash text, result_hash text, admitted jsonb)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE source_run text;
BEGIN
  PERFORM 1 FROM workspaces WHERE id=ws AND org_id=tenant AND archived_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Geo workspace is unavailable'; END IF;
  SELECT run_id INTO source_run FROM documents WHERE id=doc AND workspace_id=ws AND org_id=tenant
    AND projection_revision=rev AND status NOT IN ('pii_blocked','failed')
    AND archived_at IS NULL AND superseded_at IS NULL AND purged_at IS NULL AND deduped_from_document_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stale or ineligible corrected geo source'; END IF;
  PERFORM 1 FROM document_corrections WHERE document_id=doc
    AND corrected_structured_data IS NOT DISTINCT FROM expected;
  IF NOT FOUND THEN RAISE EXCEPTION 'Corrected geo source changed'; END IF;
  INSERT INTO geo_accepted_sources VALUES(doc,ws,tenant,rev,source_run,schema_hash,result_hash,admitted)
    ON CONFLICT(document_id) DO UPDATE SET workspace_id=excluded.workspace_id,org_id=excluded.org_id,
    source_revision=excluded.source_revision,run_id=excluded.run_id,schema_digest=excluded.schema_digest,
    result_digest=excluded.result_digest,features=excluded.features;
  IF to_regprocedure('publish_accepted_geo_source(text)') IS NULL
    THEN RAISE EXCEPTION 'Geo spatial migrations are not installed'; END IF;
  EXECUTE 'SELECT publish_accepted_geo_source($1)' USING doc;
END $$;

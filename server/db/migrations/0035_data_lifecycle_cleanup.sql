-- Data lifecycle: every deleted document and run reaches the external cleanup
-- queues, and tenant offboarding cannot cascade into shared or billing data.
-- See docs/data-deletion.md.
--
-- 1. documents BEFORE DELETE trigger: records the document's LanceDB targets,
--    stage artifact URIs, raw source and graph nodes in document_cleanup_queue.
--    It runs before FK cascades remove the child rows it reads, so every delete
--    path (single delete, workspace delete, retention, discarded intake, org
--    deletion, a manual psql delete) enqueues cleanup. Callers no longer have to.
-- 2. workspace_runs BEFORE DELETE trigger: enqueues one storage-prefix purge per
--    run (`<userId>/<runId>/`), which removes all of the run's artifacts with one
--    listing instead of one listing per document.
-- 3. storage_cleanup_queue: run prefixes and whole LanceDB tables (org
--    deletion drops the org's vector tables instead of deleting row by row).
--
-- Partial reprocesses (0033_document_reused_from) point newer versions at an older version's
-- storage artifacts. The sweep keeps any artifact a surviving stage state or
-- run still references, and retries the rest later; the artifact_uri index
-- makes those reference checks prefix lookups.
ALTER TABLE document_cleanup_queue ADD COLUMN IF NOT EXISTS not_before timestamptz DEFAULT now() NOT NULL;
--> statement-breakpoint
-- Dedup copies share vectors as well as artifacts; partial reprocesses share only artifacts.
ALTER TABLE document_cleanup_queue ADD COLUMN IF NOT EXISTS shares_vectors boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_run_stage_states_artifact_uri_idx
  ON document_run_stage_states USING btree (artifact_uri text_pattern_ops) WHERE artifact_uri IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS document_cleanup_queue_due_idx ON document_cleanup_queue USING btree (not_before) WHERE attempts < 10;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS storage_cleanup_queue (
  id bigserial PRIMARY KEY NOT NULL,
  -- storage_prefix: target is an object-storage key prefix ending in "/".
  -- vector_table: target identifies one LanceDB table; payload holds either
  --   {embeddingModel, dimension} (resolved under the worker's LanceDB root) or {uri, table}.
  kind text NOT NULL,
  org_id text,
  target text NOT NULL,
  payload jsonb DEFAULT '{}'::jsonb NOT NULL,
  -- Extra object URIs outside the prefix (run-level artifacts).
  artifact_uris text[] DEFAULT '{}'::text[] NOT NULL,
  reason text NOT NULL,
  -- In-flight runs get a grace period so late artifact writes are caught.
  not_before timestamptz DEFAULT now() NOT NULL,
  attempts integer DEFAULT 0 NOT NULL,
  last_error text,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT storage_cleanup_queue_kind_check CHECK (kind IN ('storage_prefix', 'vector_table')),
  CONSTRAINT storage_cleanup_queue_target_key UNIQUE (kind, target)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS storage_cleanup_queue_due_idx ON storage_cleanup_queue USING btree (not_before) WHERE attempts < 10;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enqueue_document_cleanup() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO document_cleanup_queue (
    document_id, org_id, user_id, workspace_id, run_id, source_key,
    delete_source, keep_shared_artifacts, shares_vectors, vector_targets, artifact_uris, kg_node_ids, not_before
  )
  SELECT
    OLD.id,
    coalesce(OLD.org_id, (SELECT w.org_id FROM workspaces w WHERE w.id = OLD.workspace_id), ''),
    OLD.user_id,
    OLD.workspace_id,
    OLD.run_id,
    OLD.source_key,
    -- The sweep re-checks that no remaining document shares the source.
    true,
    EXISTS (
      SELECT 1 FROM documents copy
      WHERE (copy.deduped_from_document_id = OLD.id OR copy.reused_from_document_id = OLD.id) AND copy.id <> OLD.id
    ),
    EXISTS (SELECT 1 FROM documents copy WHERE copy.deduped_from_document_id = OLD.id AND copy.id <> OLD.id),
    coalesce((
      SELECT jsonb_agg(DISTINCT jsonb_build_object(
        'backend', vi.backend, 'embeddingModel', vi.embedding_model, 'dimension', vi.dimension))
      FROM vector_indexes vi WHERE vi.document_id = OLD.id
    ), '[]'::jsonb) || coalesce((
      SELECT jsonb_agg(DISTINCT jsonb_build_object('backend', 'lancedb', 'uri', o.lance_uri, 'table', o.lance_table))
      FROM vector_index_outbox o WHERE o.document_id = OLD.id
    ), '[]'::jsonb),
    coalesce((
      SELECT array_agg(DISTINCT stage.artifact_uri)
      FROM document_run_stage_states stage
      WHERE stage.document_id = OLD.id AND stage.artifact_uri IS NOT NULL
    ), '{}'::text[]),
    coalesce((
      SELECT array_agg(DISTINCT supported.node_id)
      FROM (
        SELECT ce.node_id
        FROM chunk_entities ce
        JOIN document_chunks c ON c.id = ce.chunk_id
        WHERE c.document_id = OLD.id
        UNION
        SELECT unnest(ARRAY[e.source_node_id, e.target_node_id])
        FROM kg_edge_evidence ev
        JOIN kg_edges e ON e.id = ev.edge_id
        WHERE ev.document_id = OLD.id
      ) supported
    ), '{}'::text[]),
    -- A document still being processed may get late writes; give the worker time to stop.
    now() + CASE WHEN OLD.status IN ('queued', 'processing') THEN interval '15 minutes' ELSE interval '0' END
  ON CONFLICT (document_id) DO UPDATE SET
    run_id = coalesce(excluded.run_id, document_cleanup_queue.run_id),
    source_key = coalesce(excluded.source_key, document_cleanup_queue.source_key),
    delete_source = document_cleanup_queue.delete_source OR excluded.delete_source,
    keep_shared_artifacts = document_cleanup_queue.keep_shared_artifacts OR excluded.keep_shared_artifacts,
    shares_vectors = document_cleanup_queue.shares_vectors OR excluded.shares_vectors,
    vector_targets = (
      SELECT coalesce(jsonb_agg(DISTINCT target), '[]'::jsonb)
      FROM jsonb_array_elements(document_cleanup_queue.vector_targets || excluded.vector_targets) AS target
    ),
    artifact_uris = ARRAY(SELECT DISTINCT unnest(document_cleanup_queue.artifact_uris || excluded.artifact_uris)),
    kg_node_ids = ARRAY(SELECT DISTINCT unnest(document_cleanup_queue.kg_node_ids || excluded.kg_node_ids)),
    not_before = greatest(document_cleanup_queue.not_before, excluded.not_before),
    attempts = 0,
    last_error = NULL;

  -- Never write vectors for a document that no longer exists.
  DELETE FROM vector_index_outbox WHERE document_id = OLD.id;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS documents_enqueue_cleanup ON documents;
--> statement-breakpoint
CREATE TRIGGER documents_enqueue_cleanup
BEFORE DELETE ON documents
FOR EACH ROW
EXECUTE FUNCTION enqueue_document_cleanup();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enqueue_run_storage_cleanup() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  grace interval := CASE WHEN OLD.status IN ('queued', 'processing') THEN interval '15 minutes' ELSE interval '0' END;
BEGIN
  -- Artifacts live under <userId>/<runId>/; documents uploaded by another user
  -- into the same run write under their own <userId>/<runId>/.
  INSERT INTO storage_cleanup_queue (kind, org_id, target, payload, artifact_uris, reason, not_before)
  SELECT 'storage_prefix', OLD.org_id, owners.user_id || '/' || OLD.id || '/',
    jsonb_build_object('workspaceId', OLD.workspace_id),
    CASE WHEN owners.user_id = OLD.user_id THEN coalesce((
      SELECT array_agg(DISTINCT uri) FROM (
        SELECT artifact.value AS uri FROM jsonb_each_text(coalesce(OLD.artifacts, '{}'::jsonb)) AS artifact(key, value)
        UNION
        SELECT stage.artifact_uri FROM workspace_run_stage_states stage WHERE stage.run_id = OLD.id
      ) uris WHERE uri IS NOT NULL AND uri <> ''
    ), '{}'::text[]) ELSE '{}'::text[] END,
    'run_deleted',
    now() + grace
  FROM (
    SELECT OLD.user_id
    UNION
    SELECT d.user_id FROM documents d WHERE d.run_id = OLD.id
  ) AS owners(user_id)
  ON CONFLICT (kind, target) DO UPDATE SET
    artifact_uris = ARRAY(SELECT DISTINCT unnest(storage_cleanup_queue.artifact_uris || excluded.artifact_uris)),
    not_before = greatest(storage_cleanup_queue.not_before, excluded.not_before),
    attempts = 0,
    last_error = NULL;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS workspace_runs_enqueue_storage_cleanup ON workspace_runs;
--> statement-breakpoint
CREATE TRIGGER workspace_runs_enqueue_storage_cleanup
BEFORE DELETE ON workspace_runs
FOR EACH ROW
EXECUTE FUNCTION enqueue_run_storage_cleanup();

-- One LanceDB database per workspace: <LANCEDB_URI>/<orgId>/<workspaceId>/vectors-<model>-<dimensions>
-- (@docslurp/shared vector-namespace). A dedup copy shares its source's LanceDB
-- rows only inside the source's workspace; a copy in another workspace is
-- indexed into its own workspace's database (run creation leaves its index
-- stage to the worker). The documents BEFORE DELETE trigger therefore marks a
-- deleted document as sharing vectors only when a copy in the same workspace
-- remains. vector_table cleanup payloads now carry the workspaceId whose
-- database holds the table (workspace and org deletion).
--
-- Pre-release: existing org-level LanceDB tables are not migrated; reindex.
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
    -- Only copies in the same workspace read this document's LanceDB rows; a copy
    -- in another workspace has its own rows in its own workspace's database.
    EXISTS (
      SELECT 1 FROM documents copy
      WHERE copy.deduped_from_document_id = OLD.id AND copy.id <> OLD.id AND copy.workspace_id = OLD.workspace_id
    ),
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

-- 0021 retires completed/failed/cancelled versions, but a failed Run can leave
-- untouched Documents queued. Once a newer canonical version completes, those
-- pending historical rows must stop counting toward current search availability.
-- Never delete history, guess identity from filenames/keys, or stop active Runs.
CREATE OR REPLACE FUNCTION retire_replaced_pending_documents(
  p_run_id text DEFAULT NULL,
  p_workspace_id text DEFAULT NULL,
  p_canonical_id text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE source_scope record;
BEGIN
  -- Match the existing canonical completion lock and take source locks in a
  -- stable order. Recheck terminal/pending predicates after acquiring each lock.
  FOR source_scope IN
    SELECT DISTINCT d.org_id, d.workspace_id, d.canonical_id
    FROM documents d JOIN workspace_runs r ON r.id = d.run_id
    WHERE r.status IN ('failed', 'completed')
      AND d.status IN ('queued', 'processing') AND d.superseded_at IS NULL
      AND d.canonical_id IS NOT NULL
      AND (p_run_id IS NULL OR d.run_id = p_run_id)
      AND (p_workspace_id IS NULL OR d.workspace_id = p_workspace_id)
      AND (p_canonical_id IS NULL OR d.canonical_id = p_canonical_id)
    ORDER BY d.workspace_id, d.canonical_id, d.org_id
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(source_scope.workspace_id || ':' || source_scope.canonical_id, 0));
    -- A retry locks its Run before changing Documents. Never wait for that
    -- lock while holding the canonical lock: skip it, then recheck terminal
    -- status while claiming the Run. The claim survives until commit.
    WITH terminal_runs AS MATERIALIZED (
      SELECT r.id FROM workspace_runs r
      WHERE r.status IN ('failed', 'completed')
        AND (p_run_id IS NULL OR r.id = p_run_id)
        AND EXISTS (
          SELECT 1 FROM documents pending
          WHERE pending.run_id = r.id AND pending.org_id = source_scope.org_id
            AND pending.workspace_id = source_scope.workspace_id
            AND pending.canonical_id = source_scope.canonical_id
            AND pending.status IN ('queued', 'processing') AND pending.superseded_at IS NULL
        )
      ORDER BY r.id FOR UPDATE OF r SKIP LOCKED
    ), replacements AS (
      SELECT old.id, newer.id AS replacement_id
      FROM documents old JOIN terminal_runs r ON r.id = old.run_id
      CROSS JOIN LATERAL (
        SELECT candidate.id FROM documents candidate
        WHERE candidate.org_id = old.org_id AND candidate.workspace_id = old.workspace_id
          AND candidate.canonical_id = old.canonical_id AND candidate.status = 'completed'
          AND (candidate.created_at, candidate.id) > (old.created_at, old.id)
        ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1
      ) newer
      WHERE old.org_id = source_scope.org_id AND old.workspace_id = source_scope.workspace_id
        AND old.canonical_id = source_scope.canonical_id
        AND old.status IN ('queued', 'processing') AND old.superseded_at IS NULL
        AND (p_run_id IS NULL OR old.run_id = p_run_id)
    )
    UPDATE documents d
    SET status = 'cancelled', superseded_at = now(),
        superseded_by_document_id = replacements.replacement_id,
        lexical_searchable_at = NULL, updated_at = now()
    FROM replacements WHERE d.id = replacements.id;
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION retire_pending_canonical_replacements() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM retire_replaced_pending_documents(NULL, NEW.workspace_id, NEW.canonical_id);
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER documents_retire_pending_on_insert
AFTER INSERT ON documents FOR EACH ROW
WHEN (NEW.status = 'completed' AND NEW.canonical_id IS NOT NULL)
EXECUTE FUNCTION retire_pending_canonical_replacements();
--> statement-breakpoint
CREATE TRIGGER documents_retire_pending_on_complete
AFTER UPDATE OF status ON documents FOR EACH ROW
WHEN (NEW.status = 'completed' AND OLD.status IS DISTINCT FROM NEW.status AND NEW.canonical_id IS NOT NULL)
EXECUTE FUNCTION retire_pending_canonical_replacements();
--> statement-breakpoint
-- Existing failed-run queued versions may never receive another status update.
SELECT retire_replaced_pending_documents();

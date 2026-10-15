-- Usage Event attribution as one SQL view (architect gaps A6, A7).
--
-- The API (server/src/services/usage-attribution.ts) and the worker (budget
-- alerts in worker/src/db/store.ts) both read spend through this view, so the
-- rule cannot drift between them. Do not hand-write spend SQL against
-- usage_events: a repo test fails on `from usage_events` outside the owner
-- modules.
--
-- One row per (Usage Event, attributed workspace):
--  1. An event with workspace_id (stamped at write time, migration 0041)
--     belongs to that workspace.
--  2. An event without one but with metadata.workspaceIds[] (cross-workspace
--     answers) splits its cost and tokens evenly across those workspaces,
--     each row counting against its workspace's org (falling back to the
--     event's org_id once that workspace is deleted).
--  3. Anything else is org-only: workspace_id is NULL.
-- Sums over the view equal sums over usage_events; count events with
-- count(distinct id).
CREATE OR REPLACE VIEW usage_attribution AS
SELECT
  ue.id,
  ue.created_at,
  ue.user_id,
  ue.run_id,
  coalesce(ue.run_id, ue.metadata ->> 'runId') AS source_run_id,
  ue.document_id,
  ue.provider,
  ue.model,
  ue.metric,
  ue.unit,
  ue.metadata,
  ue.api_key_id,
  scope.workspace_id,
  CASE WHEN scope.split
    THEN coalesce(w.org_id, ue.org_id)
    ELSE coalesce(ue.org_id, w.org_id)
  END AS org_id,
  CASE WHEN ue.run_id IS NOT NULL OR ue.metadata ? 'runId' THEN 'ingest' ELSE 'search' END AS source_kind,
  scope.share,
  ue.amount * scope.share AS amount,
  ue.input_tokens * scope.share AS input_tokens,
  ue.output_tokens * scope.share AS output_tokens,
  ue.cost_cents * scope.share AS cost_cents
FROM usage_events ue
CROSS JOIN LATERAL (
  SELECT ue.workspace_id, 1::numeric AS share, false AS split
  WHERE ue.workspace_id IS NOT NULL
    OR CASE WHEN jsonb_typeof(ue.metadata -> 'workspaceIds') = 'array'
      THEN jsonb_array_length(ue.metadata -> 'workspaceIds') ELSE 0 END = 0
  UNION ALL
  SELECT ids.workspace_id,
    1::numeric / jsonb_array_length(ue.metadata -> 'workspaceIds') AS share,
    true AS split
  FROM jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(ue.metadata -> 'workspaceIds') = 'array'
      THEN ue.metadata -> 'workspaceIds'
      ELSE '[]'::jsonb
    END
  ) AS ids(workspace_id)
  WHERE ue.workspace_id IS NULL
) scope
LEFT JOIN workspaces w
  ON w.id = scope.workspace_id
  AND (scope.split OR ue.org_id IS NULL);

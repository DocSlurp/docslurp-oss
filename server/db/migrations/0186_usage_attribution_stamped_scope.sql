-- usage_attribution exposes each event's stamped org_id and project_id (as written, migration 0042) as two new trailing
-- columns, stamped_org_id and stamped_project_id. The view's org_id is derived (a CASE over the project join), so no
-- index serves `org_id = $1` and every per-org read scanned all of usage_events in its window. Readers filter on the
-- stamped columns first (server/src/services/usage-attribution.ts orgAttributedUsage), which the planner pushes down to
-- usage_events_org_created_idx and usage_events_project_created_idx, and then on the derived org_id as before.
--
-- Only columns are appended (CREATE OR REPLACE VIEW keeps every existing column, its name, type and order); the
-- attribution rule is unchanged. The body is the current definition (0043 as renamed by 0132).
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
  scope.workspace_id AS project_id,
  CASE WHEN scope.split
    THEN coalesce(w.org_id, ue.org_id)
    ELSE coalesce(ue.org_id, w.org_id)
  END AS org_id,
  CASE WHEN ue.run_id IS NOT NULL OR ue.metadata ? 'runId' THEN 'ingest' ELSE 'search' END AS source_kind,
  scope.share,
  ue.amount * scope.share AS amount,
  ue.input_tokens::numeric * scope.share AS input_tokens,
  ue.output_tokens::numeric * scope.share AS output_tokens,
  ue.cost_cents * scope.share AS cost_cents,
  ue.org_id AS stamped_org_id,
  ue.project_id AS stamped_project_id
FROM usage_events ue
CROSS JOIN LATERAL (
  SELECT ue.project_id AS workspace_id, 1::numeric AS share, false AS split
  WHERE ue.project_id IS NOT NULL
    OR CASE WHEN jsonb_typeof(ue.metadata -> 'projectIds') = 'array'
      THEN jsonb_array_length(ue.metadata -> 'projectIds') ELSE 0 END = 0
  UNION ALL
  SELECT ids.workspace_id,
    1::numeric / jsonb_array_length(ue.metadata -> 'projectIds')::numeric AS share,
    true AS split
  FROM jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(ue.metadata -> 'projectIds') = 'array'
      THEN ue.metadata -> 'projectIds'
      ELSE '[]'::jsonb
    END
  ) AS ids(workspace_id)
  WHERE ue.project_id IS NULL
) scope
LEFT JOIN projects w
  ON w.id = scope.workspace_id
  AND (scope.split OR ue.org_id IS NULL);

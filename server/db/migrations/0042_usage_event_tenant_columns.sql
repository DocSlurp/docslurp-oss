-- Tenant columns on usage_events (architect gap A8).
--
-- Before this, a Usage Event's workspace and org were derived at read time
-- from workspace_runs (run_id) or metadata. run_id is ON DELETE SET NULL, so
-- deleting a run (retention) or a workspace (cascade) made its spend vanish
-- from monthly budgets, per-key spend limits and dashboards, while the credit
-- debit had already been applied.
--
-- Writers now stamp the attributed scope at write time (worker ledger:
-- usage-event-store.ts; API ledger: server/src/lib/ai-usage.ts):
--   org_id        the org the spend counts against
--   workspace_id  the single attributed workspace; NULL for org-only events
--                 and for cross-workspace answers, which keep their split in
--                 metadata.workspaceIds
--   api_key_id    the API key that authorised the spend (request key, else
--                 the key that started the run)
-- The columns deliberately have no foreign keys: they must outlive the run,
-- workspace and key they name.
ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS org_id text,
  ADD COLUMN IF NOT EXISTS workspace_id text,
  ADD COLUMN IF NOT EXISTS api_key_id text;
--> statement-breakpoint
-- Backfill with the previous read-time rule, in priority order.
-- 1. Run-linked events: the run's workspace and org, and the run's key.
--    metadata.runId keeps them classified as ingest spend after run deletion.
UPDATE usage_events ue
SET metadata = ue.metadata || jsonb_build_object('runId', wr.id),
    workspace_id = wr.workspace_id,
    org_id = wr.org_id,
    api_key_id = coalesce(ue.metadata ->> 'apiKeyId', wr.stats ->> 'apiKeyId')
FROM workspace_runs wr
WHERE wr.id = ue.run_id
  AND ue.workspace_id IS NULL;
--> statement-breakpoint
-- 2. Run-less events naming one workspace, directly or through their Search Session.
UPDATE usage_events ue
SET workspace_id = coalesce(
  ue.metadata ->> 'workspaceId',
  (
    SELECT CASE WHEN jsonb_typeof(ss.metadata) = 'string'
      THEN (ss.metadata #>> '{}')::jsonb ->> 'workspaceId'
      ELSE ss.metadata ->> 'workspaceId'
    END
    FROM search_sessions ss
    WHERE ss.id = ue.metadata ->> 'sessionId'
  )
)
WHERE ue.run_id IS NULL
  AND ue.workspace_id IS NULL;
--> statement-breakpoint
-- Org: the attributed workspace's org, else the first split workspace's org, else metadata.orgId.
UPDATE usage_events ue
SET org_id = coalesce(
  (SELECT w.org_id FROM workspaces w WHERE w.id = ue.workspace_id),
  (
    SELECT w.org_id
    FROM workspaces w
    WHERE jsonb_typeof(ue.metadata -> 'workspaceIds') = 'array'
      AND w.id = ue.metadata -> 'workspaceIds' ->> 0
  ),
  ue.metadata ->> 'orgId'
)
WHERE ue.org_id IS NULL;
--> statement-breakpoint
UPDATE usage_events
SET api_key_id = metadata ->> 'apiKeyId'
WHERE api_key_id IS NULL
  AND metadata ? 'apiKeyId';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_events_org_created_idx
  ON usage_events (org_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_events_workspace_created_idx
  ON usage_events (workspace_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS usage_events_api_key_id_created_idx
  ON usage_events (api_key_id, created_at)
  WHERE api_key_id IS NOT NULL;
--> statement-breakpoint
-- Replaced by the api_key_id column index.
DROP INDEX IF EXISTS usage_events_api_key_created_idx;

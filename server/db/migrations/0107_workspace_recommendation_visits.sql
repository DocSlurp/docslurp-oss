-- One bounded record per reader/workspace. Only aggregate snapshots are retained;
-- raw queries stay in the existing activity tables. Tokens are server-issued.
CREATE TABLE workspace_recommendation_visits (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  acknowledged_at timestamptz,
  pending_token uuid,
  pending_snapshot jsonb,
  PRIMARY KEY (user_id, org_id, workspace_id),
  CHECK ((pending_token IS NULL) = (pending_snapshot IS NULL))
);
CREATE INDEX workspace_recommendation_visits_workspace_idx ON workspace_recommendation_visits (workspace_id);
-- The start of tracking is fixed; acknowledgement must never skip a transaction
-- that was invisible at snapshot time but commits later with an older created_at.
ALTER TABLE workspace_recommendation_visits ADD COLUMN tracking_since timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE workspace_recommendation_visits ADD COLUMN pending_events jsonb;
CREATE TABLE workspace_recommendation_seen_events (
  user_id text NOT NULL,
  org_id text NOT NULL,
  workspace_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('search', 'message', 'run')),
  event_id text NOT NULL,
  event_created_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, org_id, workspace_id, source, event_id),
  FOREIGN KEY (user_id, org_id, workspace_id)
    REFERENCES workspace_recommendation_visits(user_id, org_id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX workspace_recommendation_seen_expiry_idx
  ON workspace_recommendation_seen_events (user_id, org_id, workspace_id, event_created_at);

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

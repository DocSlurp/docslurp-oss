-- destructive-migration: pre-release owner decision (2026-11-04) that a user belongs to exactly one organization. Memberships beyond one per user are removed (copied to org_memberships_removed_backup first) and empty personal organizations of users who also belong to another organization are deleted; organizations with data and their data are kept.
--
-- Rules, applied in order to users with more than one membership:
--   1. Memberships in tombstoned organizations (deleted_at set) are removed.
--   2. Their own personal organization is deleted when it is empty (docslurp_personal_org_is_empty: no documents, runs, API keys or
--      webhooks, and never funded; the automatic signup grant does not count); the membership goes with it.
--   3. Of what remains, one membership is kept: an owner/admin one before a member one, then the organization with the most
--      recent run or document, then the newest membership, then the organization id. The others are removed, and, as when a
--      member is removed (organizations.ts mutateMembership), the user's API keys and MCP grants there are revoked, their direct
--      workspace shares there are deleted, and workspaces they owned there pass to that organization's longest-standing owner.
-- server/db/predeploy-check.mjs counts each of these. A unique index then refuses a second membership.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE organizations, org_memberships IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- "A personal organization with no data": the one an invite or leaving may replace (organizations.ts) and the one rule 2 deletes.
CREATE OR REPLACE FUNCTION docslurp_personal_org_is_empty(p_org_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    -- funded_at: never paid. The automatic signup grant (credit_ledger/credit_grants) is not data.
    SELECT o.is_personal AND o.funded_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM documents d JOIN workspaces w ON w.id = d.workspace_id WHERE w.org_id = o.id)
      AND NOT EXISTS (SELECT 1 FROM workspace_runs r JOIN workspaces w ON w.id = r.workspace_id WHERE w.org_id = o.id)
      AND NOT EXISTS (SELECT 1 FROM workspace_runs r WHERE r.org_id = o.id)
      AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.org_id = o.id)
      AND NOT EXISTS (SELECT 1 FROM webhooks h WHERE h.org_id = o.id)
    FROM organizations o WHERE o.id = p_org_id
  ), false)
$$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS org_memberships_removed_backup (
  org_id text NOT NULL,
  user_id text NOT NULL,
  role text NOT NULL,
  created_at timestamptz NOT NULL,
  reason text NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TEMP TABLE removed_memberships (org_id text NOT NULL, user_id text NOT NULL, reason text NOT NULL) ON COMMIT DROP;
--> statement-breakpoint
-- Rule 1.
INSERT INTO removed_memberships (org_id, user_id, reason)
SELECT om.org_id, om.user_id, 'deleted_organization'
FROM org_memberships om
JOIN organizations o ON o.id = om.org_id
WHERE o.deleted_at IS NOT NULL
  AND (SELECT count(*) FROM org_memberships other WHERE other.user_id = om.user_id) > 1;
--> statement-breakpoint
-- Rule 2: only while the user keeps another live membership.
INSERT INTO removed_memberships (org_id, user_id, reason)
SELECT om.org_id, om.user_id, 'empty_personal_organization'
FROM org_memberships om
JOIN organizations o ON o.id = om.org_id AND o.is_personal AND o.personal_owner_user_id = om.user_id AND o.deleted_at IS NULL
WHERE docslurp_personal_org_is_empty(o.id)
  AND EXISTS (
    SELECT 1 FROM org_memberships other
    JOIN organizations oo ON oo.id = other.org_id AND oo.deleted_at IS NULL
    WHERE other.user_id = om.user_id AND other.org_id <> om.org_id
  );
--> statement-breakpoint
-- Rule 3.
INSERT INTO removed_memberships (org_id, user_id, reason)
SELECT ranked.org_id, ranked.user_id, 'not_kept'
FROM (
  SELECT om.org_id, om.user_id,
    row_number() OVER (
      PARTITION BY om.user_id
      ORDER BY (om.role IN ('owner', 'admin')) DESC, activity.at DESC NULLS LAST, om.created_at DESC, om.org_id
    ) AS position
  FROM org_memberships om
  LEFT JOIN LATERAL (
    SELECT greatest(
      (SELECT max(r.created_at) FROM workspace_runs r WHERE r.org_id = om.org_id),
      (SELECT max(d.created_at) FROM documents d JOIN workspaces w ON w.id = d.workspace_id WHERE w.org_id = om.org_id)
    ) AS at
  ) activity ON true
  WHERE NOT EXISTS (SELECT 1 FROM removed_memberships gone WHERE gone.org_id = om.org_id AND gone.user_id = om.user_id)
) ranked
WHERE ranked.position > 1;
--> statement-breakpoint
INSERT INTO org_memberships_removed_backup (org_id, user_id, role, created_at, reason)
SELECT om.org_id, om.user_id, om.role, om.created_at, gone.reason
FROM org_memberships om
JOIN removed_memberships gone ON gone.org_id = om.org_id AND gone.user_id = om.user_id;
--> statement-breakpoint
UPDATE api_keys k SET revoked_at = now()
FROM removed_memberships gone
WHERE k.org_id = gone.org_id AND k.user_id = gone.user_id AND k.revoked_at IS NULL;
--> statement-breakpoint
UPDATE mcp_oauth_grants g SET revoked_at = now()
FROM removed_memberships gone
WHERE g.org_id = gone.org_id AND g.user_id = gone.user_id AND g.revoked_at IS NULL;
--> statement-breakpoint
DELETE FROM workspace_members wm
USING workspaces w, removed_memberships gone
WHERE w.id = wm.workspace_id AND w.org_id = gone.org_id AND wm.user_id = gone.user_id;
--> statement-breakpoint
DELETE FROM org_memberships om
USING removed_memberships gone
WHERE om.org_id = gone.org_id AND om.user_id = gone.user_id;
--> statement-breakpoint
-- Workspaces the user owned in an organization they left pass to its longest-standing owner, when it still has one.
UPDATE workspaces w
SET user_id = heir.user_id, updated_at = now()
FROM removed_memberships gone
JOIN LATERAL (
  SELECT om.user_id FROM org_memberships om
  WHERE om.org_id = gone.org_id AND om.role = 'owner'
  ORDER BY om.created_at, om.user_id LIMIT 1
) heir ON true
WHERE gone.reason = 'not_kept' AND w.org_id = gone.org_id AND w.user_id = gone.user_id;
--> statement-breakpoint
DELETE FROM organizations o
USING removed_memberships gone
WHERE gone.reason = 'empty_personal_organization' AND o.id = gone.org_id;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS org_memberships_one_org_per_user ON org_memberships (user_id);

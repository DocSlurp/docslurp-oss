-- destructive-migration: pre-release owner decision (2026-11-04) that a user belongs to exactly one organization. Memberships beyond one per user are removed (copied to org_memberships_removed_backup first) and empty personal organizations of users who also belong to another organization are deleted; organizations with data and their data are kept, and no live team organization is left without an owner while it has members.
--
-- Rules (the plan below; server/db/predeploy-check.mjs runs the same SQL, read from this file, and lists every user it affects):
--   1. Every membership in a tombstoned organization (deleted_at set) is removed, whatever else the user belongs to.
--   2. A user's own personal organization is deleted when it is empty and the user keeps another live membership; the
--      membership goes with it. Empty (docslurp_personal_org_is_empty): no documents, no runs, no unrevoked API keys, no
--      webhooks, and never funded. A revoked key is not data, and the automatic signup grant does not count as funding.
--   3. Of what remains, one membership is kept per user. Ranking: a team organization before a personal one, then the
--      organization with the most recent run or document, then the stronger role (owner, admin, member), then the
--      longest-standing membership, then the organization id. The others are removed and handled as a member removal
--      (organizations.ts mutateMembership): the user's API keys and MCP grants there are revoked and their direct
--      workspace shares there deleted.
--   4. No live team organization is left without an owner. When rule 3 removes an organization's last owner(s) and members
--      remain, its longest-standing admin, else its longest-standing member, is promoted to owner (audit_log
--      'organization.member.promoted_to_owner'). Workspaces a removed user owned there pass to its longest-standing owner,
--      the promoted one included. An organization with no member left keeps its data and has no owner; the pre-deploy
--      report lists it, and lists every removal from a funded organization as a BLOCKER until an owner acknowledges it.
-- A unique index then refuses a second membership.
--
-- Locks: the release's lock prelude, the same in every lock-taking migration of it (0122, 0123, 0125, 0126, 0127; see 0122).
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE documents IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE upload_session_files IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE organizations, org_memberships IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
LOCK TABLE api_keys IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE webhooks IN ACCESS EXCLUSIVE MODE;
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
      AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.org_id = o.id AND k.revoked_at IS NULL)
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
-- Rules 1-3: every membership to remove, with its reason. Read verbatim by predeploy-check.mjs; keep it one SELECT.
CREATE TEMP TABLE removed_memberships ON COMMIT DROP AS
-- one-org-plan:begin
WITH candidate AS (
  -- Organizations a removal can touch: tombstoned ones with members, and those of users with several memberships.
  SELECT o.id, o.is_personal, o.personal_owner_user_id, o.deleted_at IS NOT NULL AS tombstoned
  FROM organizations o
  WHERE EXISTS (
    SELECT 1 FROM org_memberships om
    WHERE om.org_id = o.id
      AND (o.deleted_at IS NOT NULL OR EXISTS (SELECT 1 FROM org_memberships other WHERE other.user_id = om.user_id AND other.org_id <> om.org_id))
  )
),
org_state AS (
  SELECT candidate.id, candidate.is_personal, candidate.personal_owner_user_id, candidate.tombstoned,
    docslurp_personal_org_is_empty(candidate.id) AS personal_empty,
    greatest(
      (SELECT max(r.created_at) FROM workspace_runs r WHERE r.org_id = candidate.id),
      (SELECT max(d.created_at) FROM documents d JOIN workspaces w ON w.id = d.workspace_id WHERE w.org_id = candidate.id)
    ) AS last_activity
  FROM candidate
),
rule_deleted AS (
  SELECT om.org_id, om.user_id, 'deleted_organization'::text AS reason
  FROM org_memberships om
  JOIN org_state s ON s.id = om.org_id
  WHERE s.tombstoned
),
rule_empty AS (
  SELECT om.org_id, om.user_id, 'empty_personal_organization'::text AS reason
  FROM org_memberships om
  JOIN org_state s ON s.id = om.org_id AND s.is_personal AND NOT s.tombstoned AND s.personal_owner_user_id = om.user_id AND s.personal_empty
  WHERE EXISTS (
    SELECT 1 FROM org_memberships other
    JOIN organizations live ON live.id = other.org_id AND live.deleted_at IS NULL
    WHERE other.user_id = om.user_id AND other.org_id <> om.org_id
  )
),
ranked AS (
  SELECT om.org_id, om.user_id,
    row_number() OVER (
      PARTITION BY om.user_id
      ORDER BY s.is_personal, s.last_activity DESC NULLS LAST,
        CASE om.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, om.created_at, om.org_id
    ) AS position
  FROM org_memberships om
  JOIN org_state s ON s.id = om.org_id
  WHERE NOT EXISTS (SELECT 1 FROM rule_deleted gone WHERE gone.org_id = om.org_id AND gone.user_id = om.user_id)
    AND NOT EXISTS (SELECT 1 FROM rule_empty gone WHERE gone.org_id = om.org_id AND gone.user_id = om.user_id)
)
SELECT org_id, user_id, reason FROM rule_deleted
UNION ALL SELECT org_id, user_id, reason FROM rule_empty
UNION ALL SELECT org_id, user_id, 'not_kept'::text FROM ranked WHERE position > 1
-- one-org-plan:end
;
--> statement-breakpoint
-- Rule 4: one promotion per live team organization whose last owner(s) rule 3 removes and that keeps members. Computed before
-- any row changes, from the same state the plan saw. Read verbatim by predeploy-check.mjs.
CREATE TEMP TABLE owner_promotions ON COMMIT DROP AS
-- one-org-promotions:begin
SELECT DISTINCT ON (om.org_id) om.org_id, om.user_id, om.role AS previous_role
FROM org_memberships om
JOIN organizations o ON o.id = om.org_id AND o.deleted_at IS NULL AND NOT o.is_personal
WHERE EXISTS (
    SELECT 1 FROM removed_memberships gone
    JOIN org_memberships was ON was.org_id = gone.org_id AND was.user_id = gone.user_id
    WHERE gone.org_id = om.org_id AND gone.reason = 'not_kept' AND was.role = 'owner'
  )
  AND NOT EXISTS (SELECT 1 FROM removed_memberships gone WHERE gone.org_id = om.org_id AND gone.user_id = om.user_id)
  AND NOT EXISTS (
    SELECT 1 FROM org_memberships owner
    WHERE owner.org_id = om.org_id AND owner.role = 'owner'
      AND NOT EXISTS (SELECT 1 FROM removed_memberships gone WHERE gone.org_id = owner.org_id AND gone.user_id = owner.user_id)
  )
ORDER BY om.org_id, CASE om.role WHEN 'admin' THEN 0 ELSE 1 END, om.created_at, om.user_id
-- one-org-promotions:end
;
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
UPDATE org_memberships om SET role = 'owner'
FROM owner_promotions p
WHERE om.org_id = p.org_id AND om.user_id = p.user_id;
--> statement-breakpoint
INSERT INTO audit_log (id, org_id, user_id, action, resource_type, resource_id, metadata)
SELECT gen_random_uuid()::text, p.org_id, p.user_id, 'organization.member.promoted_to_owner', 'org-membership', p.org_id || ':' || p.user_id,
  jsonb_build_object('previousRole', p.previous_role, 'reason', 'last_owner_removed_by_migration_0127')
FROM owner_promotions p;
--> statement-breakpoint
-- Workspaces the user owned in an organization they left pass to its longest-standing owner (after rule 4, so a promoted owner
-- inherits them), when it has one.
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

-- destructive-migration: pre-release owner decision (2026-11-04) that a user belongs to exactly one organization. Memberships beyond one per user are removed (copied to org_memberships_removed_backup first) and empty personal organizations of users who also belong to another organization are deleted; organizations with data and their data are kept, and no live team organization is left without an owner while it has members.
--
-- Rules (the plan below; server/db/predeploy-check.mjs runs the same SQL, read from this file, and lists every user it affects):
--   1. Every membership in a tombstoned organization (deleted_at set) is removed, whatever else the user belongs to.
--   2. A user's own personal organization is deleted when it is empty and the user keeps another live membership; the
--      membership goes with it, and so do its remaining (empty) workspaces, deleted explicitly because workspaces.org_id has
--      no foreign key (copied to organizations_removed_backup first). Empty (docslurp_personal_org_is_empty) fails closed:
--      no member but its owner, no documents, runs, chat sessions or chat operations, no upload session still in flight, no
--      media job or admission, no connector, workspace share or workspace invite, no unrevoked API key or MCP grant, no
--      webhook, no Stripe customer, and never funded (funded_at, or auto top-up enabled). A revoked key is not data, and the
--      automatic signup grant does not count as funding. An organization that fails any of these is kept with its data.
--   3. Of what remains, one membership is kept per user. Ranking: a funded organization (funded_at or auto top-up) first, then a team before a personal one, then the
--      organization with the most recent run or document, then the stronger role (owner, admin, member), then the
--      longest-standing membership, then the organization id. The others are removed and handled as a member removal
--      (organizations.ts mutateMembership): the user's API keys and MCP grants there are revoked and their direct
--      workspace shares there deleted.
--   4. No live organization is left with members but no owner, and nobody becomes an owner unacknowledged. Every live
--      team organization that, after rules 1-3, has members but no owner (whether rule 3 removed its last owner or it had
--      none) has its longest-standing admin, else its longest-standing member, promoted to owner (audit_log
--      'organization.member.promoted_to_owner'). Workspaces a removed user owned there pass to its longest-standing owner,
--      the promoted one included. A live personal organization in that state (its owner leaves, a guest stays) is never
--      given another user as owner: the migration aborts and names it, and an operator resolves it first. An organization
--      with no member left keeps its data and has no owner; the pre-deploy report lists it.
--   5. Acknowledgement. A removal from a funded organization and every promotion to owner need an owner's review (a plain
--      member promoted is called out): the pre-deploy report lists them as a BLOCKER with a hash of exactly that list, and
--      this migration refuses to run unless the session setting docslurp.ack_0127 holds the same hash (server/db/migrate.mjs
--      sets it from DOCSLURP_ACK_0127). A missing or stale acknowledgement aborts the whole migration run and changes nothing.
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
-- 0127 only, after the shared prelude: the plan reads runs and workspaces, and a run or workspace written between the plan
-- and the deletes below would be lost with an organization the plan judged empty.
LOCK TABLE workspaces, workspace_runs IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- "A personal organization with no data": the one an invite or leaving may replace (organizations.ts) and the one rule 2 deletes.
CREATE OR REPLACE FUNCTION docslurp_personal_org_is_empty(p_org_id text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce((
    -- Never funded: no paid balance and no auto top-up. The automatic signup grant (credit_ledger/credit_grants) is not data.
    SELECT o.is_personal AND o.funded_at IS NULL AND NOT coalesce(o.auto_recharge_enabled, false) AND o.stripe_customer_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM org_memberships m WHERE m.org_id = o.id AND m.user_id IS DISTINCT FROM o.personal_owner_user_id)
      AND NOT EXISTS (SELECT 1 FROM documents d JOIN workspaces w ON w.id = d.workspace_id WHERE w.org_id = o.id)
      AND NOT EXISTS (SELECT 1 FROM workspace_runs r JOIN workspaces w ON w.id = r.workspace_id WHERE w.org_id = o.id)
      AND NOT EXISTS (SELECT 1 FROM workspace_runs r WHERE r.org_id = o.id)
      AND NOT EXISTS (SELECT 1 FROM chat_sessions c JOIN workspaces w ON w.id = c.workspace_id WHERE w.org_id = o.id)
      AND NOT EXISTS (SELECT 1 FROM chat_operations c WHERE c.org_id = o.id)
      AND NOT EXISTS (SELECT 1 FROM upload_sessions u WHERE (u.org_id = o.id OR u.workspace_id IN (SELECT w.id FROM workspaces w WHERE w.org_id = o.id))
        AND coalesce(u.status, 'pending') NOT IN ('confirmed', 'aborted', 'failed'))
      AND NOT EXISTS (SELECT 1 FROM remote_media_jobs j WHERE j.org_id = o.id)
      AND NOT EXISTS (SELECT 1 FROM media_video_admissions a WHERE a.org_id = o.id)
      AND NOT EXISTS (SELECT 1 FROM workspace_connectors c JOIN workspaces w ON w.id = c.workspace_id WHERE w.org_id = o.id)
      AND NOT EXISTS (SELECT 1 FROM workspace_members m JOIN workspaces w ON w.id = m.workspace_id WHERE w.org_id = o.id AND m.user_id IS DISTINCT FROM o.personal_owner_user_id)
      AND NOT EXISTS (SELECT 1 FROM workspace_invites i WHERE i.org_id = o.id OR i.workspace_id IN (SELECT w.id FROM workspaces w WHERE w.org_id = o.id))
      AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.org_id = o.id AND k.revoked_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM mcp_oauth_grants g WHERE g.org_id = o.id AND g.revoked_at IS NULL)
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
-- Rule 2's deleted organizations and the (empty) workspaces deleted with them, as they were.
CREATE TABLE IF NOT EXISTS organizations_removed_backup (
  org_id text NOT NULL,
  organization jsonb NOT NULL,
  workspaces jsonb NOT NULL,
  reason text NOT NULL,
  removed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Rules 1-3: every membership to remove, with its reason. Read verbatim by predeploy-check.mjs; keep it one SELECT.
CREATE TEMP TABLE removed_memberships ON COMMIT DROP AS
-- one-org-plan:begin
WITH candidate AS (
  -- Organizations a removal can touch: tombstoned ones with members, and those of users with several memberships.
  SELECT o.id, o.is_personal, o.personal_owner_user_id, o.deleted_at IS NOT NULL AS tombstoned,
    (o.funded_at IS NOT NULL OR coalesce(o.auto_recharge_enabled, false)) AS funded
  FROM organizations o
  WHERE EXISTS (
    SELECT 1 FROM org_memberships om
    WHERE om.org_id = o.id
      AND (o.deleted_at IS NOT NULL OR EXISTS (SELECT 1 FROM org_memberships other WHERE other.user_id = om.user_id AND other.org_id <> om.org_id))
  )
),
org_state AS (
  SELECT candidate.id, candidate.is_personal, candidate.personal_owner_user_id, candidate.tombstoned, candidate.funded,
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
      ORDER BY s.funded DESC, s.is_personal, s.last_activity DESC NULLS LAST,
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
-- Rule 4: one promotion per live team organization that keeps members but no owner after rules 1-3. Computed before any
-- row changes, from the same state the plan saw. Read verbatim by predeploy-check.mjs.
CREATE TEMP TABLE owner_promotions ON COMMIT DROP AS
-- one-org-promotions:begin
SELECT DISTINCT ON (om.org_id) om.org_id, om.user_id, om.role AS previous_role
FROM org_memberships om
JOIN organizations o ON o.id = om.org_id AND o.deleted_at IS NULL AND NOT o.is_personal
WHERE NOT EXISTS (SELECT 1 FROM removed_memberships gone WHERE gone.org_id = om.org_id AND gone.user_id = om.user_id)
  AND NOT EXISTS (
    SELECT 1 FROM org_memberships owner
    WHERE owner.org_id = om.org_id AND owner.role = 'owner'
      AND NOT EXISTS (SELECT 1 FROM removed_memberships gone WHERE gone.org_id = owner.org_id AND gone.user_id = owner.user_id)
  )
ORDER BY om.org_id, CASE om.role WHEN 'admin' THEN 0 ELSE 1 END, om.created_at, om.user_id
-- one-org-promotions:end
;
--> statement-breakpoint
-- Rule 4's limit: live organizations that would keep members but no owner and get no promotion (personal ones). Read
-- verbatim by predeploy-check.mjs. The migration aborts while any exists.
CREATE TEMP TABLE ownerless_organizations ON COMMIT DROP AS
-- one-org-ownerless:begin
SELECT o.id AS org_id, o.is_personal,
  (SELECT count(*) FROM org_memberships m WHERE m.org_id = o.id
     AND NOT EXISTS (SELECT 1 FROM removed_memberships gone WHERE gone.org_id = m.org_id AND gone.user_id = m.user_id))::int AS members_left
FROM organizations o
WHERE o.deleted_at IS NULL
  AND EXISTS (SELECT 1 FROM org_memberships m WHERE m.org_id = o.id
    AND NOT EXISTS (SELECT 1 FROM removed_memberships gone WHERE gone.org_id = m.org_id AND gone.user_id = m.user_id))
  AND NOT EXISTS (SELECT 1 FROM org_memberships m WHERE m.org_id = o.id AND m.role = 'owner'
    AND NOT EXISTS (SELECT 1 FROM removed_memberships gone WHERE gone.org_id = m.org_id AND gone.user_id = m.user_id))
  AND NOT EXISTS (SELECT 1 FROM owner_promotions p WHERE p.org_id = o.id)
-- one-org-ownerless:end
;
--> statement-breakpoint
DO $$
DECLARE listed text; total int;
BEGIN
  SELECT count(*), string_agg(org_id, ', ' ORDER BY org_id) FILTER (WHERE rn <= 50) INTO total, listed
  FROM (SELECT org_id, row_number() OVER (ORDER BY org_id) AS rn FROM ownerless_organizations) x;
  IF total > 0 THEN
    RAISE EXCEPTION '0127 refused: % organization(s) would keep members but no owner and cannot be given one: %', total, listed
      USING HINT = 'These are personal organizations whose owner leaves while another member stays. Resolve each (restore its owner, or remove or move the other members), then re-run node server/db/predeploy-check.mjs.';
  END IF;
END $$;
--> statement-breakpoint
-- Rule 5: what needs an owner's acknowledgement, and the hash of exactly that list. Read verbatim by predeploy-check.mjs,
-- which prints the hash; keep it one SELECT over removed_memberships and owner_promotions.
CREATE TEMP TABLE one_org_ack ON COMMIT DROP AS
-- one-org-ack:begin
SELECT count(*) FILTER (WHERE item.kind = 'funded_removal')::int AS funded_removals,
  count(*) FILTER (WHERE item.kind = 'owner_promotion')::int AS promotions,
  count(*) FILTER (WHERE item.kind = 'owner_promotion' AND item.previous_role = 'member')::int AS member_promotions,
  CASE WHEN count(*) = 0 THEN NULL ELSE left(encode(sha256(convert_to(
    string_agg(item.kind || E'\t' || item.user_id || E'\t' || item.org_id || E'\t' || item.previous_role, E'\n'
      ORDER BY item.kind || E'\t' || item.user_id || E'\t' || item.org_id || E'\t' || item.previous_role COLLATE "C"),
    'UTF8')), 'hex'), 16) END AS hash
FROM (
  SELECT 'funded_removal'::text AS kind, gone.user_id, gone.org_id, ''::text AS previous_role
  FROM removed_memberships gone JOIN organizations o ON o.id = gone.org_id
  WHERE gone.reason = 'not_kept' AND (o.funded_at IS NOT NULL OR coalesce(o.auto_recharge_enabled, false))
  UNION ALL
  SELECT 'owner_promotion'::text, p.user_id, p.org_id, p.previous_role FROM owner_promotions p
) item
-- one-org-ack:end
;
--> statement-breakpoint
DO $$
DECLARE
  need record;
  given text := nullif(btrim(current_setting('docslurp.ack_0127', true)), '');
BEGIN
  SELECT * INTO need FROM one_org_ack;
  IF need.hash IS NOT NULL AND given IS NULL THEN
    RAISE EXCEPTION '0127 refused: it would remove % membership(s) from funded organizations and promote % member(s) to owner (% of them plain members) without an acknowledgement', need.funded_removals, need.promotions, need.member_promotions
      USING HINT = 'Review the list with node server/db/predeploy-check.mjs, then run the migrator with DOCSLURP_ACK_0127 set to the hash it prints.';
  ELSIF need.hash IS NOT NULL AND given IS DISTINCT FROM need.hash THEN
    RAISE EXCEPTION '0127 refused: DOCSLURP_ACK_0127=% does not match the current plan (% funded removal(s), % promotion(s) to owner, % of them plain members); the data changed since it was reviewed', left(given, 64), need.funded_removals, need.promotions, need.member_promotions
      USING HINT = 'Re-run node server/db/predeploy-check.mjs, review the new list and acknowledge its hash.';
  END IF;
END $$;
--> statement-breakpoint
-- Rule 2 under row locks: lock the organizations it deletes and their workspaces (a concurrent insert that references them
-- now waits), then re-check that each is still empty. A chat, upload or share written since the plan aborts the migration
-- instead of being deleted with the organization.
DO $$
BEGIN
  PERFORM 1 FROM organizations o JOIN removed_memberships gone ON gone.org_id = o.id AND gone.reason = 'empty_personal_organization' FOR UPDATE OF o;
  PERFORM 1 FROM workspaces w JOIN removed_memberships gone ON gone.org_id = w.org_id AND gone.reason = 'empty_personal_organization' FOR UPDATE OF w;
  IF EXISTS (SELECT 1 FROM removed_memberships gone WHERE gone.reason = 'empty_personal_organization' AND NOT docslurp_personal_org_is_empty(gone.org_id)) THEN
    RAISE EXCEPTION '0127 refused: a personal organization the plan found empty gained data while the migration ran; re-run it';
  END IF;
END $$;
--> statement-breakpoint
INSERT INTO organizations_removed_backup (org_id, organization, workspaces, reason)
SELECT o.id, to_jsonb(o),
  coalesce((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id) FROM workspaces w WHERE w.org_id = o.id), '[]'::jsonb),
  gone.reason
FROM organizations o JOIN removed_memberships gone ON gone.org_id = o.id AND gone.reason = 'empty_personal_organization';
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
-- Rule 2: the empty organization's workspaces first (no foreign key would remove them), then the organization.
DELETE FROM workspaces w
USING removed_memberships gone
WHERE gone.reason = 'empty_personal_organization' AND w.org_id = gone.org_id;
--> statement-breakpoint
DELETE FROM organizations o
USING removed_memberships gone
WHERE gone.reason = 'empty_personal_organization' AND o.id = gone.org_id;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS org_memberships_one_org_per_user ON org_memberships (user_id);

-- destructive-migration: single release (pre-release; production data may be reset). The organization is the only tenant scope: webhooks and api_keys rows that cannot be given exactly one organization are deleted, and org_id becomes NOT NULL on both.
--
-- (1) Webhooks were keyed to the user who created them, so a team's webhook never fired for a teammate's runs and a user in
-- several organizations had one webhook firing for all of them. A webhook now belongs to exactly one organization and receives
-- that organization's run events (whoever started the run) while its creator is still an owner or admin there. There is no
-- per-workspace scope: workspaces are an organizing tool, not a tenant.
-- Old rows are not homed by guesswork. A webhook is moved to an organization only when its creator belongs to exactly one live
-- organization and is an owner or admin there (the rule for creating an org webhook today). Every other webhook is deleted, with
-- its delivery log (webhook_deliveries cascades): which of several organizations it was meant for cannot be known, and a
-- member-created one would never deliver. No copy is kept; it would only hold signing secrets nobody can use.
--
-- (2) api_keys without an org. validateApiKey has refused keys with a NULL org_id since the organization model landed, and every
-- insert path (api-keys.ts createApiKey and rotateApiKey, mcp-oauth.ts createGrant, whose orgId is a required string) sets it. Such a key is
-- moved, revoked, to its owner's organization when the owner belongs to exactly one live organization (so its audit and usage
-- history stays with that tenant), and deleted otherwise, revoked or not. Re-homing never revives a key: it stays revoked.
--
-- Lock order (as 0063): organizations, then webhooks, the order a worker transaction takes them, so this migration and a worker
-- transaction cannot deadlock. lock_timeout fails the deploy instead of queueing readers of a hot table behind a long
-- transaction; a retried deploy finishes the work. server/db/predeploy-check.mjs counts what this deletes.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE organizations IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE webhooks IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
UPDATE webhooks wh
SET org_id = only_org.org_id
FROM (
  SELECT om.user_id, min(om.org_id) AS org_id, bool_and(om.role IN ('owner', 'admin')) AS administers
  FROM org_memberships om
  JOIN organizations o ON o.id = om.org_id AND o.deleted_at IS NULL
  GROUP BY om.user_id
  HAVING count(*) = 1
) only_org
WHERE wh.org_id IS NULL AND only_org.user_id = wh.user_id AND only_org.administers;
--> statement-breakpoint
DELETE FROM webhooks WHERE org_id IS NULL;
--> statement-breakpoint
ALTER TABLE webhooks ALTER COLUMN org_id SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhooks_org_active_idx ON webhooks (org_id) WHERE active;
--> statement-breakpoint
-- api_keys is read and touched on every API request: wait only briefly for its lock.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
UPDATE api_keys k
SET org_id = only_org.org_id, revoked_at = coalesce(k.revoked_at, now())
FROM (
  SELECT om.user_id, min(om.org_id) AS org_id
  FROM org_memberships om
  JOIN organizations o ON o.id = om.org_id AND o.deleted_at IS NULL
  GROUP BY om.user_id
  HAVING count(*) = 1
) only_org
WHERE k.org_id IS NULL AND only_org.user_id = k.user_id;
--> statement-breakpoint
DELETE FROM api_keys WHERE org_id IS NULL;
--> statement-breakpoint
ALTER TABLE api_keys ALTER COLUMN org_id SET NOT NULL;
--> statement-breakpoint
-- The worker's subscription check (enqueueWebhookEvent) reads org_id; roles.mjs grants it on every reconcile, and this grant
-- covers a release that migrates before reconciling.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_worker') THEN
    GRANT SELECT (org_id) ON public.webhooks TO docslurp_worker;
  END IF;
END $$;

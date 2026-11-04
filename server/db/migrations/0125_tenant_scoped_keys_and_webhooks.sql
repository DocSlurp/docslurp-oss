-- Expand step for two shapes that carried no tenant. The contract step (NOT NULL, deleting what cannot be homed) is a
-- later release: docs/rollout-expand-contract-0121-0125.md.
--
-- (1) api_keys without an org. validateApiKey has rejected keys with a NULL org_id since the organization model landed, so no
-- release serves them; every insert path in release N-1 (api-keys.ts createApiKey and rotateApiKey, mcp-oauth.ts createGrant) sets
-- org_id. Such keys are revoked (fail closed) and, where the owner has a personal organization, re-homed there; that
-- never grants a key access it did not have. Nothing is deleted. A NOT VALID check forbids new live rows without an org
-- (a revoked row may lack one, so updates of the dead rows keep working) while they stay for the contract step to remove.
--
-- (2) Webhooks were keyed to the user who created them, so a team's webhook never fired for a teammate's runs; they now
-- belong to an organization (and optionally one of its workspaces). org_id is added NULLABLE: during the rolling
-- migrate -> worker -> app window, and on rollback, release N-1 still inserts webhooks without it. A BEFORE INSERT trigger
-- homes such a row exactly as the backfill does, so a webhook created by old code is not silently dead for new code.
-- Backfill order: the organization of the runs the webhook itself delivered for (its own delivery history, restricted to
-- organizations its creator belongs to), else the creator's personal organization, else an organization they own or
-- administer. A webhook with none of these keeps a NULL org_id and is left in place: new code does not match it, release N-1
-- still delivers it by user_id, and the contract step backs it up before removing it.
--
-- Lock order (as 0063): organizations and workspaces first (what a worker transaction that updates a workspace and then reads
-- webhooks holds), then webhooks, so this migration and a worker transaction cannot deadlock. lock_timeout fails the deploy
-- instead of queueing readers of a hot table behind a long transaction; a retried deploy finishes the work.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE organizations, workspaces IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE webhooks IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION docslurp_webhook_home_org(p_webhook_id text, p_user_id text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    -- the organization of the runs this webhook has delivered for, among organizations its creator belongs to
    (SELECT r.org_id
       FROM webhook_deliveries d
       JOIN workspace_runs r ON r.id = d.payload ->> 'runId'
       JOIN org_memberships om ON om.org_id = r.org_id AND om.user_id = p_user_id
       WHERE d.webhook_id = p_webhook_id AND r.org_id IS NOT NULL
       GROUP BY r.org_id
       ORDER BY count(*) DESC, r.org_id
       LIMIT 1),
    -- else the creator's personal organization, else one they own or administer
    (SELECT o.id
       FROM org_memberships om
       JOIN organizations o ON o.id = om.org_id
       WHERE om.user_id = p_user_id AND om.role IN ('owner', 'admin')
       ORDER BY o.is_personal DESC, om.created_at, o.id
       LIMIT 1)
  )
$$;
--> statement-breakpoint
UPDATE webhooks wh SET org_id = docslurp_webhook_home_org(wh.id, wh.user_id) WHERE wh.org_id IS NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION docslurp_webhooks_default_org() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.org_id IS NULL THEN
    NEW.org_id := docslurp_webhook_home_org(NEW.id, NEW.user_id);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS webhooks_default_org ON webhooks;
--> statement-breakpoint
CREATE TRIGGER webhooks_default_org BEFORE INSERT ON webhooks
  FOR EACH ROW WHEN (NEW.org_id IS NULL) EXECUTE FUNCTION docslurp_webhooks_default_org();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhooks_org_active_idx ON webhooks (org_id) WHERE active;
--> statement-breakpoint
-- api_keys is read and touched on every API request: wait only briefly for its lock.
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE org_id IS NULL;
--> statement-breakpoint
UPDATE api_keys k
SET org_id = o.id
FROM organizations o
WHERE k.org_id IS NULL AND o.is_personal AND o.personal_owner_user_id = k.user_id;
--> statement-breakpoint
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_org_id_required;
--> statement-breakpoint
ALTER TABLE api_keys ADD CONSTRAINT api_keys_org_id_required CHECK (org_id IS NOT NULL OR revoked_at IS NOT NULL) NOT VALID;
--> statement-breakpoint
-- The worker's subscription check (enqueueWebhookEvent) reads these two columns; roles.mjs
-- grants them on every reconcile, and this grant covers a release that migrates before reconciling.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_worker') THEN
    GRANT SELECT (org_id, workspace_id) ON public.webhooks TO docslurp_worker;
  END IF;
END $$;

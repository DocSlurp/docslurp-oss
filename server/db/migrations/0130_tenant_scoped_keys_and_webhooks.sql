-- destructive-migration: contract step for two shapes that carried no tenant. (1) Keys without an org: validateApiKey has rejected keys with a NULL org_id since the organization model landed, so no release serves them; creation and rotation always set org_id. Dead keys are revoked, re-homed only to their owner's personal organization, and deleted when no such organization exists, so this never grants a key access it did not have. (2) Webhooks were keyed to the user who created them, so a team's webhook never fired for a teammate's runs; they now belong to an organization (and optionally one of its workspaces). Existing rows are re-homed to the creator's personal org, else an org they own or administer, else deleted: pre-release, and an unhomed webhook must not guess a tenant.
UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE org_id IS NULL;
--> statement-breakpoint
UPDATE api_keys k
SET org_id = o.id
FROM organizations o
WHERE k.org_id IS NULL AND o.is_personal AND o.personal_owner_user_id = k.user_id;
--> statement-breakpoint
DELETE FROM api_keys WHERE org_id IS NULL;
--> statement-breakpoint
ALTER TABLE api_keys ALTER COLUMN org_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS workspace_id text REFERENCES workspaces(id) ON DELETE CASCADE;
--> statement-breakpoint
UPDATE webhooks wh
SET org_id = (
  SELECT o.id
  FROM org_memberships om
  JOIN organizations o ON o.id = om.org_id
  WHERE om.user_id = wh.user_id AND om.role IN ('owner', 'admin')
  ORDER BY o.is_personal DESC, om.created_at, o.id
  LIMIT 1
)
WHERE org_id IS NULL;
--> statement-breakpoint
DELETE FROM webhooks WHERE org_id IS NULL;
--> statement-breakpoint
ALTER TABLE webhooks ALTER COLUMN org_id SET NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS webhooks_org_active_idx ON webhooks (org_id) WHERE active;
--> statement-breakpoint
-- The worker's subscription check (enqueueWebhookEvent) reads these two columns; roles.mjs
-- grants them on every reconcile, and this grant covers a release that migrates before reconciling.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'docslurp_worker') THEN
    GRANT SELECT (org_id, workspace_id) ON public.webhooks TO docslurp_worker;
  END IF;
END $$;

-- destructive-migration: contract step for the key-without-org shape. validateApiKey has rejected keys with a NULL org_id since the organization model landed, so no release serves them; creation and rotation always set org_id. Dead keys are revoked, re-homed only to their owner's personal organization, and deleted when no such organization exists, so this never grants a key access it did not have.
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

-- Worker capability registry: what each worker advertises about its configuration (release R0 of the extraction
-- config simplification, docs/self-host/deployment-profile.md). Workers write their extraction config version and the
-- digest of their deployment posture (profile, isolation floor, DOCSLURP_DISABLE switches); GET /ops/worker-fleet
-- shows it beside the app's own posture. Additive and nullable: older workers leave it null, which reads as "does not
-- understand extraction config v1". Holds no tenant data.
ALTER TABLE worker_capabilities ADD COLUMN IF NOT EXISTS config jsonb;

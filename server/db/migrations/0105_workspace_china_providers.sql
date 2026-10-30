-- Workspace switch for China-based model providers. It can only narrow the
-- organization's setting (organizations.allow_china_providers, 0086): a request
-- may use those providers only when both are true. On by default.
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "allow_china_providers" boolean DEFAULT true NOT NULL;

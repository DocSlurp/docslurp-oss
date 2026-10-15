ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "key_type" text NOT NULL DEFAULT 'server';

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "allowed_domains" text[] NOT NULL DEFAULT '{}';

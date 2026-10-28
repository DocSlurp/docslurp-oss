-- Platform-admin user insights (feature/admin-users), including account kinds.
-- user_signup_attribution: first-touch referrer and UTM tags captured from the
--   app's `ds_attr` cookie when the account is created. One row per user,
--   written once; values are sanitized and length-capped by the server.
-- user_client_surfaces: which client surfaces (web, api, sdk, cli, mcp, ...) a
--   user has authenticated through, with first/last seen and a request count.
--   Writes are coalesced in memory, so counts are approximate.
CREATE TABLE IF NOT EXISTS user_signup_attribution (
  user_id text PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  referrer_host text,
  referrer_url text,
  landing_path text,
  utm_source text,
  utm_medium text,
  utm_campaign text,
  utm_term text,
  utm_content text,
  first_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS user_client_surfaces (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  surface text NOT NULL,
  last_client text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  request_count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, surface),
  CONSTRAINT user_client_surfaces_surface_check CHECK (surface IN ('web', 'api', 'browser_key', 'sdk', 'cli', 'mcp', 'mcp_stdio', 'openai_compat', 'search_compat', 'widget', 'wordpress'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_client_surfaces_surface_idx ON user_client_surfaces (surface, last_seen_at DESC);
--> statement-breakpoint
-- Per-user lookups in the admin directory (and account offboarding) scanned these tables.
CREATE INDEX IF NOT EXISTS documents_user_id_idx ON documents (user_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON api_keys (user_id) WHERE revoked_at IS NULL;
--> statement-breakpoint
-- Account kind keeps staff and fake/agent-created accounts out of customer
-- metrics. customer (default) | staff | test. account_kind_source records who
-- decided: default, rule (reserved domain or env pattern) or admin (manual,
-- never overwritten by rules).
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS account_kind text NOT NULL DEFAULT 'customer';
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS account_kind_source text NOT NULL DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS account_kind_reason text;
--> statement-breakpoint
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS user_account_kind_check;
--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT user_account_kind_check CHECK (account_kind IN ('customer', 'staff', 'test'));
--> statement-breakpoint
ALTER TABLE "user" DROP CONSTRAINT IF EXISTS user_account_kind_source_check;
--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT user_account_kind_source_check CHECK (account_kind_source IN ('default', 'rule', 'admin'));
--> statement-breakpoint
-- RFC 2606/6761 reserved names: no real customer can receive mail there, and
-- every seed, e2e and pressure-test identity uses one (*.local, *.invalid, *.test).
CREATE OR REPLACE FUNCTION docslurp_reserved_test_email(email text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(split_part(coalesce(email, ''), '@', 2)) ~ '(^|\.)((test|example|invalid|localhost|local)|example\.(com|net|org))$'
$$;
--> statement-breakpoint
-- Runs for every insert, including scripts that write "user" rows directly.
CREATE OR REPLACE FUNCTION docslurp_classify_new_user() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_kind_source = 'default' AND docslurp_reserved_test_email(NEW.email) THEN
    NEW.account_kind := 'test';
    NEW.account_kind_source := 'rule';
    NEW.account_kind_reason := 'reserved test email domain';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS user_classify_account_kind ON "user";
--> statement-breakpoint
CREATE TRIGGER user_classify_account_kind BEFORE INSERT ON "user"
  FOR EACH ROW EXECUTE FUNCTION docslurp_classify_new_user();
--> statement-breakpoint
-- Backfill live accounts; tombstones carry a scrubbed @deleted.invalid address.
UPDATE "user" SET account_kind = 'test', account_kind_source = 'rule', account_kind_reason = 'reserved test email domain'
WHERE account_kind_source = 'default' AND deleted_at IS NULL AND docslurp_reserved_test_email(email);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS user_account_kind_created_idx ON "user" (account_kind, "createdAt" DESC) WHERE deleted_at IS NULL;

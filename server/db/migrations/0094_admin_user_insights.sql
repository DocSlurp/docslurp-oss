-- Platform-admin user insights (feature/admin-users).
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

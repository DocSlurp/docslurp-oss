-- First-party CLI OAuth (docslurp login). Numbered 0089: 0088 is extract mode (PR #185). The CLI is a public native client
-- (RFC 8252) with a fixed id, so it never registers dynamically. Only a
-- first-party client may obtain a token for the REST API resource
-- (<origin>/v1) or use the device authorization grant (RFC 8628); dynamically
-- registered MCP clients stay bound to <origin>/v1/mcp.
ALTER TABLE mcp_oauth_clients ADD COLUMN IF NOT EXISTS first_party boolean NOT NULL DEFAULT false;
--> statement-breakpoint
INSERT INTO mcp_oauth_clients(id, name, redirect_uris, first_party)
VALUES ('docslurp-cli', 'DocSlurp CLI', '["http://127.0.0.1/callback"]'::jsonb, true)
ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, redirect_uris = EXCLUDED.redirect_uris, first_party = true;
--> statement-breakpoint
-- Device authorization requests. Both codes are stored only as SHA-256 hashes.
-- A device code is redeemed once; approval binds it to a grant exactly once.
CREATE TABLE IF NOT EXISTS mcp_oauth_device_codes (
  device_code_hash text PRIMARY KEY,
  user_code_hash text NOT NULL UNIQUE,
  client_id text NOT NULL REFERENCES mcp_oauth_clients(id) ON DELETE CASCADE,
  resource text NOT NULL,
  scopes jsonb NOT NULL,
  interval_seconds integer NOT NULL DEFAULT 5,
  last_polled_at timestamptz,
  expires_at timestamptz NOT NULL,
  user_id text REFERENCES "user"(id) ON DELETE CASCADE,
  grant_id text REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
  approved_at timestamptz,
  denied_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mcp_oauth_device_codes_expiry_idx ON mcp_oauth_device_codes(expires_at);
--> statement-breakpoint
-- Failed user-code entries per signed-in user, for brute-force lockout.
CREATE TABLE IF NOT EXISTS mcp_oauth_device_attempts (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mcp_oauth_device_attempts_user_idx ON mcp_oauth_device_attempts(user_id, created_at);

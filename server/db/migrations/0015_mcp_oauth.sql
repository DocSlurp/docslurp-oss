CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  id text PRIMARY KEY, name text NOT NULL, redirect_uris jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mcp_oauth_requests (
  id text PRIMARY KEY, client_id text NOT NULL REFERENCES mcp_oauth_clients(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, session_id text NOT NULL REFERENCES "session"(id) ON DELETE CASCADE, redirect_uri text NOT NULL,
  resource text NOT NULL, scopes jsonb NOT NULL, challenge text NOT NULL, state text,
  expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE IF NOT EXISTS mcp_oauth_grants (
  id text PRIMARY KEY, client_id text NOT NULL REFERENCES mcp_oauth_clients(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE, org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  resource text NOT NULL, scopes jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
  hash text PRIMARY KEY, grant_id text NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('code','access','refresh')),
  redirect_uri text, challenge text, expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS mcp_oauth_tokens_grant_idx ON mcp_oauth_tokens(grant_id);
CREATE INDEX IF NOT EXISTS mcp_oauth_grants_user_idx ON mcp_oauth_grants(user_id);
CREATE INDEX IF NOT EXISTS mcp_oauth_requests_expiry_idx ON mcp_oauth_requests(expires_at);

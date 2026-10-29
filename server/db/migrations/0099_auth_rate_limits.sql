-- DocSlurp's own authentication budgets, shared by every app machine: per
-- recipient email delivery, magic-link confirmation and company SSO requests.
-- Better Auth's "rateLimit" table (0038) stays native-owned: it prunes rows
-- older than its longest configured window, which would reset any longer
-- DocSlurp window early. Keys are prefixed by purpose and never contain an
-- email address or token (recipient keys are HMACs).
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL,
  window_started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS auth_rate_limits_expires_at_idx ON auth_rate_limits (expires_at);

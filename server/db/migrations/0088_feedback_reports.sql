-- In-app feedback and bug reports (POST /v1/feedback). Each row belongs to the
-- organization the reporter acted in and, when the report named one they can
-- reach, a workspace. The message is user-authored text; the server never
-- copies raw errors, stack traces or document content into it. `trace_id` and
-- `request_id` join the report to SigNoz telemetry instead.
--
-- `alert_status` records what happened to the live team alert: high-severity
-- reports page the team unless a per-user/per-org hourly cap or a duplicate of
-- the same text suppressed the page (the report is stored either way).
CREATE TABLE IF NOT EXISTS feedback_reports (
  id text PRIMARY KEY,
  reference text NOT NULL UNIQUE,
  org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  workspace_id text REFERENCES workspaces(id) ON DELETE SET NULL,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('bug', 'feedback', 'question', 'billing', 'other')),
  severity text NOT NULL CHECK (severity IN ('normal', 'high')),
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 4000),
  message_hash text NOT NULL,
  route text,
  screen text,
  trace_id text,
  request_id text,
  error_code text,
  occurred_at timestamp with time zone,
  client_timezone text,
  user_agent text,
  app_version text,
  alert_status text NOT NULL DEFAULT 'not_applicable'
    CHECK (alert_status IN ('not_applicable', 'pending', 'sent', 'suppressed', 'failed', 'unconfigured')),
  alert_suppressed_reason text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS feedback_reports_user_created_idx ON feedback_reports (user_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS feedback_reports_org_created_idx ON feedback_reports (org_id, created_at DESC);

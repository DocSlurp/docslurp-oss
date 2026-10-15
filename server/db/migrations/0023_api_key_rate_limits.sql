-- Custom per-key limits: [{ "metric": "requests" | "spend", "limit": n, "windowSeconds": n }].
-- Request counters live in Redis (or the in-process fallback); spend limits read
-- attributed usage_events, so key attribution needs indexed lookups.
ALTER TABLE "api_keys" ADD COLUMN IF NOT EXISTS "rate_limits" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_events_api_key_created_idx"
  ON "usage_events" ((metadata ->> 'apiKeyId'), "created_at")
  WHERE metadata ? 'apiKeyId';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspace_runs_api_key_idx"
  ON "workspace_runs" ((stats ->> 'apiKeyId'))
  WHERE stats ? 'apiKeyId';

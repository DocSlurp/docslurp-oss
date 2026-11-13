-- Search history rows for API-key keyword and hybrid searches expire (SEARCH_API_HISTORY_RETENTION_DAYS, default 30);
-- the maintenance sweep deletes expired sessions, and their result rows and zero-result diagnostics cascade. NULL
-- keeps a session as before (dashboard, chat and deep searches). The partial index is empty until the code that sets
-- expires_at ships, so building it inline is instant.
ALTER TABLE "search_sessions" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_sessions_expires_at_idx" ON "search_sessions" ("expires_at") WHERE "expires_at" IS NOT NULL;

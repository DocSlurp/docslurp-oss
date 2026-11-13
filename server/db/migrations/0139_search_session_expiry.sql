-- Search history rows for API-key keyword and hybrid searches expire (search/lean-logging.ts); the maintenance sweep
-- deletes expired sessions, and their result rows and zero-result diagnostics cascade. NULL keeps a session as before
-- (dashboard, chat and deep searches). The sweep's deletes cascade through search_zero_results.session_id and set
-- chat_answer_evidence_spans.search_session_id to null, so both get an index; without them each deleted session scans
-- both tables. Built without CONCURRENTLY (migrations run in a transaction): each build holds a SHARE lock on its table
-- for one scan (search_sessions ~2 s per 600k rows, as 0087); ADD COLUMN without a default does not rewrite the table.
-- Fail fast instead of queueing every search insert behind a long-open writer; a retried deploy finishes the build.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE "search_sessions" ADD COLUMN IF NOT EXISTS "expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_sessions_expires_at_idx" ON "search_sessions" ("expires_at") WHERE "expires_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_zero_results_session_idx" ON "search_zero_results" ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_answer_evidence_spans_search_session_idx" ON "chat_answer_evidence_spans" ("search_session_id") WHERE "search_session_id" IS NOT NULL;

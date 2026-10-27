-- Workspace reads (dashboard bootstrap's listWorkspaces, GET /v1/workspaces/:id,
-- suggestions) count and date a workspace's search sessions by
-- metadata ->> 'workspaceId'. Without an index each read scanned the whole
-- table, once or twice per workspace: 11 s for 25 workspaces at 600k sessions
-- (performance/tuning-2026-10-25). Built without CONCURRENTLY (migrations run
-- in a transaction): it blocks search-session inserts for the build, ~2 s per
-- 600k rows.
-- Fail fast instead of queueing every search insert behind a long-open writer
-- while waiting for the SHARE lock; a retried deploy finishes the build.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS search_sessions_workspace_created_idx
  ON search_sessions USING btree ((metadata ->> 'workspaceId'), created_at);

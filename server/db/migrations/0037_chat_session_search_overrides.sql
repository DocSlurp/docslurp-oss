-- Per-thread retrieval overrides (G8).
--
-- Asking chat to "use more results" or "turn off reranking" used to rewrite the
-- workspace's retrieval defaults for every member. Those requests now land on
-- the chat thread (chat_sessions row) instead; the workspace defaults are only
-- changed from workspace settings.
ALTER TABLE "chat_sessions" ADD COLUMN IF NOT EXISTS "search_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL;

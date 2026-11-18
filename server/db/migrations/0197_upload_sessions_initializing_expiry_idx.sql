-- The direct-upload reconciler's due-session sweep (server/src/services/direct-upload-reconciler.ts) reads two
-- index ranges: sessions due for finalization (upload_sessions_reconcile_idx, 0078) and abandoned sessions still
-- initializing past their deadline, which had no index and made the sweep scan every session ever created, every
-- 15 s in every API process. Initializing sessions are few and short-lived, so this partial index stays small.
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS upload_sessions_initializing_expiry_idx ON upload_sessions (expires_at)
  WHERE status = 'initializing';

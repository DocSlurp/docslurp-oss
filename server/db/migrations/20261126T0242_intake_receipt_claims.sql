-- An idempotent intake claims its Idempotency-Key with its intake_request_receipts row: a random claim token and a
-- deadline fixed at insert (database time, never renewed), instead of holding a database connection (and a session
-- advisory lock) for the whole request. A claim before its deadline means the key is in flight; a lapsed one was left
-- by a request that stopped and may be recovered. Both columns are nullable and have no default, so adding them
-- rewrites nothing. Rows written before this migration have neither; readers probe the previous release's advisory
-- lock to tell whether such a row is still held.
ALTER TABLE intake_request_receipts ADD COLUMN IF NOT EXISTS claim_token text;
ALTER TABLE intake_request_receipts ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;

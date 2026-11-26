-- An idempotent intake claims its Idempotency-Key with its intake_request_receipts row and renews a short lease on it
-- while the request runs, instead of holding a database connection (and a session advisory lock) for the whole
-- request. A live lease means the key is in flight; an expired one was left by a request that died and may be
-- recovered. Both columns are nullable and have no default, so adding them rewrites nothing. Rows written before this
-- migration have neither; readers treat such a row's claim as live for a bounded time after created_at.
ALTER TABLE intake_request_receipts ADD COLUMN IF NOT EXISTS claim_token text;
ALTER TABLE intake_request_receipts ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;

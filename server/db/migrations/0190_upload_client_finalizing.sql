-- A client that completes its own files (POST .../files/complete) holds the background reconciler off its upload
-- session until this time, so the two never contend for the session lock. Null: no client is finalizing.
ALTER TABLE upload_sessions ADD COLUMN IF NOT EXISTS client_finalizing_until timestamptz;

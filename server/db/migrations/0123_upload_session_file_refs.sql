-- A direct-upload session file remembers its position in the create request and the client's own correlation id, so clients match
-- the server's per-file results by index or id rather than by (sanitized) filename.
-- Metadata-only column adds; ACCESS EXCLUSIVE on upload_session_files only, bounded by lock_timeout like 0122.
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS request_index integer;
--> statement-breakpoint
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS client_id text;

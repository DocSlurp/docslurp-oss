-- A direct-upload session file remembers its position in the create request and the client's own correlation id, so clients match
-- the server's per-file results by index or id rather than by (sanitized) filename.
-- Metadata-only column adds under ACCESS EXCLUSIVE on upload_session_files. The lock prelude is the same in every lock-taking
-- migration of this release (0122, 0123, 0125, 0126, 0127; the order is explained in 0122).
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE documents IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE upload_session_files IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
LOCK TABLE organizations, org_memberships IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
SET LOCAL lock_timeout = '3s';
--> statement-breakpoint
LOCK TABLE api_keys IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
SET LOCAL lock_timeout = '10s';
--> statement-breakpoint
LOCK TABLE webhooks IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS request_index integer;
--> statement-breakpoint
ALTER TABLE upload_session_files ADD COLUMN IF NOT EXISTS client_id text;

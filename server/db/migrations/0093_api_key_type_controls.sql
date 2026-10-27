-- Per-key-type controls (feat/key-type-controls).
-- expires_at: optional expiry (server keys; also set on the old key when a
--   rotation keeps it working for an overlap window). Expired keys never authenticate.
-- last_used_ip: the client address of the latest request (dashboard display).
-- ip_allowlist: optional CIDR allowlist for server keys; empty means any address.
-- max_output_tokens: cap on a chat answer's model output for this key. Browser
--   keys use 500/1000/2000 (NULL means the 1000 default); server keys
--   500/1000/2000/4000 or NULL for no key cap.
-- rotated_from_key_id: the key this one replaced in an overlapping rotation.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at timestamptz;
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_ip text;
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS ip_allowlist text[] NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS max_output_tokens integer;
--> statement-breakpoint
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rotated_from_key_id text;
--> statement-breakpoint
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_max_output_tokens_check;
--> statement-breakpoint
ALTER TABLE api_keys ADD CONSTRAINT api_keys_max_output_tokens_check
  CHECK (max_output_tokens IS NULL OR max_output_tokens IN (500, 1000, 2000, 4000));

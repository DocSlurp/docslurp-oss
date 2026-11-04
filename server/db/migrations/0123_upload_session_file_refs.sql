-- A direct-upload session file remembers its position in the create request and the client's own correlation id, so clients match
-- the server's per-file results by index or id rather than by (sanitized) filename.
ALTER TABLE upload_session_files ADD COLUMN request_index integer;
ALTER TABLE upload_session_files ADD COLUMN client_id text;

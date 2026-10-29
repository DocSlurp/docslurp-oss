-- A session issued by a password sign-in records which password it proved
-- (SHA-256 of the stored hash, never the hash itself). When the password
-- changes, every such session stops working at its next use, however late
-- its sign-in finished. Null for sessions issued any other way.
ALTER TABLE session ADD COLUMN IF NOT EXISTS "credentialFingerprint" text;

-- Retain the latest generation even after verification consumes its OTP.
-- This fences Better Auth 1.7.14's consume/restore wrong-code path.
CREATE TABLE auth_otp_generations (
  identifier text PRIMARY KEY,
  digest text NOT NULL,
  expires_at timestamptz NOT NULL
);
--> statement-breakpoint
-- Preserve the remaining attempts of codes issued before this migration.
INSERT INTO auth_otp_generations(identifier, digest, expires_at)
SELECT DISTINCT ON (identifier) identifier, regexp_replace(value, ':[0-9]+$', ''), "expiresAt"
FROM verification
WHERE identifier ~ '^(email-verification|sign-in|forget-password|change-email)-otp-'
  AND value ~ ':[0-9]+$' AND "expiresAt" > now()
ORDER BY identifier, "createdAt" DESC, id DESC;
--> statement-breakpoint
CREATE FUNCTION fence_auth_otp_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  code_digest text;
  attempt text;
  current_generation auth_otp_generations%ROWTYPE;
BEGIN
  IF NEW.identifier !~ '^(email-verification|sign-in|forget-password|change-email)-otp-' THEN
    RETURN NEW;
  END IF;
  attempt := substring(NEW.value from ':([0-9]+)$');
  IF attempt IS NULL THEN
    RAISE EXCEPTION 'Invalid OTP record';
  END IF;
  code_digest := regexp_replace(NEW.value, ':[0-9]+$', '');
  -- All issuers and restorers take the same transaction-scoped database lock.
  PERFORM pg_advisory_xact_lock(hashtextextended('auth-otp:' || NEW.identifier, 0));
  IF attempt = '0' THEN
    INSERT INTO auth_otp_generations(identifier, digest, expires_at)
      VALUES (NEW.identifier, code_digest, NEW."expiresAt")
      ON CONFLICT (identifier) DO UPDATE
      SET digest = EXCLUDED.digest, expires_at = EXCLUDED.expires_at;
    -- One live generation, including when two issuances share a millisecond.
    DELETE FROM verification WHERE identifier = NEW.identifier;
    RETURN NEW;
  END IF;
  SELECT * INTO current_generation FROM auth_otp_generations
    WHERE identifier = NEW.identifier;
  IF NOT FOUND OR current_generation.digest <> code_digest
      OR current_generation.expires_at <> NEW."expiresAt"
      OR NEW."expiresAt" <= clock_timestamp() THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER verification_otp_generation BEFORE INSERT ON verification
  FOR EACH ROW EXECUTE FUNCTION fence_auth_otp_generation();

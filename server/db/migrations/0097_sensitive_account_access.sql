-- Explicit, fixed-duration proof belongs to one live session. Ordinary refresh
-- and session rotation neither create nor copy these values.
ALTER TABLE session ADD COLUMN IF NOT EXISTS "sensitiveVerifiedAt" timestamptz;
--> statement-breakpoint
ALTER TABLE session ADD COLUMN IF NOT EXISTS "sensitiveFirstFactorAt" timestamptz;
--> statement-breakpoint
ALTER TABLE sso_auth_requests ADD COLUMN IF NOT EXISTS sensitive_user_id text REFERENCES "user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE sso_auth_requests ADD COLUMN IF NOT EXISTS sensitive_session_id text REFERENCES session(id) ON DELETE CASCADE;
--> statement-breakpoint
DO $idem$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sso_sensitive_binding_check' AND conrelid = 'sso_auth_requests'::regclass) THEN
    ALTER TABLE sso_auth_requests ADD CONSTRAINT sso_sensitive_binding_check CHECK (
  (sensitive_user_id IS NULL AND sensitive_session_id IS NULL) OR
  (sensitive_user_id IS NOT NULL AND sensitive_session_id IS NOT NULL AND link_user_id IS NULL)
);
  END IF;
END $idem$;
--> statement-breakpoint
ALTER TABLE session ADD COLUMN IF NOT EXISTS "sensitiveEmailOTPHash" text;
--> statement-breakpoint
ALTER TABLE session ADD COLUMN IF NOT EXISTS "sensitiveEmailOTPExpiresAt" timestamptz;
--> statement-breakpoint
ALTER TABLE session ADD COLUMN IF NOT EXISTS "sensitiveEmailOTPSentAt" timestamptz;
--> statement-breakpoint
ALTER TABLE session ADD COLUMN IF NOT EXISTS "sensitiveEmailOTPAttempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Fresh MFA proof is distinct from a remembered session's MFA assurance.
ALTER TABLE session ADD COLUMN IF NOT EXISTS "sensitiveMfaVerified" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE session ADD COLUMN IF NOT EXISTS "sensitiveSsoVerified" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE session ADD COLUMN IF NOT EXISTS "sensitiveFirstFactorSsoVerified" boolean NOT NULL DEFAULT false;

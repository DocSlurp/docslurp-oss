-- Explicit, fixed-duration proof belongs to one live session. Ordinary refresh
-- and session rotation neither create nor copy these values.
ALTER TABLE session ADD COLUMN "sensitiveVerifiedAt" timestamptz;
--> statement-breakpoint
ALTER TABLE session ADD COLUMN "sensitiveFirstFactorAt" timestamptz;
--> statement-breakpoint
ALTER TABLE sso_auth_requests ADD COLUMN sensitive_user_id text REFERENCES "user"(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE sso_auth_requests ADD COLUMN sensitive_session_id text REFERENCES session(id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE sso_auth_requests ADD CONSTRAINT sso_sensitive_binding_check CHECK (
  (sensitive_user_id IS NULL AND sensitive_session_id IS NULL) OR
  (sensitive_user_id IS NOT NULL AND sensitive_session_id IS NOT NULL AND link_user_id IS NULL)
);
--> statement-breakpoint
ALTER TABLE session ADD COLUMN "sensitiveEmailOTPHash" text;
--> statement-breakpoint
ALTER TABLE session ADD COLUMN "sensitiveEmailOTPExpiresAt" timestamptz;
--> statement-breakpoint
ALTER TABLE session ADD COLUMN "sensitiveEmailOTPSentAt" timestamptz;
--> statement-breakpoint
ALTER TABLE session ADD COLUMN "sensitiveEmailOTPAttempts" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Fresh MFA proof is distinct from a remembered session's MFA assurance.
ALTER TABLE session ADD COLUMN "sensitiveMfaVerified" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE session ADD COLUMN "sensitiveSsoVerified" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE session ADD COLUMN "sensitiveFirstFactorSsoVerified" boolean NOT NULL DEFAULT false;

-- Passkeys (@better-auth/passkey) and two-factor authentication (Better Auth
-- twoFactor plugin: TOTP plus single-use backup codes), with an optional
-- organization policy that requires MFA.
--
-- Column names and types follow the plugins' own schemas (better-auth 1.7.12),
-- written here instead of through Better Auth's auto-migrate. DocSlurp adds:
--   passkey."lastUsedAt"          set on every successful passkey sign-in
--   passkey credentialID unique   one credential can never belong to two users
--   "twoFactor" userId unique     the plugin keeps one row per user
--   session."mfaVerified"         the session passed a second factor (TOTP,
--                                 backup code, trusted device) or a
--                                 user-verified passkey
--   session."authenticatedAt"     when the user last proved identity; copied
--                                 across session re-issues, so the re-auth
--                                 window for removing a factor can't be reset
--                                 by an unrelated session rotation
--   mfa_totp_replay               a TOTP code accepted once is refused again
--                                 for the rest of its validity window
--   organizations.require_mfa*    org-admin policy with a grace period
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "twoFactorEnabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "twoFactor" (
  "id" text PRIMARY KEY NOT NULL,
  "secret" text NOT NULL,
  "backupCodes" text NOT NULL,
  "userId" text NOT NULL,
  "verified" boolean DEFAULT true,
  "failedVerificationCount" integer DEFAULT 0,
  "lockedUntil" timestamp with time zone,
  CONSTRAINT "twoFactor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "twoFactor_userId_key" ON "twoFactor" ("userId");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "passkey" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text,
  "publicKey" text NOT NULL,
  "userId" text NOT NULL,
  "credentialID" text NOT NULL,
  "counter" integer NOT NULL,
  "deviceType" text NOT NULL,
  "backedUp" boolean NOT NULL,
  "transports" text,
  "createdAt" timestamp with time zone DEFAULT now(),
  "aaguid" text,
  "lastUsedAt" timestamp with time zone,
  CONSTRAINT "passkey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "passkey_credentialID_key" ON "passkey" ("credentialID");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "passkey_userId_idx" ON "passkey" ("userId");
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "mfaVerified" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS "authenticatedAt" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mfa_totp_replay (
  user_id text NOT NULL,
  code_digest text NOT NULL,
  expires_at timestamp with time zone NOT NULL,
  CONSTRAINT mfa_totp_replay_pkey PRIMARY KEY (user_id, code_digest),
  CONSTRAINT mfa_totp_replay_user_id_fkey FOREIGN KEY (user_id) REFERENCES "user"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mfa_totp_replay_expires_at_idx ON mfa_totp_replay (expires_at);
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS require_mfa boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS require_mfa_since timestamp with time zone;
--> statement-breakpoint
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS mfa_grace_period_days integer DEFAULT 7 NOT NULL;
--> statement-breakpoint
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_mfa_grace_period_days_check;
--> statement-breakpoint
ALTER TABLE organizations ADD CONSTRAINT organizations_mfa_grace_period_days_check CHECK (mfa_grace_period_days >= 0 AND mfa_grace_period_days <= 30);

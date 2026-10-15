-- Organization email invites (security gap G-02).
--
-- Admins used to add any user ID straight into their organization, with no
-- consent, and the response returned that user's email and name (an
-- ID-to-email oracle and the enabling step for the G-01 SSO takeover).
-- Membership now starts with an invite to an email address; it becomes a
-- membership only when a signed-in user with that verified email accepts it.
--
-- The token is a bearer secret mailed to the invitee, so only its SHA-256 is
-- stored. One pending invite per org and email.
CREATE TABLE IF NOT EXISTS org_invites (
  id text PRIMARY KEY NOT NULL,
  org_id text NOT NULL,
  email text NOT NULL,
  role text NOT NULL,
  token_hash text NOT NULL,
  status text DEFAULT 'pending' NOT NULL,
  invited_by_user_id text NOT NULL,
  accepted_by_user_id text,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT org_invites_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT org_invites_invited_by_user_id_fkey FOREIGN KEY (invited_by_user_id) REFERENCES "user"(id) ON DELETE CASCADE,
  CONSTRAINT org_invites_accepted_by_user_id_fkey FOREIGN KEY (accepted_by_user_id) REFERENCES "user"(id) ON DELETE SET NULL,
  CONSTRAINT org_invites_token_hash_key UNIQUE (token_hash),
  CONSTRAINT org_invites_role_check CHECK (role IN ('owner', 'admin', 'member', 'billing')),
  CONSTRAINT org_invites_status_check CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
  CONSTRAINT org_invites_email_lower_check CHECK (email = lower(email))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS org_invites_pending_email_idx ON org_invites (org_id, email) WHERE status = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS org_invites_org_created_idx ON org_invites (org_id, created_at);

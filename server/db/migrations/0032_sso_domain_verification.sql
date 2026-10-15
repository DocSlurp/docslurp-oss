-- SSO domain ownership and explicit identity linking (security gap G-01).
--
-- Before this, any org admin could claim any emailDomain, and the SSO callback
-- signed in whichever existing account matched the asserted email, as that
-- user's full account in every org.
--
-- sso_domains: an org's claim on an email domain. A claim is proven by a DNS
-- TXT record (_docslurp-verify.<domain> = "docslurp-verify=<token>"). Only a
-- verified claim lets the org enable SSO, enforce it, or route sign-ins. A
-- domain can be verified by one org at a time (partial unique index).
--
-- sso_identity_links: an IdP identity (issuer + subject) bound to a DocSlurp
-- user by that user, while signed in, for one org. The SSO callback signs in
-- only through a link; it never matches a pre-existing account by email.
--
-- sso_auth_requests.link_user_id marks a flow the signed-in user started to
-- create a link.
CREATE TABLE IF NOT EXISTS sso_domains (
  id text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id text NOT NULL,
  domain text NOT NULL,
  verification_token text NOT NULL,
  verified_at timestamptz,
  last_checked_at timestamptz,
  last_error text,
  created_by_user_id text,
  created_at timestamptz DEFAULT now() NOT NULL,
  CONSTRAINT sso_domains_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT sso_domains_org_domain_key UNIQUE (org_id, domain),
  CONSTRAINT sso_domains_domain_lower_check CHECK (domain = lower(domain))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS sso_domains_verified_domain_key ON sso_domains (domain) WHERE verified_at IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sso_identity_links (
  id text PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  org_id text NOT NULL,
  user_id text NOT NULL,
  provider text NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  email text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  last_used_at timestamptz,
  CONSTRAINT sso_identity_links_org_id_fkey FOREIGN KEY (org_id) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT sso_identity_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE,
  CONSTRAINT sso_identity_links_org_user_key UNIQUE (org_id, user_id),
  CONSTRAINT sso_identity_links_identity_key UNIQUE (org_id, provider, issuer, subject),
  CONSTRAINT sso_identity_links_provider_check CHECK (provider IN ('oidc', 'saml'))
);
--> statement-breakpoint
ALTER TABLE sso_auth_requests ADD COLUMN IF NOT EXISTS link_user_id text REFERENCES "user"(id) ON DELETE CASCADE;
--> statement-breakpoint
-- No existing config has a verified domain: switch them all off.
UPDATE organizations
SET sso_config = sso_config || '{"enabled": false, "enforceSso": false}'::jsonb
WHERE sso_config <> '{}'::jsonb;

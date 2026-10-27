import { appDbPool } from "./better-auth.js";
import { findSsoOrgForEmail, ssoStartUrl } from "./sso-enforcement.js";

export { ssoBaseUrl } from "./sso-enforcement.js";

/**
 * Given an email address, find the org whose SSO covers its domain. Returns
 * the SSO redirect URL if the user should be routed through SSO, or null if
 * normal login is allowed.
 *
 * Only an org that DNS-verified the domain (sso_domains.verified_at) routes
 * it, and a verified domain belongs to one org. With requireEnforced, the
 * org must also enforce SSO.
 *
 * The answer depends only on the email's domain, never on whether that
 * mailbox has an account or an SSO link: this backs the unauthenticated
 * `GET /api/sso-lookup`, and a per-user answer there would let anyone list
 * which addresses at a company have linked accounts. Unlinked users sent to
 * the IdP are refused at the SSO callback, which then grants that browser an
 * unlinked pass (see sso-unlinked-pass.ts) so they can sign in normally and
 * link SSO.
 *
 * This is the sign-in page's redirect hint only and fails open on a database
 * error. Enforcement itself lives in sso-enforcement.ts and fails closed.
 */
export async function resolveSsoRedirect(email: string, apiUrl: string, requireEnforced = true): Promise<string | null> {
  try {
    const org = await findSsoOrgForEmail(appDbPool, email, requireEnforced);
    return org ? ssoStartUrl(org, apiUrl) : null;
  } catch {
    // Non-fatal: fall through to normal login.
    return null;
  }
}

export async function hasConfiguredSsoProvider(): Promise<boolean> {
  try {
    const result = await appDbPool.query(`select exists(select 1 from organizations
      join sso_domains d on d.org_id = organizations.id
        and d.domain = sso_config->>'emailDomain'
        and d.verified_at is not null
      where sso_config->>'enabled' = 'true'
        and coalesce(sso_config->>'metadataUrl', '') <> ''
        and (sso_config->>'providerType' = 'saml' or (sso_config->>'providerType' = 'oidc' and coalesce(sso_config->>'clientId', '') <> ''))
    ) as enabled`);
    return result.rows[0]?.enabled === true;
  } catch { return false; }
}

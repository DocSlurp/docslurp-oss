import { appDbPool } from "./better-auth.js";

interface SsoOrgRow {
  id: string;
  slug: string | null;
  sso_config: {
    providerType?: "saml" | "oidc" | null;
    metadataUrl?: string | null;
    clientId?: string | null;
    enabled?: boolean;
    enforceSso?: boolean;
    emailDomain?: string | null;
  } | null;
}

/** Base URL the browser is sent to for SSO initiation. */
export function ssoBaseUrl(request: Request): string {
  return process.env.INTERNAL_API_URL || new URL(request.url).origin;
}

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
 */
export async function resolveSsoRedirect(email: string, apiUrl: string, requireEnforced = true): Promise<string | null> {
  const domain = email.split("@")[1]?.trim().toLowerCase();
  if (!domain) return null;

  try {
    const rows = await appDbPool.query<SsoOrgRow>(
      `
        select o.id, o.slug, o.sso_config
        from organizations o
        join sso_domains d
          on d.org_id = o.id
          and d.domain = o.sso_config->>'emailDomain'
          and d.verified_at is not null
        where
          d.domain = $1
          and (o.sso_config->>'enabled')::boolean = true
          and ($2::boolean = false or (o.sso_config->>'enforceSso')::boolean = true)
        limit 1
      `,
      [domain, requireEnforced]
    );

    const org = rows.rows[0];
    const config = org?.sso_config;
    if (!org || !config) return null;

    if (config.providerType === "saml") {
      return `${apiUrl}/v1/auth/saml/${encodeURIComponent(org.slug ?? org.id)}/init`;
    }

    if (config.providerType === "oidc" && config.metadataUrl && config.clientId) {
      return `${apiUrl}/v1/auth/oidc/${encodeURIComponent(org.id)}/init`;
    }
  } catch {
    // Non-fatal: fall through to normal login.
  }

  return null;
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

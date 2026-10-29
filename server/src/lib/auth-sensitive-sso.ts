import type { CacheProvider } from "@node-saml/node-saml";
import type { Pool } from "pg";

type Database = Pick<Pool, "query">;
export const SENSITIVE_SSO_CLOCK_SKEW_MS = 5_000;

/** Only an existing identity link to a configured, verified-domain organization can prove this account. */
export async function sensitiveSsoOptions(pool: Database, userId: string, email: string): Promise<Array<{ orgId: string; provider: "oidc" | "saml" }>> {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!userId || !domain) return [];
  const { rows } = await pool.query<{ org_id: string; provider: "oidc" | "saml" }>(`select l.org_id, l.provider from sso_identity_links l
    join organizations o on o.id = l.org_id
    join org_memberships m on m.org_id = l.org_id and m.user_id = l.user_id
    join sso_domains d on d.org_id = o.id and d.domain = $2 and d.verified_at is not null
    where l.user_id = $1 and lower(l.email) = lower($3)
      and o.sso_config->>'enabled' = 'true' and o.sso_config->>'emailDomain' = $2
      and o.sso_config->>'providerType' = l.provider and coalesce(o.sso_config->>'metadataUrl', '') <> ''
      and (l.provider = 'saml' or (coalesce(o.sso_config->>'clientId', '') <> ''
        and (coalesce(o.sso_config->>'clientSecretEncrypted', '') <> '' or coalesce(o.sso_config->>'clientSecret', '') <> '')))
    order by l.org_id`, [userId, domain, email]);
  return rows.map(row => ({ orgId: row.org_id, provider: row.provider }));
}

/** An IdP remembered session is insufficient; signed proof must name authentication during this request. */
export function isFreshSensitiveSsoAuthentication(authenticatedAtMs: number, startedAt: string, nowMs = Date.now()): boolean {
  const start = Date.parse(startedAt);
  return Number.isFinite(authenticatedAtMs) && Number.isFinite(start)
    && authenticatedAtMs >= start - SENSITIVE_SSO_CLOCK_SKEW_MS
    && authenticatedAtMs <= nowMs + SENSITIVE_SSO_CLOCK_SKEW_MS
    && start <= nowMs && nowMs - start <= 10 * 60_000;
}

/** Reads only node-saml's already signature-verified assertion, never the raw response XML. */
export function verifiedSamlSensitiveAuthTime(profile: Record<string, unknown>, issuer: string, requestId: string): number | null {
  if (typeof profile.getAssertion !== "function") return null;
  const verified = (profile.getAssertion as () => unknown)() as any;
  const assertion = verified?.Assertion;
  if (!assertion || !Array.isArray(assertion.Issuer) || assertion.Issuer.length !== 1) return null;
  const assertedIssuer = typeof assertion.Issuer[0] === "string" ? assertion.Issuer[0] : assertion.Issuer[0]?._;
  if (!issuer || assertedIssuer !== issuer || profile.issuer !== issuer) return null;
  const statements = assertion.AuthnStatement;
  if (!Array.isArray(statements) || statements.length !== 1) return null;
  const confirmations = assertion.Subject?.[0]?.SubjectConfirmation;
  if (!Array.isArray(confirmations) || confirmations.length !== 1) return null;
  const data = confirmations[0]?.SubjectConfirmationData;
  if (!Array.isArray(data) || data.length !== 1 || data[0]?.$?.InResponseTo !== requestId) return null;
  const instant = statements[0]?.$?.AuthnInstant;
  if (typeof instant !== "string") return null;
  const timestamp = Date.parse(instant);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function isSensitiveSsoStartOrigin(origin: string | undefined, requestUrl: string, appUrl: string): boolean {
  if (!origin) return false;
  try { return origin === new URL(requestUrl).origin || origin === new URL(appUrl).origin; }
  catch { return false; }
}

/** Callback-only cache: this DB request was atomically consumed by the route, and no other request may answer it. */
export function sensitiveSamlRequestCache(requestId: string, createdAt: string, expiresAt: string): CacheProvider {
  let removed = false;
  return {
    saveAsync: async () => null,
    getAsync: async key => !removed && key === requestId && Date.parse(expiresAt) > Date.now() ? createdAt : null,
    removeAsync: async key => {
      if (removed || key !== requestId) return null;
      removed = true;
      return key;
    },
  };
}

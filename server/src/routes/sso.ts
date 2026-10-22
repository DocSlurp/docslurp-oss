import { reportPublicError } from "../lib/public-errors.js";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { SAML, ValidateInResponseTo, type CacheItem, type CacheProvider } from "@node-saml/node-saml";
import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { parseStringPromise } from "xml2js";
import { z } from "zod";

import { sql } from "../db.js";
import { auth } from "../lib/auth.js";
import { openSecret, sealSecret } from "../lib/encryption.js";
import { requestIp } from "../lib/request-context.js";
import { assertSafeExternalUrl, safeExternalFetch, UnsafeExternalUrlError } from "../lib/network-security.js";
import {
  claimSsoDomain,
  loadOrgSsoDomain,
  normalizeSsoDomain,
  SsoDomainConflictError,
  toDomainStatus,
  validateClaimableDomain,
  verifySsoDomain
} from "../services/sso-domains.js";
import { authenticatedByRoute } from "../lib/route-auth.js";
import { apiStatusError } from "../lib/api-error.js";
import { validationHook } from "../lib/validation.js";
import { safeRedirectPath } from "../lib/safe-redirect.js";

const ssoConfigSchema = z.object({
  providerType: z.enum(["saml", "oidc"]).nullable().optional(),
  metadataUrl: z.string().url().nullable().optional(),
  clientId: z.string().nullable().optional(),
  clientSecret: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  enforceSso: z.boolean().optional(),
  emailDomain: z.string().nullable().optional()
});

type SsoConfig = z.infer<typeof ssoConfigSchema>;
type StoredSsoConfig = SsoConfig & {
  clientSecretEncrypted?: string | null;
};

interface OrgRow {
  id: string;
  slug: string | null;
  sso_config: SsoConfig | null;
}

interface MembershipRow {
  role: string;
}

interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface SsoRequestRow {
  state: string;
  org_id: string;
  provider: "oidc" | "saml";
  code_verifier: string | null;
  nonce: string | null;
  redirect_path: string | null;
  link_user_id: string | null;
  expires_at: string;
  consumed_at: string | null;
}

interface SamlMetadata {
  entryPoint: string;
  certificates: string[];
  issuer: string | null;
}

const samlMetadataMaxBytes = Number.parseInt(process.env.SAML_METADATA_MAX_BYTES ?? "1048576", 10);
const oidcTrustedEndpointHosts = new Set(
  (process.env.OIDC_TRUSTED_ENDPOINT_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
);
const ssoRateLimitWindowMs = Number.parseInt(process.env.SSO_RATE_LIMIT_WINDOW_MS ?? "60000", 10);
const ssoRateLimitMax = Number.parseInt(process.env.SSO_RATE_LIMIT_MAX ?? "30", 10);
const ssoRateLimitBuckets = new Map<string, { resetAt: number; count: number }>();

function appUrl(): string {
  return process.env.APP_URL ?? "http://localhost:4321";
}

const normalizeEmailDomain = normalizeSsoDomain;

function configuredApiOrigin(): string | null {
  const configured = process.env.PUBLIC_API_URL ?? process.env.API_URL ?? process.env.APP_URL;
  if (!configured) {
    return null;
  }

  try {
    const parsed = new URL(configured);
    return parsed.origin;
  } catch {
    return null;
  }
}

function trustedForwardedOrigin(request: Request): string | null {
  if (process.env.BETTER_AUTH_TRUST_PROXY_HEADERS !== "true") {
    return null;
  }

  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");
  if (!forwardedProto || !forwardedHost) {
    return null;
  }

  const proto = forwardedProto.split(",")[0]?.trim().toLowerCase();
  const host = forwardedHost.split(",")[0]?.trim().toLowerCase();
  if ((proto !== "https" && proto !== "http") || !host || /[/?#\\\s]/.test(host)) {
    return null;
  }

  return `${proto}://${host}`;
}

export function inferApiOrigin(request: Request): string {
  const configured = configuredApiOrigin();
  if (configured) {
    return configured;
  }

  const forwarded = trustedForwardedOrigin(request);
  if (forwarded) {
    return forwarded;
  }

  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}

function createStateToken(): string {
  return randomBytes(32).toString("base64url");
}

function createPkceVerifier(): string {
  return randomBytes(48).toString("base64url");
}

function createPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function validateConfig(config: SsoConfig): string | null {
  if (!config.enabled) {
    if (config.enforceSso) {
      return "enforceSso requires enabled=true";
    }
    return null;
  }

  if (!config.providerType) {
    return "providerType is required when SSO is enabled";
  }
  if (!config.metadataUrl) {
    return "metadataUrl is required when SSO is enabled";
  }
  if (!config.emailDomain) {
    return "emailDomain is required when SSO is enabled";
  }
  if (config.providerType === "oidc" && !config.clientId) {
    return "clientId is required for OIDC SSO";
  }
  if (config.providerType === "oidc" && !config.clientSecret) {
    return "clientSecret is required for OIDC SSO";
  }

  return null;
}

function encryptSsoClientSecret(secret: string): string {
  return sealSecret("SECRETS_ENCRYPTION_KEY", secret);
}

function decryptSsoClientSecret(encrypted: string | null | undefined): string | null {
  if (!encrypted) {
    return null;
  }

  try {
    return openSecret("SECRETS_ENCRYPTION_KEY", encrypted);
  } catch {
    // A malformed or undecryptable value is treated as "no stored secret" so a
    // bad row cannot take down the SSO config read.
    return null;
  }
}

function resolveStoredSsoConfig(raw: SsoConfig | null): SsoConfig {
  const stored = (raw ?? {}) as StoredSsoConfig;
  return {
    providerType: stored.providerType ?? null,
    metadataUrl: stored.metadataUrl ?? null,
    clientId: stored.clientId ?? null,
    clientSecret: stored.clientSecret ?? decryptSsoClientSecret(stored.clientSecretEncrypted),
    enabled: stored.enabled ?? false,
    enforceSso: stored.enforceSso ?? false,
    emailDomain: normalizeEmailDomain(stored.emailDomain ?? null)
  };
}

function toStoredSsoConfig(config: SsoConfig): StoredSsoConfig {
  const stored: StoredSsoConfig = {
    providerType: config.providerType ?? null,
    metadataUrl: config.metadataUrl ?? null,
    clientId: config.clientId ?? null,
    clientSecret: null,
    clientSecretEncrypted: config.clientSecret ? encryptSsoClientSecret(config.clientSecret) : null,
    enabled: config.enabled ?? false,
    enforceSso: config.enforceSso ?? false,
    emailDomain: normalizeEmailDomain(config.emailDomain ?? null)
  };
  return stored;
}

function sanitizeSsoConfig(raw: SsoConfig | null): SsoConfig {
  const merged = resolveStoredSsoConfig(raw);

  return { ...merged, clientSecret: merged.clientSecret ? "***" : null };
}

async function requireOrgAdmin(orgId: string, userId: string): Promise<void> {
  const [row] = await sql<MembershipRow[]>`
    select role
    from org_memberships
    where org_id = ${orgId} and user_id = ${userId}
    limit 1
  `;

  if (!row || (row.role !== "owner" && row.role !== "admin")) {
    throw new Error("Only org owners or admins can manage SSO configuration");
  }
}

/**
 * The IdP metadata (fetched from an admin-supplied URL) failed a check. The
 * message describes the IdP's public document, so it is safe to return to the
 * org admin who configured it.
 */
class SsoMetadataError extends Error {
  override name = "SsoMetadataError";
}

async function fetchOidcMetadata(metadataUrl: string): Promise<OidcMetadata> {
  const safeMetadataUrl = await assertSafeExternalUrl(metadataUrl);
  const resp = await safeExternalFetch(safeMetadataUrl, { signal: AbortSignal.timeout(8_000) });
  if (!resp.ok) {
    throw new SsoMetadataError(`Metadata endpoint returned HTTP ${resp.status}`);
  }
  let json: Partial<OidcMetadata>;
  try {
    json = (await resp.json()) as Partial<OidcMetadata>;
  } catch {
    throw new SsoMetadataError("Metadata URL did not return a JSON OpenID Connect discovery document");
  }
  if (!json || typeof json !== "object" || !json.issuer || !json.authorization_endpoint || !json.token_endpoint || !json.jwks_uri) {
    throw new SsoMetadataError("Metadata document missing required OIDC fields (issuer, authorization_endpoint, token_endpoint, jwks_uri)");
  }
  return await assertSafeOidcEndpoints({
    issuer: json.issuer,
    authorization_endpoint: json.authorization_endpoint,
    token_endpoint: json.token_endpoint,
    jwks_uri: json.jwks_uri
  }, safeMetadataUrl);
}

function pemFromX509(value: string): string {
  const compact = value.replace(/\s+/g, "");
  const chunks = compact.match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${chunks.join("\n")}\n-----END CERTIFICATE-----`;
}

function assertSafeSamlMetadataXml(xml: string): void {
  if (Buffer.byteLength(xml, "utf8") > samlMetadataMaxBytes) {
    throw new SsoMetadataError("SAML metadata document is too large");
  }
  if (/<!\s*(doctype|entity)\b/i.test(xml)) {
    throw new SsoMetadataError("SAML metadata must not contain DTD or entity declarations");
  }

  const disallowedEntity = /&(?!(?:amp|lt|gt|apos|quot|#\d+|#x[0-9a-fA-F]+);)[A-Za-z_][\w.-]*;/;
  if (disallowedEntity.test(xml)) {
    throw new SsoMetadataError("SAML metadata contains unsupported entity references");
  }
}

async function fetchSamlMetadata(metadataUrl: string): Promise<SamlMetadata> {
  const safeMetadataUrl = await assertSafeExternalUrl(metadataUrl);
  const resp = await safeExternalFetch(safeMetadataUrl, { signal: AbortSignal.timeout(8_000) });
  if (!resp.ok) {
    throw new SsoMetadataError(`Metadata endpoint returned HTTP ${resp.status}`);
  }

  const xml = await resp.text();
  assertSafeSamlMetadataXml(xml);

  const parsed = (await parseStringPromise(xml, {
    explicitArray: true,
    strict: true,
    normalize: false,
    normalizeTags: false,
    trim: true
  }).catch(() => {
    throw new SsoMetadataError("Metadata URL did not return a well-formed SAML metadata XML document");
  })) as {
    EntityDescriptor?: Array<{
      $?: { entityID?: string };
      IDPSSODescriptor?: Array<{
        SingleSignOnService?: Array<{ $?: { Binding?: string; Location?: string } }>;
        KeyDescriptor?: Array<{ KeyInfo?: Array<{ X509Data?: Array<{ X509Certificate?: string[] }> }> }>;
      }>;
    }>;
  };

  const descriptor = parsed.EntityDescriptor?.[0];
  const idp = descriptor?.IDPSSODescriptor?.[0];
  const services = idp?.SingleSignOnService ?? [];
  const redirectService = services.find((service) =>
    service.$?.Binding?.includes("HTTP-Redirect")
  );
  const entryPoint = redirectService?.$?.Location ?? services[0]?.$?.Location;

  const certificates = (idp?.KeyDescriptor ?? [])
    .flatMap((keyDescriptor) => keyDescriptor.KeyInfo ?? [])
    .flatMap((keyInfo) => keyInfo.X509Data ?? [])
    .flatMap((x509Data) => x509Data.X509Certificate ?? [])
    .map((cert) => cert.trim())
    .filter(Boolean)
    .map((cert) => pemFromX509(cert));

  if (!entryPoint || certificates.length === 0) {
    throw new SsoMetadataError("SAML metadata missing SingleSignOnService location or X509Certificate");
  }

  return {
    entryPoint,
    certificates,
    issuer: descriptor?.$?.entityID ?? null
  };
}

async function storeSsoRequest(args: {
  state: string;
  orgId: string;
  provider: "oidc" | "saml";
  codeVerifier?: string | null;
  nonce?: string | null;
  redirectPath?: string | null;
  linkUserId?: string | null;
}): Promise<void> {
  await sql`
    insert into sso_auth_requests (
      state,
      org_id,
      provider,
      code_verifier,
      nonce,
      redirect_path,
      link_user_id,
      expires_at
    )
    values (
      ${args.state},
      ${args.orgId},
      ${args.provider},
      ${args.codeVerifier ?? null},
      ${args.nonce ?? null},
      ${args.redirectPath ?? null},
      ${args.linkUserId ?? null},
      now() + interval '10 minutes'
    )
  `;
}

function endpointHost(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

function assertTrustedOidcEndpointHost(endpointUrl: string, allowedHosts: Set<string>): void {
  const host = endpointHost(endpointUrl);
  if (!allowedHosts.has(host)) {
    throw new SsoMetadataError(`OIDC metadata endpoint host ${host} is not the issuer's host or a trusted endpoint host`);
  }
}

/**
 * OIDC Discovery 1.0 §4.3: the issuer in the document must be the issuer the
 * document was fetched for. Without this, metadata could name any issuer.
 */
function assertIssuerMatchesMetadataUrl(issuer: string, metadataUrl: string): void {
  let expected: string;
  let actual: string;
  try {
    expected = `${issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`;
    const parsed = new URL(metadataUrl);
    actual = `${parsed.origin}${parsed.pathname}`;
  } catch {
    throw new SsoMetadataError("OIDC metadata issuer is invalid");
  }
  if (expected !== actual) {
    throw new SsoMetadataError(
      `OIDC metadata issuer ${issuer} does not match the metadata URL; expected the URL to be ${expected}`
    );
  }
}

/**
 * What this check protects, and what it doesn't:
 *
 * The admin supplies the metadata URL, so the IdP (and any host derived from
 * it) is admin-controlled. Host checks here can't decide whether an IdP is
 * trustworthy for a set of users. That trust comes from DNS-verified domain
 * ownership plus identities each user linked themselves (see the callbacks).
 *
 * The checks keep the IdP's endpoints consistent with the issuer the admin
 * pointed at, so a metadata document can't send our client secret, PKCE
 * verifier or id_token verification to an unrelated host, or reach internal
 * hosts (assertSafeExternalUrl/safeExternalFetch: https only, public IPs).
 * Endpoints must be on the issuer's host, or on a host the operator lists in
 * OIDC_TRUSTED_ENDPOINT_HOSTS (e.g. Google's split token/JWKS hosts).
 */
async function assertSafeOidcEndpoints(metadata: OidcMetadata, metadataUrl: string): Promise<OidcMetadata> {
  assertIssuerMatchesMetadataUrl(metadata.issuer, metadataUrl);
  const [safeIssuerUrl, authorizationEndpoint, tokenEndpoint, jwksUri] = await Promise.all([
    assertSafeExternalUrl(metadata.issuer),
    assertSafeExternalUrl(metadata.authorization_endpoint),
    assertSafeExternalUrl(metadata.token_endpoint),
    assertSafeExternalUrl(metadata.jwks_uri),
  ]);
  const allowedHosts = new Set([
    endpointHost(safeIssuerUrl),
    ...oidcTrustedEndpointHosts
  ]);

  assertTrustedOidcEndpointHost(authorizationEndpoint, allowedHosts);
  assertTrustedOidcEndpointHost(tokenEndpoint, allowedHosts);
  assertTrustedOidcEndpointHost(jwksUri, allowedHosts);

  return {
    ...metadata,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    jwks_uri: jwksUri,
  };
}

function ssoRateLimitKey(c: any): string {
  // Same edge-derived address as the API limiter (trusted-proxy resolution, see
  // lib/client-ip.ts); never a client-controlled header.
  const trustedIp = requestIp(c);
  const userAgent = c.req.header("user-agent") ?? "unknown";
  const principal = trustedIp ?? createHash("sha256").update(userAgent).digest("hex").slice(0, 16);
  return `${principal}:${c.req.method}:${c.req.path}`;
}

async function ssoRateLimit(c: any, next: () => Promise<void>) {
  if (ssoRateLimitMax <= 0) {
    await next();
    return;
  }

  const now = Date.now();
  const key = ssoRateLimitKey(c);
  const existing = ssoRateLimitBuckets.get(key);
  const bucket = existing && existing.resetAt > now
    ? existing
    : { resetAt: now + ssoRateLimitWindowMs, count: 0 };
  bucket.count += 1;
  ssoRateLimitBuckets.set(key, bucket);

  if (bucket.count > ssoRateLimitMax) {
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    c.header("Retry-After", String(retryAfterSeconds));
    return apiStatusError(c, 429, "Too many SSO requests");
  }

  await next();
}

export function resetSsoRateLimitBucketsForTests(): void {
  ssoRateLimitBuckets.clear();
}

function createSamlRequestCacheProvider(orgId: string): CacheProvider {
  return {
    async saveAsync(key: string, value: string): Promise<CacheItem | null> {
      const [row] = await sql<{ state: string }[]>`
        select state
        from sso_auth_requests
        where state = ${key}
          and org_id = ${orgId}
          and provider = 'saml'
          and expires_at > now()
        limit 1
      `;

      return row ? { value, createdAt: Date.now() } : null;
    },
    async getAsync(key: string): Promise<string | null> {
      const [row] = await sql<{ created_at: string }[]>`
        select created_at::text
        from sso_auth_requests
        where state = ${key}
          and org_id = ${orgId}
          and provider = 'saml'
          and expires_at > now()
        limit 1
      `;

      return row?.created_at ?? null;
    },
    async removeAsync(key: string | null): Promise<string | null> {
      if (!key) {
        return null;
      }

      const [row] = await sql<{ state: string }[]>`
        select state
        from sso_auth_requests
        where state = ${key}
          and org_id = ${orgId}
          and provider = 'saml'
        limit 1
      `;

      return row?.state ?? null;
    },
  };
}

async function consumeSsoRequest(state: string, provider: "oidc" | "saml"): Promise<SsoRequestRow | null> {
  const rows = await sql<SsoRequestRow[]>`
    update sso_auth_requests
    set consumed_at = now()
    where state = ${state}
      and provider = ${provider}
      and consumed_at is null
      and expires_at > now()
    returning state, org_id, provider, code_verifier, nonce, redirect_path, link_user_id, expires_at::text, consumed_at::text
  `;
  return rows[0] ?? null;
}

const SSO_STATE_COOKIE = "docslurp_sso_state";

function ssoStateDigest(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/**
 * Binds an SSO flow to the browser that started it (SEC-2026-10-06). The SAML
 * POST binding is a cross-site form POST, so over HTTPS the cookie must be
 * SameSite=None to survive it; Lax is the dev/http fallback.
 */
function setSsoStateCookie(c: Context, state: string): void {
  const secure = new URL(inferApiOrigin(c.req.raw)).protocol === "https:";
  setCookie(c, SSO_STATE_COOKIE, ssoStateDigest(state), {
    httpOnly: true,
    sameSite: secure ? "None" : "Lax",
    secure,
    path: "/",
    maxAge: 600,
  });
}

/** True only when the callback returns to the browser that started the flow; consumes the cookie. */
function ssoStateMatchesCookie(c: Context, state: string): boolean {
  const cookie = getCookie(c, SSO_STATE_COOKIE);
  if (!cookie) return false;
  const expected = ssoStateDigest(state);
  const provided = Buffer.from(cookie);
  const wanted = Buffer.from(expected);
  const ok = provided.length === wanted.length && timingSafeEqual(provided, wanted);
  if (ok) deleteCookie(c, SSO_STATE_COOKIE, { path: "/" });
  return ok;
}

interface SsoAssertedIdentity {
  orgId: string;
  provider: "oidc" | "saml";
  issuer: string;
  subject: string;
  email: string;
}

type SsoCompletion =
  | { kind: "signed-in"; userId: string }
  | { kind: "linked"; userId: string }
  | { kind: "refused"; status: 403; error: string; userFacing?: boolean };

export const ssoNotLinkedMessage =
  "This company sign-in isn't linked to a DocSlurp account yet. Sign in the way you usually do, then link company SSO from the SSO settings page.";

async function isOrgMember(orgId: string, userId: string): Promise<boolean> {
  const [membership] = await sql<{ user_id: string }[]>`
    select user_id
    from org_memberships
    where org_id = ${orgId}
      and user_id = ${userId}
    limit 1
  `;
  return Boolean(membership);
}

/** True when the org has DNS-verified this exact domain. */
async function orgHasVerifiedDomain(orgId: string, domain: string | null | undefined): Promise<boolean> {
  const normalized = normalizeEmailDomain(domain ?? null);
  if (!normalized) return false;
  const row = await loadOrgSsoDomain(orgId, normalized);
  return Boolean(row?.verified_at);
}

/**
 * Resolves who an SSO assertion signs in as.
 *
 * SSO never matches a pre-existing account by email: the IdP is configured
 * by an org admin, and the account may predate the SSO connection and belong
 * to other orgs. A session is only issued through a link the user created
 * while signed in (a flow started by POST /:orgId/sso/link). A link flow
 * records the link and issues no session; the user keeps their own.
 */
async function completeSsoAssertion(identity: SsoAssertedIdentity, requestRow: SsoRequestRow): Promise<SsoCompletion> {
  if (requestRow.link_user_id) {
    const [linkUser] = await sql<{ id: string; email: string }[]>`
      select id, email
      from "user"
      where id = ${requestRow.link_user_id}
      limit 1
    `;
    if (!linkUser || linkUser.email.toLowerCase() !== identity.email.toLowerCase()) {
      return { kind: "refused", status: 403, error: "The SSO identity's email does not match the signed-in account" };
    }
    if (!(await isOrgMember(identity.orgId, linkUser.id))) {
      return { kind: "refused", status: 403, error: "SSO user is not a member of this organization" };
    }
    const [taken] = await sql<{ user_id: string }[]>`
      select user_id
      from sso_identity_links
      where org_id = ${identity.orgId}
        and provider = ${identity.provider}
        and issuer = ${identity.issuer}
        and subject = ${identity.subject}
      limit 1
    `;
    if (taken && taken.user_id !== linkUser.id) {
      return { kind: "refused", status: 403, error: "This SSO identity is already linked to another account" };
    }
    await sql`
      insert into sso_identity_links (org_id, user_id, provider, issuer, subject, email)
      values (${identity.orgId}, ${linkUser.id}, ${identity.provider}, ${identity.issuer}, ${identity.subject}, ${identity.email})
      on conflict (org_id, user_id) do update
      set provider = excluded.provider,
          issuer = excluded.issuer,
          subject = excluded.subject,
          email = excluded.email,
          created_at = now()
    `;
    return { kind: "linked", userId: linkUser.id };
  }

  const [link] = await sql<{ user_id: string }[]>`
    select user_id
    from sso_identity_links
    where org_id = ${identity.orgId}
      and provider = ${identity.provider}
      and issuer = ${identity.issuer}
      and subject = ${identity.subject}
    limit 1
  `;
  if (!link) {
    return { kind: "refused", status: 403, error: ssoNotLinkedMessage, userFacing: true };
  }
  if (!(await isOrgMember(identity.orgId, link.user_id))) {
    return { kind: "refused", status: 403, error: "SSO user is not a member of this organization" };
  }
  await sql`
    update sso_identity_links
    set last_used_at = now(), email = ${identity.email}
    where org_id = ${identity.orgId} and user_id = ${link.user_id}
  `;
  return { kind: "signed-in", userId: link.user_id };
}

async function finishSsoCallback(c: any, identity: SsoAssertedIdentity, requestRow: SsoRequestRow): Promise<Response> {
  const result = await completeSsoAssertion(identity, requestRow);
  if (result.kind === "refused") {
    if (result.userFacing) {
      return redirectToApp(c, `/app?authError=${encodeURIComponent(result.error)}&authEmail=${encodeURIComponent(identity.email)}`);
    }
    return apiStatusError(c, result.status, result.error);
  }
  if (result.kind === "linked") {
    return redirectToApp(c, requestRow.redirect_path ?? "/app/sso?linked=1");
  }
  await issueBetterAuthSession(c, result.userId);
  return redirectToApp(c, requestRow.redirect_path ?? "/");
}

async function issueBetterAuthSession(c: any, userId: string): Promise<void> {
  const authContext = (await auth.$context) as {
    secret: string;
    sessionConfig: { expiresIn: number };
    authCookies: {
      sessionToken: {
        name: string;
        attributes: {
          domain?: string;
          expires?: Date;
          httpOnly: boolean;
          maxAge?: number;
          path: string;
          secure: boolean;
          sameSite: "Strict" | "Lax" | "None" | "strict" | "lax" | "none";
          partitioned?: boolean;
        };
      };
    };
    internalAdapter: {
      createSession: (id: string) => Promise<{ token: string } | null>;
    };
  };

  const session = await authContext.internalAdapter.createSession(userId);
  if (!session) {
    throw new Error("Unable to create auth session");
  }

  const signature = createHmac("sha256", authContext.secret).update(session.token).digest("base64");
  const signedToken = `${session.token}.${signature}`;

  setCookie(c, authContext.authCookies.sessionToken.name, signedToken, {
    ...authContext.authCookies.sessionToken.attributes,
    maxAge: authContext.sessionConfig.expiresIn
  });
}

function domainFromEmail(email: string): string | null {
  const domain = email.split("@")[1]?.toLowerCase();
  return domain ? normalizeEmailDomain(domain) : null;
}

function extractEmailFromOidcPayload(payload: Record<string, unknown>): string | null {
  const candidates = [payload.email, payload.preferred_username, payload.upn];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.includes("@")) {
      return candidate.toLowerCase();
    }
  }
  return null;
}

function extractNameFromOidcPayload(payload: Record<string, unknown>, fallbackEmail: string): string {
  if (typeof payload.name === "string" && payload.name.trim()) {
    return payload.name.trim();
  }
  return fallbackEmail.split("@")[0] ?? "Enterprise User";
}

function extractEmailFromSamlProfile(profile: Record<string, unknown>): string | null {
  const candidates = [
    profile.email,
    profile.mail,
    profile["urn:oid:0.9.2342.19200300.100.1.3"],
    profile.nameID
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.includes("@")) {
      return candidate.toLowerCase();
    }
  }
  return null;
}

function redirectToApp(c: any, path = "/"): Response {
  const base = appUrl();
  const safePath = sanitizeRedirectPath(path);
  const target = new URL(safePath, base);
  return c.redirect(target.toString(), 302);
}

function sanitizeRedirectPath(value: string | null | undefined): string {
  return safeRedirectPath(value, "/");
}

const publicNetworkErrorCodes = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"
]);

function errorCode(err: unknown): string | null {
  for (let current: unknown = err, depth = 0; current && depth < 4; current = (current as { cause?: unknown }).cause, depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

/**
 * The connection test exists to tell an admin what is wrong with their IdP
 * settings, so known failure classes keep their reason. Policy and metadata
 * errors name only public facts; network failures are reduced to an error code.
 * Anything else is reported and replaced with the generic public message.
 */
function ssoConnectionTestError(err: unknown): string {
  if (err instanceof SsoMetadataError) {
    return err.message;
  }
  if (err instanceof UnsafeExternalUrlError) {
    return `Metadata URL rejected: ${err.message}`;
  }
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return "Timed out fetching the metadata URL";
  }
  const code = errorCode(err);
  // fetch(redirect: "error") fails with TypeError("fetch failed", { cause: Error("unexpected redirect") }).
  if (err instanceof TypeError && /redirect/i.test(String((err.cause as { message?: unknown } | undefined)?.message ?? ""))) {
    return "Metadata URL redirected; use the final metadata URL (redirects are not followed)";
  }
  if (code && publicNetworkErrorCodes.has(code)) {
    return `Could not fetch the metadata URL (${code})`;
  }
  return reportPublicError(err);
}

async function testOidcConnection(metadataUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await fetchOidcMetadata(metadataUrl);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: ssoConnectionTestError(err) };
  }
}

async function testSamlConnection(metadataUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await fetchSamlMetadata(metadataUrl);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: ssoConnectionTestError(err) };
  }
}

async function loadOrgById(orgId: string): Promise<OrgRow | null> {
  const rows = await sql<OrgRow[]>`
    select id, slug, sso_config
    from organizations
    where id = ${orgId}
    limit 1
  `;
  return rows[0] ?? null;
}

async function loadOrgBySlugOrId(slug: string): Promise<OrgRow | null> {
  const rows = await sql<OrgRow[]>`
    select id, slug, sso_config
    from organizations
    where slug = ${slug} or id = ${slug}
    limit 1
  `;
  return rows[0] ?? null;
}

function ssoErrorResponse(c: any, err: unknown, fallback = "Unauthorized") {
  return apiStatusError(c, 403, reportPublicError(err));
}

async function loadDomainStatus(orgId: string, domain: string | null | undefined) {
  const normalized = normalizeEmailDomain(domain ?? null);
  if (!normalized) return null;
  const row = await loadOrgSsoDomain(orgId, normalized);
  return row ? toDomainStatus(row) : null;
}

function identityFieldsChanged(before: SsoConfig, after: SsoConfig): boolean {
  return (before.providerType ?? null) !== (after.providerType ?? null)
    || (before.metadataUrl ?? null) !== (after.metadataUrl ?? null)
    || (before.clientId ?? null) !== (after.clientId ?? null)
    || (before.emailDomain ?? null) !== (after.emailDomain ?? null);
}

function oidcCallbackUrl(c: any, org: OrgRow): string {
  return `${inferApiOrigin(c.req.raw)}/v1/auth/oidc/${encodeURIComponent(org.id)}/callback`;
}

function samlCallbackUrl(c: any, org: OrgRow): string {
  return `${inferApiOrigin(c.req.raw)}/v1/auth/saml/${encodeURIComponent(org.slug ?? org.id)}/callback`;
}

function createSamlClient(c: any, org: OrgRow, samlMetadata: SamlMetadata, uniqueId?: string): SAML {
  return new SAML({
    entryPoint: samlMetadata.entryPoint,
    idpCert: samlMetadata.certificates,
    issuer: process.env.SAML_SP_ENTITY_ID ?? `${inferApiOrigin(c.req.raw)}/docslurp-sp`,
    callbackUrl: samlCallbackUrl(c, org),
    identifierFormat: null,
    validateInResponseTo: ValidateInResponseTo.always,
    cacheProvider: createSamlRequestCacheProvider(org.id),
    ...(uniqueId ? { generateUniqueId: () => uniqueId } : {}),
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: 5_000,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: true,
    idpIssuer: samlMetadata.issuer ?? undefined
  });
}

function isOidcReady(config: SsoConfig): boolean {
  return Boolean(config.enabled && config.providerType === "oidc" && config.metadataUrl && config.clientId && config.clientSecret);
}

function isSamlReady(config: SsoConfig): boolean {
  return Boolean(config.enabled && config.providerType === "saml" && config.metadataUrl);
}

/** Starts an IdP round trip and returns the URL to send the browser to. */
async function beginSsoFlow(c: any, org: OrgRow, config: SsoConfig, options: {
  redirectPath: string | null;
  linkUserId?: string | null;
}): Promise<{ url: string; state: string }> {
  const state = createStateToken();
  if (config.providerType === "oidc") {
    const metadata = await fetchOidcMetadata(config.metadataUrl!);
    const nonce = createStateToken();
    const codeVerifier = createPkceVerifier();
    await storeSsoRequest({
      state,
      orgId: org.id,
      provider: "oidc",
      codeVerifier,
      nonce,
      redirectPath: options.redirectPath,
      linkUserId: options.linkUserId ?? null
    });

    const authorizeUrl = new URL(metadata.authorization_endpoint);
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", config.clientId!);
    authorizeUrl.searchParams.set("redirect_uri", oidcCallbackUrl(c, org));
    authorizeUrl.searchParams.set("scope", "openid profile email");
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("nonce", nonce);
    authorizeUrl.searchParams.set("code_challenge", createPkceChallenge(codeVerifier));
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    if (options.linkUserId) authorizeUrl.searchParams.set("prompt", "login");
    return { url: authorizeUrl.toString(), state };
  }

  const samlMetadata = await fetchSamlMetadata(config.metadataUrl!);
  await storeSsoRequest({
    state,
    orgId: org.id,
    provider: "saml",
    redirectPath: options.redirectPath,
    linkUserId: options.linkUserId ?? null
  });
  const url = await createSamlClient(c, org, samlMetadata, state).getAuthorizeUrlAsync(state, undefined, {});
  return { url, state };
}

async function requireVerifiedSsoDomain(org: OrgRow, config: SsoConfig, email: string): Promise<string | null> {
  const expectedDomain = normalizeEmailDomain(config.emailDomain ?? null);
  if (!expectedDomain || domainFromEmail(email) !== expectedDomain) {
    return "SSO email domain does not match org SSO domain";
  }
  if (!(await orgHasVerifiedDomain(org.id, expectedDomain))) {
    return "The org's SSO domain is not verified";
  }
  return null;
}

export const ssoRoutes = new Hono()
  .use("*", ssoRateLimit)
  .get("/:orgId/sso", async (c) => {
    const userId = c.get("sessionUser").id;
    const orgId = c.req.param("orgId");

    try {
      await requireOrgAdmin(orgId, userId);
    } catch (err) {
      return ssoErrorResponse(c, err);
    }

    const org = await loadOrgById(orgId);
    if (!org) {
      return apiStatusError(c, 404, "Organization not found");
    }

    const config = sanitizeSsoConfig(org.sso_config);
    return c.json({ ssoConfig: config, domainVerification: await loadDomainStatus(orgId, config.emailDomain) });
  })
  .put("/:orgId/sso", zValidator("json", ssoConfigSchema, validationHook), async (c) => {
    const userId = c.get("sessionUser").id;
    const orgId = c.req.param("orgId");

    try {
      await requireOrgAdmin(orgId, userId);
    } catch (err) {
      return ssoErrorResponse(c, err);
    }

    const org = await loadOrgById(orgId);
    if (!org) {
      return apiStatusError(c, 404, "Organization not found");
    }

    const patch = c.req.valid("json");
    const current = resolveStoredSsoConfig(org.sso_config);
    // Omitted or the "***" placeholder keeps the stored secret; explicit null
    // (or an empty string) clears it; any other value replaces it.
    const resolvedSecret =
      patch.clientSecret === undefined || patch.clientSecret === "***"
        ? (current.clientSecret ?? null)
        : (patch.clientSecret || null);

    const merged: SsoConfig = {
      providerType: patch.providerType !== undefined ? patch.providerType : (current.providerType ?? null),
      metadataUrl: patch.metadataUrl !== undefined ? patch.metadataUrl : (current.metadataUrl ?? null),
      clientId: patch.clientId !== undefined ? patch.clientId : (current.clientId ?? null),
      clientSecret: resolvedSecret,
      enabled: patch.enabled !== undefined ? patch.enabled : (current.enabled ?? false),
      enforceSso: patch.enforceSso !== undefined ? patch.enforceSso : (current.enforceSso ?? false),
      emailDomain:
        patch.emailDomain !== undefined
          ? normalizeEmailDomain(patch.emailDomain)
          : normalizeEmailDomain(current.emailDomain ?? null)
    };

    const validationError = validateConfig(merged);
    if (validationError) {
      return apiStatusError(c, 422, validationError);
    }

    // Vet a new metadata URL at write time (https, no credentials/ports, public
    // addresses only) instead of waiting for the first fetch, so a disabled
    // config can't hold an internal URL that a later enable or test would hit.
    if (merged.metadataUrl && merged.metadataUrl !== (current.metadataUrl ?? null)) {
      try {
        await assertSafeExternalUrl(merged.metadataUrl);
      } catch (err) {
        if (err instanceof UnsafeExternalUrlError) {
          return apiStatusError(c, 422, `metadataUrl rejected: ${err.message}`);
        }
        return apiStatusError(c, 422, reportPublicError(err));
      }
    }

    let domainRow: Awaited<ReturnType<typeof claimSsoDomain>> | null = null;
    if (merged.emailDomain) {
      const domainError = validateClaimableDomain(merged.emailDomain);
      if (domainError) {
        return apiStatusError(c, 422, domainError);
      }
      try {
        domainRow = await claimSsoDomain(orgId, merged.emailDomain, userId);
      } catch (err) {
        if (err instanceof SsoDomainConflictError) {
          return apiStatusError(c, 409, err.message);
        }
        throw err;
      }
    }
    const domainVerification = domainRow ? toDomainStatus(domainRow) : null;

    if ((merged.enabled || merged.enforceSso) && !domainRow?.verified_at) {
      return apiStatusError(c, 422, `Verify ownership of ${merged.emailDomain} with a DNS TXT record before enabling SSO`);
    }

    const stored = toStoredSsoConfig(merged);
    await sql`
      update organizations
      set sso_config = ${sql.json(JSON.parse(JSON.stringify(stored)) as Parameters<typeof sql.json>[0])}
      where id = ${orgId}
    `;
    // A link belongs to one IdP identity for one domain. A new IdP or domain
    // must not inherit links; each user links again.
    if (identityFieldsChanged(current, merged)) {
      await sql`delete from sso_identity_links where org_id = ${orgId}`;
    }

    return c.json({ ssoConfig: sanitizeSsoConfig(merged), domainVerification });
  })
  .post("/:orgId/sso/domain/verify", async (c) => {
    const userId = c.get("sessionUser").id;
    const orgId = c.req.param("orgId");

    try {
      await requireOrgAdmin(orgId, userId);
    } catch (err) {
      return ssoErrorResponse(c, err);
    }

    const org = await loadOrgById(orgId);
    if (!org) {
      return apiStatusError(c, 404, "Organization not found");
    }

    const domain = normalizeEmailDomain(resolveStoredSsoConfig(org.sso_config).emailDomain ?? null);
    if (!domain) {
      return apiStatusError(c, 422, "Save an SSO email domain first");
    }

    try {
      const row = await verifySsoDomain(orgId, domain);
      return c.json({ domainVerification: toDomainStatus(row) });
    } catch (err) {
      if (err instanceof SsoDomainConflictError) {
        return apiStatusError(c, 409, err.message);
      }
      return apiStatusError(c, 422, reportPublicError(err));
    }
  })
  .post("/:orgId/sso/test", async (c) => {
    const userId = c.get("sessionUser").id;
    const orgId = c.req.param("orgId");

    try {
      await requireOrgAdmin(orgId, userId);
    } catch (err) {
      return ssoErrorResponse(c, err);
    }

    const org = await loadOrgById(orgId);
    if (!org) {
      return apiStatusError(c, 404, "Organization not found");
    }

    const config = resolveStoredSsoConfig(org.sso_config);
    if (!config.metadataUrl) {
      return c.json({ ok: false, error: "Metadata URL is required" });
    }

    if (config.providerType === "saml") {
      return c.json(await testSamlConnection(config.metadataUrl));
    }
    return c.json(await testOidcConnection(config.metadataUrl));
  })
  .get("/:orgId/sso/link", async (c) => {
    const user = c.get("sessionUser");
    const orgId = c.req.param("orgId");
    if (!(await isOrgMember(orgId, user.id))) {
      return apiStatusError(c, 403, "Not a member of this organization");
    }
    const org = await loadOrgById(orgId);
    if (!org) {
      return apiStatusError(c, 404, "Organization not found");
    }
    const config = resolveStoredSsoConfig(org.sso_config);
    const domain = normalizeEmailDomain(config.emailDomain ?? null);
    const verified = await orgHasVerifiedDomain(orgId, domain);
    const [link] = await sql<{ email: string; created_at: string; last_used_at: string | null }[]>`
      select email, created_at::text, last_used_at::text
      from sso_identity_links
      where org_id = ${orgId} and user_id = ${user.id}
      limit 1
    `;
    return c.json({
      available: Boolean(verified && (isOidcReady(config) || isSamlReady(config))),
      providerType: config.providerType ?? null,
      emailDomain: domain,
      emailMatchesDomain: Boolean(domain && user.email && domainFromEmail(user.email) === domain),
      link: link ? { email: link.email, linkedAt: link.created_at, lastUsedAt: link.last_used_at } : null
    });
  })
  .post("/:orgId/sso/link", async (c) => {
    const user = c.get("sessionUser");
    const orgId = c.req.param("orgId");
    // JSON only, so a cross-site page can't start a link flow without a CORS preflight.
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
      return apiStatusError(c, 415, "Expected a JSON request");
    }
    if (!(await isOrgMember(orgId, user.id))) {
      return apiStatusError(c, 403, "Not a member of this organization");
    }
    const org = await loadOrgById(orgId);
    if (!org) {
      return apiStatusError(c, 404, "Organization not found");
    }
    const config = resolveStoredSsoConfig(org.sso_config);
    if (!isOidcReady(config) && !isSamlReady(config)) {
      return apiStatusError(c, 400, "SSO is not fully configured for this organization");
    }
    const domainError = await requireVerifiedSsoDomain(org, config, user.email ?? "");
    if (domainError) {
      return apiStatusError(c, 403, domainError);
    }
    const body = (await c.req.json().catch(() => ({}))) as { redirect?: unknown };
    const redirectPath = sanitizeRedirectPath(typeof body.redirect === "string" ? body.redirect : "/app/sso?linked=1");
    const { url: authorizeUrl, state } = await beginSsoFlow(c, org, config, { redirectPath, linkUserId: user.id });
    setSsoStateCookie(c, state);
    return c.json({ authorizeUrl });
  })
  .delete("/:orgId/sso/link", async (c) => {
    const user = c.get("sessionUser");
    const orgId = c.req.param("orgId");
    await sql`delete from sso_identity_links where org_id = ${orgId} and user_id = ${user.id}`;
    return c.json({ ok: true });
  });

export const samlCallbackRoutes = new Hono()
  .use("*", ssoRateLimit)
  .get("/oidc/:orgId/init", async (c) => {
    const orgId = c.req.param("orgId");
    const org = await loadOrgById(orgId);
    if (!org) {
      return apiStatusError(c, 404, "Organization not found");
    }

    const config = resolveStoredSsoConfig(org.sso_config);
    if (!isOidcReady(config) || !(await orgHasVerifiedDomain(org.id, config.emailDomain))) {
      return apiStatusError(c, 400, "OIDC SSO is not fully configured for this organization");
    }

    const { url, state } = await beginSsoFlow(c, org, config, { redirectPath: sanitizeRedirectPath(c.req.query("redirect")) });
    setSsoStateCookie(c, state);
    return c.redirect(url, 302);
  })
  .get("/oidc/:orgId/callback", async (c) => {
    const state = c.req.query("state");
    const code = c.req.query("code");
    if (!state || !code) {
      return apiStatusError(c, 400, "Missing OIDC code/state callback parameters");
    }

    if (!ssoStateMatchesCookie(c, state)) {
      return apiStatusError(c, 400, "Invalid or expired OIDC state");
    }

    const requestRow = await consumeSsoRequest(state, "oidc");
    if (!requestRow || requestRow.org_id !== c.req.param("orgId")) {
      return apiStatusError(c, 400, "Invalid or expired OIDC state");
    }

    const org = await loadOrgById(requestRow.org_id);
    if (!org) {
      return apiStatusError(c, 404, "Organization not found");
    }

    const config = resolveStoredSsoConfig(org.sso_config);
    if (!isOidcReady(config)) {
      return apiStatusError(c, 400, "OIDC SSO is not fully configured for this organization");
    }

    const metadata = await fetchOidcMetadata(config.metadataUrl!);

    const tokenBody = new URLSearchParams();
    tokenBody.set("grant_type", "authorization_code");
    tokenBody.set("code", code);
    tokenBody.set("redirect_uri", oidcCallbackUrl(c, org));
    tokenBody.set("client_id", config.clientId!);
    tokenBody.set("client_secret", config.clientSecret!);
    if (requestRow.code_verifier) {
      tokenBody.set("code_verifier", requestRow.code_verifier);
    }

    const tokenResponse = await safeExternalFetch(metadata.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody,
      signal: AbortSignal.timeout(10_000)
    });

    if (!tokenResponse.ok) {
      return apiStatusError(c, 400, `OIDC token exchange failed (HTTP ${tokenResponse.status})`);
    }

    const tokenJson = (await tokenResponse.json()) as { id_token?: string };
    if (!tokenJson.id_token) {
      return apiStatusError(c, 400, "OIDC response is missing id_token");
    }

    const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri), {
      [customFetch]: (url, init) => safeExternalFetch(url.toString(), init),
    });
    const verification = await jwtVerify(tokenJson.id_token, jwks, {
      issuer: metadata.issuer,
      audience: config.clientId!
    }).catch((err) => {
      throw new Error("Failed to verify company sign-in", { cause: err });
    });

    if (!requestRow.nonce || verification.payload.nonce !== requestRow.nonce) {
      return apiStatusError(c, 400, "OIDC nonce mismatch");
    }

    const payload = verification.payload as Record<string, unknown>;
    const email = extractEmailFromOidcPayload(payload);
    if (!email) {
      return apiStatusError(c, 400, "OIDC token does not include a valid email claim");
    }
    if (typeof payload.sub !== "string" || !payload.sub) {
      return apiStatusError(c, 400, "OIDC token does not include a subject");
    }

    const domainError = await requireVerifiedSsoDomain(org, config, email);
    if (domainError) {
      return apiStatusError(c, 403, domainError);
    }

    return await finishSsoCallback(c, {
      orgId: org.id,
      provider: "oidc",
      issuer: metadata.issuer,
      subject: payload.sub,
      email
    }, requestRow);
  })
  .get("/saml/:orgSlug/init", async (c) => {
    const orgSlug = c.req.param("orgSlug");
    const org = await loadOrgBySlugOrId(orgSlug);
    if (!org) {
      return apiStatusError(c, 404, "Organization not found");
    }

    const config = resolveStoredSsoConfig(org.sso_config);
    if (!isSamlReady(config) || !(await orgHasVerifiedDomain(org.id, config.emailDomain))) {
      return apiStatusError(c, 400, "SAML SSO is not fully configured for this organization");
    }

    const { url, state } = await beginSsoFlow(c, org, config, { redirectPath: sanitizeRedirectPath(c.req.query("redirect")) });
    setSsoStateCookie(c, state);
    return c.redirect(url, 302);
  })
  .post("/saml/:orgSlug/callback", async (c) => {
    const orgSlug = c.req.param("orgSlug");
    const org = await loadOrgBySlugOrId(orgSlug);
    if (!org) {
      return apiStatusError(c, 404, "Organization not found");
    }

    const config = resolveStoredSsoConfig(org.sso_config);
    if (!isSamlReady(config)) {
      return apiStatusError(c, 400, "SAML SSO is not fully configured for this organization");
    }

    const formData = await c.req.formData().catch(() => null);
    const samlResponse = formData?.get("SAMLResponse");
    const relayState = formData?.get("RelayState");
    if (typeof samlResponse !== "string" || typeof relayState !== "string") {
      return apiStatusError(c, 400, "Missing required SAML callback parameters");
    }

    if (!ssoStateMatchesCookie(c, relayState)) {
      return apiStatusError(c, 400, "Invalid or expired SAML RelayState");
    }

    const requestRow = await consumeSsoRequest(relayState, "saml");
    if (!requestRow || requestRow.org_id !== org.id) {
      return apiStatusError(c, 400, "Invalid or expired SAML RelayState");
    }

    const samlMetadata = await fetchSamlMetadata(config.metadataUrl!);
    const validated = await createSamlClient(c, org, samlMetadata).validatePostResponseAsync({ SAMLResponse: samlResponse });
    const profile = validated.profile as Record<string, unknown> | null;
    if (!profile) {
      return apiStatusError(c, 400, "SAML response did not contain an authenticated profile");
    }

    const email = extractEmailFromSamlProfile(profile);
    if (!email) {
      return apiStatusError(c, 400, "SAML assertion did not include an email attribute");
    }
    const subject = typeof profile.nameID === "string" ? profile.nameID : null;
    if (!subject) {
      return apiStatusError(c, 400, "SAML assertion did not include a NameID");
    }

    const domainError = await requireVerifiedSsoDomain(org, config, email);
    if (domainError) {
      return apiStatusError(c, 403, domainError);
    }

    const issuer = (typeof profile.issuer === "string" && profile.issuer)
      || samlMetadata.issuer
      || config.metadataUrl!;
    return await finishSsoCallback(c, { orgId: org.id, provider: "saml", issuer, subject, email }, requestRow);
  });

// SSO sign-in starts and IdP callbacks are public by design.
authenticatedByRoute(samlCallbackRoutes);

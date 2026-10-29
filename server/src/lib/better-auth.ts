import { reportPublicError, safeErrorResponse } from "./public-errors.js";
import "../env.js";

import { betterAuth } from "better-auth";
import { createBetterAuthSecurityOptions, resolveBetterAuthBaseUrl, isEmailAuthConfigured } from "@docslurp/shared/auth-security";
import { Pool } from "pg";
import { notifySignup } from "./signup-notifications.js";
import { ensureUserAndOrganization } from "../services/account-provisioning.js";
import { cookieHeaderFromAuthContext, recordSignupAttribution } from "../services/signup-attribution.js";
import { applyAccountKindRules } from "../services/account-kind.js";
import { admitConfiguredAdminUser } from "./admin-emails.js";
import { createAuthEmailOptions, sendAuthEmailCode } from "./auth-email.js";
import { breachedPasswordPlugins, resolveBreachedPasswordPolicy } from "./auth-breached-password.js";
import { databaseAuthBudgetStore, emailRecipientLimitPlugin, emailRecipientLimitsEnabled } from "./auth-rate-limits.js";
import { developmentTrustedOrigins } from "./dev-auth-access.js";
import { withTrustedAuthClientIp } from "./client-ip.js";
import { beforeOAuthAccountCreate } from "./oauth-account-linking.js";
import { createMfaPlugins, resolveMfaConfig, sessionAssuranceFields, sessionAssuranceFor } from "./auth-mfa.js";
import { sensitiveEmailPlugin } from "./auth-sensitive-email.js";
import { sensitiveAccessPlugin, grantSensitiveAccess, recordSensitiveFirstFactorProof, getSensitiveAccessStatus } from "./auth-sensitive-access.js";
import { ssoEnforcementPlugin } from "./sso-enforcement.js";

/**
 * pg's idle timer freezes with a suspended Fly Machine, leaving idle clients whose
 * sockets the network reset. After an idle gap, destroy the idle clients before
 * handing one out (public API only: connect() pops an idle client, release(true) destroys it).
 */
function guardPoolAgainstResume(
  target: Pool,
  gapMs = Number(process.env.DATABASE_RESUME_GAP_MS ?? 30_000),
  resumeLogGapMs = Number(process.env.DATABASE_RESUME_LOG_GAP_MS ?? 5 * 60_000),
): void {
  if (!(gapMs > 0)) return;
  const raw = target as unknown as Record<"connect" | "query", (...args: unknown[]) => unknown>;
  if (typeof raw.connect !== "function" || typeof raw.query !== "function") return; // partial pg mocks in tests
  const connect = raw.connect.bind(target);
  const query = raw.query.bind(target);
  let lastSeen = Date.now();
  let discarding: Promise<void> | null = null;
  const gate = (): Promise<void> => {
    if (discarding) return discarding;
    const at = Date.now();
    const gap = at - lastSeen;
    lastSeen = at;
    if (gap < gapMs) return Promise.resolve();
    if (gap >= resumeLogGapMs) console.info(`[db-pool] auth pool idle for ${Math.round(gap / 1000)}s (likely a suspend); discarding ${target.idleCount} idle connections`);
    return discarding = (async () => {
      for (let idle = target.idleCount; idle > 0; idle -= 1) {
        ((await connect()) as { release(destroy?: boolean): void }).release(true);
      }
    })().catch(() => undefined).finally(() => { discarding = null; });
  };
  // Callback-style connect() is pg's own internal path (query() uses it); only promise-style callers and query() are gated.
  raw.connect = (...args) => (args.length > 0 ? connect(...args) : gate().then(() => connect()));
  raw.query = (...args) => {
    const gated = gate();
    return typeof args.at(-1) === "function" ? void gated.then(() => query(...args)) : gated.then(() => query(...args));
  };
}

const globalPool = globalThis as typeof globalThis & { __docslurpAuthPool?: Pool };

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://docslurp:docslurp@localhost:5432/docslurp";

const pool = globalPool.__docslurpAuthPool ?? new Pool({ connectionString, keepAlive: true, idleTimeoutMillis: 20_000, maxLifetimeSeconds: 900 });
guardPoolAgainstResume(pool);
if (process.env.NODE_ENV !== "production") {
  globalPool.__docslurpAuthPool = pool;
}

const betterAuthSecret = process.env.BETTER_AUTH_SECRET?.trim();
if (!betterAuthSecret && process.env.NODE_ENV === "production") {
  throw new Error("BETTER_AUTH_SECRET is required in production");
}
if (betterAuthSecret === "dev-secret-change-me" && process.env.NODE_ENV === "production") {
  throw new Error("BETTER_AUTH_SECRET must be a strong, non-default value in production");
}

export const appDbPool = pool;
export const configuredEmailAuth = isEmailAuthConfigured(process.env);
export const configuredMagicLinkAuth = configuredEmailAuth;

const oauthTokenEncryptionKey = process.env.OAUTH_TOKEN_ENCRYPTION_KEY?.trim();
if (!oauthTokenEncryptionKey && process.env.NODE_ENV === "production") {
  throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY is required in production");
}

const socialProviders: NonNullable<Parameters<typeof betterAuth>[0]["socialProviders"]> = {};

if (process.env.GITHUB_CLIENT_ID?.trim() && process.env.GITHUB_CLIENT_SECRET?.trim()) {
  socialProviders.github = {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET
  };
}

if (process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim()) {
  socialProviders.google = {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    // Let people signed in to several Google accounts pick one instead of
    // silently reusing the browser's current account.
    prompt: "select_account"
  };
}

const socialSignInProviders = new Set(["github", "google"]);
const signInTokenFields = ["accessToken", "refreshToken", "idToken"] as const;

/** Nulls whichever sign-in tokens an account update carries; other fields pass through. */
export function withoutSocialSignInTokens<T extends Record<string, unknown>>(update: T): T {
  if (!signInTokenFields.some((field) => update[field] != null)) return update;
  const stripped: Record<string, unknown> = { ...update };
  for (const field of signInTokenFields) {
    if (field in stripped) stripped[field] = null;
  }
  return stripped as T;
}

export const configuredSocialProviders = Object.freeze({
  github: Boolean(socialProviders.github),
  google: Boolean(socialProviders.google)
});

export type DevSeedAccountKey = "admin" | "member";

export interface DevSeedAccountDescriptor {
  id: DevSeedAccountKey;
  label: string;
  email: string;
}

interface DevSeedAccountCredential extends DevSeedAccountDescriptor {
  password: string;
}

function resolveDevSeedAccountCredentials(): DevSeedAccountCredential[] {
  return [
    {
      id: "admin",
      label: "Seed admin",
      email: process.env.SEED_ADMIN_EMAIL ?? "admin@docslurp.local",
      password: process.env.SEED_ADMIN_PASSWORD ?? "testtest"
    },
    {
      id: "member",
      label: "Seed member",
      email: process.env.SEED_MEMBER_EMAIL ?? "member@docslurp.local",
      password: process.env.SEED_MEMBER_PASSWORD ?? "testtest"
    }
  ];
}

export function isDevSeedQuickLoginEnabled(): boolean {
  // Keep seed-user quick login available in local dev without an extra flag.
  // The route checks the local/LAN/Tailnet origin before issuing a session cookie.
  return process.env.NODE_ENV === "development";
}

export function getDevSeedAccountDescriptors(): DevSeedAccountDescriptor[] {
  if (!isDevSeedQuickLoginEnabled()) {
    return [];
  }

  return resolveDevSeedAccountCredentials().map(({ id, label, email }) => ({ id, label, email }));
}

export function getDevSeedAccountCredential(id: DevSeedAccountKey): DevSeedAccountCredential | null {
  if (!isDevSeedQuickLoginEnabled()) {
    return null;
  }

  return resolveDevSeedAccountCredentials().find((account) => account.id === id) ?? null;
}

const securityOptions = createBetterAuthSecurityOptions(process.env);
const emailOptions = createAuthEmailOptions(process.env);
/** Invalid values fail startup; see auth-breached-password.ts for the outage policy. */
export const breachedPasswordPolicy = resolveBreachedPasswordPolicy(process.env);
/**
 * One password-recovery path: native Email OTP reset. The link-based reset
 * endpoints have no sender configured, and the deprecated OTP alias would be a
 * second spelling of the same flow for every policy to track.
 */
export const DISABLED_AUTH_PATHS = ["/forget-password/email-otp", "/request-password-reset", "/reset-password"];
/** Passkey relying party and 2FA settings; invalid passkey origins fail startup. */
export const mfaConfig = resolveMfaConfig(process.env, securityOptions.baseURL);
export const auth = betterAuth({
  onAPIError: { onError: (error) => { reportPublicError(error, { surface: "auth" }); } },
  database: pool,
  socialProviders,
  secret: betterAuthSecret ?? "dev-secret-change-me",
  ...securityOptions,
  trustedOrigins: (request) => developmentTrustedOrigins(securityOptions.trustedOrigins, request),
  baseURL: resolveBetterAuthBaseUrl(process.env),
  ...emailOptions,
  disabledPaths: DISABLED_AUTH_PATHS,
  // SSO issuance policy and MFA assurance both apply to every new session.
  // The recipient limit follows SSO enforcement: an enforced address is
  // refused before it spends any email budget.
  plugins: [...emailOptions.plugins, ssoEnforcementPlugin({ pool }),
    emailRecipientLimitPlugin({ store: databaseAuthBudgetStore(pool), enabled: emailRecipientLimitsEnabled(process.env) }),
    ...breachedPasswordPlugins(breachedPasswordPolicy),
    ...createMfaPlugins({ pool, config: mfaConfig }), sensitiveAccessPlugin({ pool, config: mfaConfig }),
    sensitiveEmailPlugin({ pool, sendCode: sendAuthEmailCode, grant: grantSensitiveAccess, recordFirstFactor: recordSensitiveFirstFactorProof, getStatus: getSensitiveAccessStatus })],
  session: { ...securityOptions.session, additionalFields: sessionAssuranceFields },
  databaseHooks: {
    session: {
      create: {
        before: async (session, ctx) => {
          const result = await pool.query<{ name: string }>('select name from "user" where id = $1 and deleted_at is null', [session.userId]);
          if (result.rows[0]) {
            await ensureUserAndOrganization(pool, { id: session.userId, name: result.rows[0].name ?? "" });
          }
          await admitConfiguredAdminUser(pool, session.userId);
          // Staff is recognized once the address is verified; analytics only, never blocks sign-in.
          await applyAccountKindRules(pool, [session.userId])
            .catch(error => console.warn("[account-kind] not applied", error instanceof Error ? error.message : error));
          // Whether this session passed a second factor, decided by the endpoint
          // that created it (see sessionAssuranceFor), never by request input.
          return { data: { ...session, ...sessionAssuranceFor(ctx, session.userId) } };
        }
      }
    },
    user: {
      create: {
        after: async (user, ctx) => {
          await ensureUserAndOrganization(pool, { id: user.id, name: user.name ?? "" });
          // First-touch referrer/UTM for the admin user panel; never blocks sign-up.
          await recordSignupAttribution(pool, user.id, cookieHeaderFromAuthContext(ctx))
            .catch(error => console.warn("[signup-attribution] not recorded", error instanceof Error ? error.message : error));
          await applyAccountKindRules(pool, [user.id])
            .catch(error => console.warn("[account-kind] not applied", error instanceof Error ? error.message : error));
          await notifySignup({ kind: "account", email: user.email, name: user.name });
        }
      }
    },
    account: {
      update: {
        // Sign-in tokens are only kept encrypted in oauth_accounts (see create
        // below). Better Auth rewrites them onto the account row on every
        // repeat sign-in, so strip them there too.
        before: async (account) => ({ data: withoutSocialSignInTokens(account) })
      },
      create: {
        before: beforeOAuthAccountCreate,
        after: async (account) => {
          if (!socialSignInProviders.has(account.providerId)) return;

          if (!oauthTokenEncryptionKey) {
            console.warn("[oauth] OAUTH_TOKEN_ENCRYPTION_KEY is not set; skipping OAuth token persistence");
            return;
          }

          try {
            await pool.query(
              `
                insert into oauth_accounts (
                  user_id, provider, provider_account_id,
                  access_token_encrypted, refresh_token_encrypted, token_expires_at, raw_profile
                )
                values (
                  $1,
                  $2,
                  $3,
                  pgp_sym_encrypt($4::text, $8::text),
                  pgp_sym_encrypt($5::text, $8::text),
                  $6,
                  $7
                )
                on conflict (provider, provider_account_id) do update
                  set access_token_encrypted = excluded.access_token_encrypted,
                      refresh_token_encrypted = excluded.refresh_token_encrypted,
                      token_expires_at = excluded.token_expires_at,
                      updated_at = now()
              `,
              [
                account.userId,
                account.providerId,
                account.accountId,
                account.accessToken ?? null,
                account.refreshToken ?? null,
                account.accessTokenExpiresAt ?? null,
                "{}",
                oauthTokenEncryptionKey
              ]
            );
            await pool.query(
              `
                update account
                set
                  "accessToken" = null,
                  "refreshToken" = null,
                  "idToken" = null
                where "providerId" = $1
                  and "accountId" = $2
              `,
              [account.providerId, account.accountId]
            );
          } catch (err) {
            console.error("[oauth] failed to persist oauth_account record:", err instanceof Error ? err.message : String(err));
          }
        }
      }
    }
  }
});

/**
 * The only way requests should reach Better Auth's router: it replaces any
 * client-supplied auth client-IP header with the edge-derived address, so the
 * sign-in, sign-up and password-reset rate limits key on the real client.
 */
export async function handleAuthRequest(request: Request, options: { trustedInternal?: boolean } = {}): Promise<Response> {
  return safeErrorResponse(await auth.handler(withTrustedAuthClientIp(request, options)));
}

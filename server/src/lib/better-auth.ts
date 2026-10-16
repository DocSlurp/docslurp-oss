import { reportPublicError, safeErrorResponse } from "./public-errors.js";
import "../env.js";

import { betterAuth } from "better-auth";
import { createBetterAuthSecurityOptions, resolveBetterAuthBaseUrl, isEmailAuthConfigured } from "@docslurp/shared/auth-security";
import { Pool } from "pg";
import { notifySignup } from "./signup-notifications.js";
import { ensureUserAndOrganization } from "../services/account-provisioning.js";
import { admitConfiguredAdminUser } from "./admin-emails.js";
import { createAuthEmailOptions } from "./auth-email.js";
import { developmentTrustedOrigins } from "./dev-auth-access.js";
import { withTrustedAuthClientIp } from "./client-ip.js";

const globalPool = globalThis as typeof globalThis & { __docslurpAuthPool?: Pool };

const connectionString =
  process.env.DATABASE_URL ??
  "postgres://docslurp:docslurp@localhost:5432/docslurp";

const pool = globalPool.__docslurpAuthPool ?? new Pool({ connectionString });
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
    clientSecret: process.env.GOOGLE_CLIENT_SECRET
  };
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
export const auth = betterAuth({
  onAPIError: { onError: (error) => { reportPublicError(error, { surface: "auth" }); } },
  database: pool,
  socialProviders,
  secret: betterAuthSecret ?? "dev-secret-change-me",
  ...securityOptions,
  trustedOrigins: (request) => developmentTrustedOrigins(securityOptions.trustedOrigins, request),
  baseURL: resolveBetterAuthBaseUrl(process.env),
  ...createAuthEmailOptions(process.env),
  databaseHooks: {
    session: {
      create: {
        before: async (session) => {
          const result = await pool.query<{ name: string }>('select name from "user" where id = $1 and deleted_at is null', [session.userId]);
          if (result.rows[0]) {
            await ensureUserAndOrganization(pool, { id: session.userId, name: result.rows[0].name ?? "" });
          }
          await admitConfiguredAdminUser(pool, session.userId);
          return { data: session };
        }
      }
    },
    user: {
      create: {
        after: async (user) => {
          await ensureUserAndOrganization(pool, { id: user.id, name: user.name ?? "" });
          await notifySignup({ kind: "account", email: user.email, name: user.name });
        }
      }
    },
    account: {
      create: {
        after: async (account) => {
          const oauthProviders = new Set(["github", "google"]);
          if (!oauthProviders.has(account.providerId)) return;

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

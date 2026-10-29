/** Fixed, non-sliding explicit proof window for sensitive account actions. */
export const SENSITIVE_ACCESS_WINDOW_SECONDS = 600;
/** Same knob as the existing MFA reauthentication policy, validated at startup. */
export function sensitiveAccessWindowSeconds(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MFA_REAUTH_MAX_AGE_SECONDS;
  if (raw === undefined || raw.trim() === "") return SENSITIVE_ACCESS_WINDOW_SECONDS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 60 || value > 3600) throw new Error("MFA_REAUTH_MAX_AGE_SECONDS must be an integer from 60 to 3600");
  return value;
}

/** Set only by the app (server/src/lib/client-ip.ts) before Better Auth sees a request. */
export const BETTER_AUTH_CLIENT_IP_HEADER = "x-docslurp-client-ip";

function readEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isHttpsOrigin(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function parseOrigins(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function resolveBetterAuthBaseUrl(env: NodeJS.ProcessEnv): string {
  const baseUrl = (
    readEnv(env.BETTER_AUTH_URL) ??
    readEnv(env.APP_URL) ??
    "http://localhost:4321"
  );

  if (env.NODE_ENV === "production") {
    let parsed: URL;
    try {
      parsed = new URL(baseUrl);
    } catch {
      throw new Error("BETTER_AUTH_URL or APP_URL must be a valid production URL");
    }
    const hostname = parsed.hostname.toLowerCase();
    // Single-host self-hosting on the same machine has no TLS to offer: an explicit opt-in allows a plain
    // loopback origin. Anything else (public hosts over http, a bare flag with a public origin) still fails.
    const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
    if (loopback && parsed.protocol === "http:" && env.DOCSLURP_ALLOW_INSECURE_LOCAL_AUTH_ORIGIN === "true") {
      return baseUrl;
    }
    if (
      parsed.protocol !== "https:" ||
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1"
    ) {
      throw new Error("BETTER_AUTH_URL or APP_URL must use a public HTTPS origin in production");
    }
  }

  return baseUrl;
}

export function resolveBetterAuthTrustedOrigins(
  env: NodeJS.ProcessEnv,
  baseUrl = resolveBetterAuthBaseUrl(env)
): string[] {
  const origins: string[] = [];

  try {
    origins.push(new URL(baseUrl).origin);
  } catch {
    // Ignore invalid URLs here; Better Auth will validate baseURL separately.
  }

  for (const candidate of [
    env.PUBLIC_API_URL,
    env.INTERNAL_API_URL,
    env.API_URL,
    env.BETTER_AUTH_TRUSTED_ORIGINS
  ]) {
    origins.push(...parseOrigins(candidate));
  }

  return unique(origins);
}

export function isEmailAuthConfigured(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.RESEND_API_KEY?.trim() && env.EMAIL_FROM?.trim());
}

/** Signed-in sessions expire after this long without an authenticated request. */
export const SESSION_IDLE_TIMEOUT_SECONDS = 60 * 60 * 24 * 30;
/** How often an active session's expiry (and cookie) is extended. */
export const SESSION_REFRESH_AGE_SECONDS = 60 * 60 * 24;

export function createBetterAuthSecurityOptions(env: NodeJS.ProcessEnv) {
  const baseURL = resolveBetterAuthBaseUrl(env);

  return {
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: false,
        allowDifferentEmails: false,
        requireLocalEmailVerified: false,
        // Never bypass the OAuth provider's verified-email assertion.
        trustedProviders: [] as string[],
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !isEmailAuthConfigured(env),
      requireEmailVerification: true
    },
    basePath: "/api/auth",
    baseURL,
    trustedOrigins: resolveBetterAuthTrustedOrigins(env, baseURL),
    session: {
      // Sliding 30-day idle timeout: any authenticated request more than a day
      // after the last refresh pushes expiry out again (server middleware
      // forwards the refreshed cookie). Revocation stays immediate because the
      // session row is checked on every request (see cookieCache below), and
      // sensitive account changes still require a session under an hour old.
      expiresIn: SESSION_IDLE_TIMEOUT_SECONDS,
      updateAge: SESSION_REFRESH_AGE_SECONDS,
      freshAge: 60 * 60,
      // A cached `session_data` cookie authorizes on its own until it expires, so
      // a revoked or signed-out session would keep working on another device for
      // the cache lifetime (SEC-2026-10-PROD-15). Every request checks the
      // session row instead.
      cookieCache: {
        enabled: false
      }
    },
    rateLimit: {
      enabled: env.NODE_ENV === "production",
      // Shared across machines (the "rateLimit" table, migration 0038) rather
      // than per-process memory, so N app machines don't multiply the limits.
      storage: "database" as const,
      window: 60,
      max: 100,
      customRules: {
        "/sensitive-access/password": { window: 60, max: 5 },
        "/sensitive-access/passkey/options": { window: 60, max: 10 },
        "/sensitive-access/passkey/verify": { window: 60, max: 10 },
        "/sign-in/magic-link": { window: 60, max: 3 },
        "/sign-in/email": {
          window: 10,
          max: 3
        },
        "/sign-up/email": {
          window: 60,
          max: 3
        },
        // Password reset is native Email OTP (/email-otp/*, limited by that
        // plugin); the link-based /request-password-reset and /reset-password
        // are disabled in server/src/lib/better-auth.ts.
        // Second-factor codes: per-IP limits on top of the twoFactor plugin's
        // per-challenge (5) and per-account (10, then a 15-minute lock) budgets.
        "/two-factor/verify-totp": {
          window: 60,
          max: 10
        },
        "/two-factor/verify-backup-code": {
          window: 60,
          max: 10
        },
        "/passkey/verify-authentication": {
          window: 60,
          max: 20
        }
      }
    },
    advanced: {
      useSecureCookies: isHttpsOrigin(baseURL),
      // Pin the session cookie policy instead of relying on library defaults:
      // Lax blocks cross-site sends (the CSRF boundary, SEC-2026-10-02), and
      // HttpOnly keeps the token out of reach of script.
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax" as const,
        secure: isHttpsOrigin(baseURL)
      },
      trustedProxyHeaders: env.BETTER_AUTH_TRUST_PROXY_HEADERS === "true",
      ipAddress: {
        // Only a header the app sets itself (resolved by
        // @docslurp/shared/client-ip: Fly-Client-IP, CF-Connecting-IP from a
        // trusted Cloudflare peer, or the X-Forwarded-For walk) after deleting any client-supplied
        // copy. cf-connecting-ip / x-real-ip / x-forwarded-for are all
        // client-controlled on Fly and let an attacker rotate rate-limit keys.
        ipAddressHeaders: [BETTER_AUTH_CLIENT_IP_HEADER],
        ipv6Subnet: 64 as const
      }
    }
  };
}

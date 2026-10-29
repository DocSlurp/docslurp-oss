import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, isAPIError } from "better-auth/api";
import { haveIBeenPwned } from "better-auth/plugins";

import { assertReviewedBetterAuth } from "./auth-compat.js";
import { reportPublicError } from "./public-errors.js";

/**
 * Breached-password rejection: Better Auth's native `haveIBeenPwned` plugin
 * does the lookup (k-anonymity: only the first five characters of the
 * password's SHA-1 leave the server), and this module adds DocSlurp's outage
 * policy around it.
 *
 * The native lookup has no deadline and answers a failed lookup with a bare
 * 500. Here a lookup that fails or exceeds `timeoutMs` refuses the new
 * password with `503 PASSWORD_CHECK_UNAVAILABLE`: fail closed, never store an
 * unchecked password, and tell the user it is temporary. Nothing is consumed
 * on refusal: Email OTP reset only spends its code after the hash succeeds, so
 * the user can retry with the same code.
 */

/** Every endpoint that stores a new password. Sign-in only verifies, so it is never checked. */
export const BREACHED_PASSWORD_PATHS: readonly string[] = [
  "/sign-up/email",
  "/change-password",
  "/email-otp/reset-password",
  "/reset-password",
  "/set-password",
];

export const PASSWORD_COMPROMISED_CODE = "PASSWORD_COMPROMISED";
export const PASSWORD_CHECK_UNAVAILABLE_CODE = "PASSWORD_CHECK_UNAVAILABLE";

export interface BreachedPasswordPolicy {
  enabled: boolean;
  timeoutMs: number;
}

/**
 * `AUTH_BREACHED_PASSWORD_CHECK=on|off`, on by default in production and off
 * elsewhere (tests and local seed workflows stay offline). Hosts without
 * internet access set it to `off` explicitly.
 */
export function resolveBreachedPasswordPolicy(env: NodeJS.ProcessEnv): BreachedPasswordPolicy {
  const raw = env.AUTH_BREACHED_PASSWORD_CHECK?.trim().toLowerCase();
  if (raw && raw !== "on" && raw !== "off") throw new Error("AUTH_BREACHED_PASSWORD_CHECK must be on or off");
  const timeoutRaw = env.AUTH_BREACHED_PASSWORD_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : 3_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 10_000) {
    throw new Error("AUTH_BREACHED_PASSWORD_TIMEOUT_MS must be an integer from 500 to 10000");
  }
  const enabled = raw ? raw === "on" : env.NODE_ENV === "production";
  if (!enabled && env.NODE_ENV === "production") {
    console.warn("[auth-breach-check] AUTH_BREACHED_PASSWORD_CHECK=off: new passwords are not checked against known breaches");
  }
  return { enabled, timeoutMs };
}

class BreachCheckTimeout extends Error {
  constructor() { super("breached-password lookup timed out"); }
}

function isCompromisedRefusal(error: unknown): boolean {
  return isAPIError(error) && (error.body as { code?: unknown } | undefined)?.code === PASSWORD_COMPROMISED_CODE;
}

/** Wraps the native plugin's password hash; registered after it, so it sees the wrapped hash. */
export function breachedPasswordOutagePolicy(policy: BreachedPasswordPolicy, paths: readonly string[] = BREACHED_PASSWORD_PATHS): BetterAuthPlugin {
  return {
    id: "docslurp-breached-password-policy",
    init(ctx) {
      const hash = ctx.password.hash;
      return {
        context: {
          password: {
            ...ctx.password,
            async hash(password: string): Promise<string> {
              const path = tryGetCurrentAuthEndpointContext()?.path;
              if (!path || !paths.includes(path)) return hash(password);
              const work = hash(password);
              // A lookup abandoned at the deadline must not surface later as an unhandled rejection.
              work.catch(() => undefined);
              let timer: NodeJS.Timeout | undefined;
              const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new BreachCheckTimeout()), policy.timeoutMs); });
              try {
                return await Promise.race([work, deadline]);
              } catch (error) {
                if (isCompromisedRefusal(error)) throw error;
                const reason = error instanceof BreachCheckTimeout ? "timeout" : "lookup_failed";
                console.error(`[auth-breach-check] refused a new password reason=${reason} path=${path}. Set AUTH_BREACHED_PASSWORD_CHECK=off only on hosts without internet access.`);
                reportPublicError(new Error(`breached-password check unavailable: ${reason}`), { surface: "auth-breach-check", path });
                throw new APIError("SERVICE_UNAVAILABLE", {
                  code: PASSWORD_CHECK_UNAVAILABLE_CODE,
                  message: "We couldn't check that password against known breaches. Try again in a minute.",
                }, { "Retry-After": "60" });
              } finally {
                clearTimeout(timer);
              }
            },
          },
        },
      };
    },
  } as BetterAuthPlugin;
}

/** The native check plus its outage policy, in that order; empty when the check is off. */
export function breachedPasswordPlugins(policy: BreachedPasswordPolicy): BetterAuthPlugin[] {
  if (!policy.enabled) return [];
  const native = haveIBeenPwned({ paths: [...BREACHED_PASSWORD_PATHS] });
  // The outage policy wraps the hash this plugin installs from its init().
  assertReviewedBetterAuth("haveIBeenPwned outage policy", native.version);
  return [native as unknown as BetterAuthPlugin, breachedPasswordOutagePolicy(policy)];
}

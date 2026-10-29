import { createHash } from "node:crypto";

import { getBetterAuthVersion, tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import { instrumentFetch } from "@docslurp/shared/observability";
import type { BetterAuthPlugin } from "better-auth";
import { APIError } from "better-auth/api";

import { assertReviewedBetterAuth } from "./auth-compat.js";
import { reportPublicError } from "./public-errors.js";

/**
 * Breached-password rejection on Have I Been Pwned's k-anonymity range API.
 *
 * This follows Better Auth's own `haveIBeenPwned` plugin: the same
 * `ctx.password.hash` hook installed from `init`, the same endpoint-path
 * selection, the same padded range request and the same `PASSWORD_COMPROMISED`
 * code. It is not the native plugin because that plugin's lookup takes no
 * abort signal or deadline and turns every failure into a bare 500. Here the
 * request itself is cancelled at `timeoutMs`, at most `maxInFlight` lookups run
 * per process, the call is traced like every other dependency, and any failure
 * refuses the new password with `503 PASSWORD_CHECK_UNAVAILABLE`. That fails
 * closed: an unchecked password is never stored. Email OTP reset only spends
 * its code after the hash succeeds, so a refused reset can be retried with the
 * same code while it lasts.
 *
 * Only the first five characters of the password's SHA-1 leave the server.
 * Neither the password, its hash nor the request URL is logged.
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
const RANGE_API = "https://api.pwnedpasswords.com/range/";

export interface BreachedPasswordPolicy {
  enabled: boolean;
  timeoutMs: number;
  /** Lookups allowed in flight per process; more are refused at once. */
  maxInFlight: number;
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
  return { enabled, timeoutMs, maxInFlight: 32 };
}

export type BreachLookupFailure = "timeout" | "upstream_status" | "network" | "malformed" | "saturated";

export class BreachLookupError extends Error {
  constructor(readonly reason: BreachLookupFailure, readonly upstreamStatus?: number) {
    super(`breached-password lookup failed: ${reason}${upstreamStatus ? ` status=${upstreamStatus}` : ""}`);
    this.name = "BreachLookupError";
  }
}

const isAbort = (error: unknown) => error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");

const RANGE_LINE = /^([0-9A-F]{35}):(\d{1,12})$/i;

/**
 * Reads a range answer strictly: every line must be a 35-character suffix
 * and a count, and there must be at least one (the API pads every answer to
 * hundreds of lines). An empty body, an HTML error page or any malformed line
 * is a failed lookup, never a clean one. A cleanly truncated list of valid
 * lines can't be told apart from content alone; the transport's own length
 * checks are the only guard there.
 */
export function compromiseCount(body: string, hashSuffix: string): number {
  const suffix = hashSuffix.toUpperCase();
  let lines = 0;
  let count = 0;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = RANGE_LINE.exec(line);
    if (!match) throw new BreachLookupError("malformed");
    lines += 1;
    if (match[1]!.toUpperCase() === suffix) count = Number(match[2]);
  }
  if (lines === 0) throw new BreachLookupError("malformed");
  return count;
}

export interface BreachLookup {
  /** Lookups currently waiting on the range API in this process. */
  readonly inFlight: number;
  isCompromised(password: string): Promise<boolean>;
}

export function createBreachLookup(policy: Pick<BreachedPasswordPolicy, "timeoutMs" | "maxInFlight">): BreachLookup {
  let inFlight = 0;
  return {
    get inFlight() { return inFlight; },
    async isCompromised(password) {
      if (inFlight >= policy.maxInFlight) throw new BreachLookupError("saturated");
      const digest = createHash("sha1").update(password).digest("hex").toUpperCase();
      inFlight += 1;
      try {
        // One signal bounds the whole exchange, body included.
        const signal = AbortSignal.timeout(policy.timeoutMs);
        let response: Response;
        try {
          response = await instrumentFetch("hibp", "password-range")(`${RANGE_API}${digest.slice(0, 5)}`, {
            headers: { "Add-Padding": "true", "User-Agent": "DocSlurp password check" },
            signal,
          });
        } catch (error) {
          throw new BreachLookupError(isAbort(error) ? "timeout" : "network");
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new BreachLookupError("upstream_status", response.status);
        }
        let body: string;
        try { body = await response.text(); } catch (error) { throw new BreachLookupError(isAbort(error) ? "timeout" : "network"); }
        return compromiseCount(body, digest.slice(5)) > 0;
      } finally {
        inFlight -= 1;
      }
    },
  };
}

/** The DocSlurp breach check; empty when the policy is off. */
export function breachedPasswordPlugins(policy: BreachedPasswordPolicy, lookup: BreachLookup = createBreachLookup(policy)): BetterAuthPlugin[] {
  if (!policy.enabled) return [];
  // The hook relies on init-context chaining and the endpoint-context path.
  assertReviewedBetterAuth("breached-password hash hook", getBetterAuthVersion());
  return [{
    id: "docslurp-breached-password",
    init(ctx) {
      const hash = ctx.password.hash;
      return {
        context: {
          password: {
            ...ctx.password,
            async hash(password: string): Promise<string> {
              const path = tryGetCurrentAuthEndpointContext()?.path;
              // Every native caller hashes inside an endpoint (better-auth-compat.test.ts
              // keeps that list); outside one, nothing says whether this is a new password.
              if (!path) throw new Error("[auth-breach-check] password hashed outside a Better Auth endpoint while the breach check is on; use hashPassword from better-auth/crypto for seed data");
              if (!BREACHED_PASSWORD_PATHS.includes(path)) return hash(password);
              const started = Date.now();
              let compromised: boolean;
              try {
                compromised = await lookup.isCompromised(password);
              } catch (error) {
                const failure = error instanceof BreachLookupError ? error : new BreachLookupError("network");
                const durationMs = Date.now() - started;
                const status = failure.upstreamStatus ? ` status=${failure.upstreamStatus}` : "";
                console.error(`[auth-breach-check] refused a new password reason=${failure.reason}${status} duration_ms=${durationMs} path=${path}. Set AUTH_BREACHED_PASSWORD_CHECK=off only on hosts without internet access.`);
                reportPublicError(failure, { surface: "auth-breach-check", dependency: "hibp", reason: failure.reason, path, durationMs,
                  ...(failure.upstreamStatus ? { upstreamStatus: failure.upstreamStatus } : {}) });
                throw new APIError("SERVICE_UNAVAILABLE", {
                  code: PASSWORD_CHECK_UNAVAILABLE_CODE,
                  message: "We couldn't check that password against known breaches. Try again in a minute.",
                }, { "Retry-After": "60" });
              }
              if (compromised) {
                throw new APIError("BAD_REQUEST", {
                  code: PASSWORD_COMPROMISED_CODE,
                  message: "This password appears in a known data breach. Choose a different password.",
                });
              }
              return hash(password);
            },
          },
        },
      };
    },
  } as BetterAuthPlugin];
}

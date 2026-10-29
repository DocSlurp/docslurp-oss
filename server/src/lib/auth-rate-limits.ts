import { createHash, createHmac } from "node:crypto";

import { defineRequestState, hasRequestState } from "@better-auth/core/context";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { Pool } from "pg";

/**
 * DocSlurp's own authentication budgets, shared by every app machine through
 * the `auth_rate_limits` table (migration 0098).
 *
 * Better Auth's limiter keys only on client IP and path, and server-side
 * `auth.api` calls bypass it. These budgets cover what it can't: per-recipient
 * email delivery, the magic-link confirmation wrapper and company SSO. Every
 * check is one atomic statement, and database errors propagate so callers
 * fail closed.
 */

type Queryable = Pick<Pool, "query">;

export interface AuthBudget {
  windowSeconds: number;
  max: number;
}

export interface AuthBudgetResult {
  allowed: boolean;
  /** Seconds until the current window ends; meaningful when `allowed` is false. */
  retryAfterSeconds: number;
}

export interface AuthBudgetStore {
  consume(key: string, budget: AuthBudget): Promise<AuthBudgetResult>;
  /** Gives back one unit in the current window, e.g. when the counted email never left. */
  release(key: string): Promise<void>;
}

const PRUNE_EVERY = 200;
let consumedSincePrune = 0;

/**
 * One fixed-window step. A count stops at `max + 1`, so a flood can't push a
 * counter arbitrarily high, and the window restarts once it has elapsed.
 */
export async function consumeAuthBudget(pool: Queryable, key: string, budget: AuthBudget, now = Date.now()): Promise<AuthBudgetResult> {
  const { rows } = await pool.query<{ count: number; retry_after: number }>(
    `insert into auth_rate_limits (key, count, window_started_at, expires_at)
       values ($1, 1, to_timestamp($2::double precision / 1000), to_timestamp(($2::double precision + $3) / 1000))
     on conflict (key) do update set
       count = case when auth_rate_limits.expires_at <= excluded.window_started_at then 1
                    else least(auth_rate_limits.count + 1, $4 + 1) end,
       window_started_at = case when auth_rate_limits.expires_at <= excluded.window_started_at
                                then excluded.window_started_at else auth_rate_limits.window_started_at end,
       expires_at = case when auth_rate_limits.expires_at <= excluded.window_started_at
                         then excluded.expires_at else auth_rate_limits.expires_at end
     returning count, greatest(1, ceil(extract(epoch from expires_at) - $2::double precision / 1000))::int as retry_after`,
    [key, now, budget.windowSeconds * 1000, budget.max],
  );
  const row = rows[0];
  if (!row) throw new Error("auth rate limit returned no row");
  consumedSincePrune += 1;
  if (consumedSincePrune >= PRUNE_EVERY) {
    consumedSincePrune = 0;
    void pool.query(`delete from auth_rate_limits where expires_at < to_timestamp($1::double precision / 1000)`, [now])
      .catch(error => console.warn("[auth-rate-limit] prune failed", error instanceof Error ? error.message : error));
  }
  return { allowed: row.count <= budget.max, retryAfterSeconds: row.retry_after };
}

export async function releaseAuthBudget(pool: Queryable, key: string, now = Date.now()): Promise<void> {
  await pool.query(
    `update auth_rate_limits set count = greatest(count - 1, 0)
     where key = $1 and expires_at > to_timestamp($2::double precision / 1000)`,
    [key, now],
  );
}

export function databaseAuthBudgetStore(pool: Queryable): AuthBudgetStore {
  return { consume: (key, budget) => consumeAuthBudget(pool, key, budget), release: (key) => releaseAuthBudget(pool, key) };
}

/** Low-cardinality refusal telemetry: purpose and window only, never the key or who it stands for. */
export function logAuthBudgetDenied(purpose: string, budget: AuthBudget, result: AuthBudgetResult): void {
  console.warn(`[auth-rate-limit] denied purpose=${purpose} window_s=${budget.windowSeconds} max=${budget.max} retry_after_s=${result.retryAfterSeconds}`);
}

/** Same semantics, one process. For tests and single-process tools only; never shared across machines. */
export function createMemoryAuthBudgetStore(now: () => number = Date.now): AuthBudgetStore {
  const windows = new Map<string, { count: number; expiresAt: number }>();
  return {
    async consume(key, budget) {
      const at = now();
      const current = windows.get(key);
      const entry = current && current.expiresAt > at
        ? { count: Math.min(current.count + 1, budget.max + 1), expiresAt: current.expiresAt }
        : { count: 1, expiresAt: at + budget.windowSeconds * 1000 };
      windows.set(key, entry);
      return { allowed: entry.count <= budget.max, retryAfterSeconds: Math.max(1, Math.ceil((entry.expiresAt - at) / 1000)) };
    },
    async release(key) {
      const current = windows.get(key);
      if (current && current.expiresAt > now()) current.count = Math.max(0, current.count - 1);
    },
  };
}

/** A stable, non-reversible key part; raw addresses and IPs never reach the table. */
export function hashedBudgetKey(purpose: string, value: string): string {
  return `${purpose}:${createHash("sha256").update(value).digest("hex")}`;
}

/** Keyed with the auth secret, so a leaked table can't be matched against a list of addresses. */
export function recipientBudgetKey(secret: string, email: string, windowSeconds: number, purpose = "email-recipient"): string {
  const digest = createHmac("sha256", secret).update(email.trim().toLowerCase()).digest("hex");
  return `${purpose}:${windowSeconds}:${digest}`;
}

// ---------------------------------------------------------------------------
// Per-recipient email delivery

/**
 * Endpoints that email whatever address the request names. Each counts
 * against that address whether or not it has an account, so the answer (and a
 * 429) never reveals which addresses are registered. Password sign-in is
 * excluded: limiting it per address would let anyone lock a user out.
 */
export const EMAIL_SENDING_PATHS: ReadonlySet<string> = new Set([
  "/email-otp/send-verification-otp",
  "/email-otp/request-password-reset",
  "/sign-in/magic-link",
  "/send-verification-email",
  "/sign-up/email",
]);

/**
 * Caps mail to one address at 20 an hour. The window is deliberately short:
 * anyone can spend an address's budget (that is what makes a 429 reveal
 * nothing), so the cost of a targeted lockout must stay small. Email codes and
 * links pause for at most 15 minutes after the last request; password,
 * passkey, Google/GitHub and company sign-in are never affected.
 */
export const EMAIL_RECIPIENT_BUDGETS: readonly AuthBudget[] = [
  { windowSeconds: 15 * 60, max: 5 },
];

export const EMAIL_RATE_LIMITED_CODE = "EMAIL_RATE_LIMITED";

/**
 * Endpoints that check an emailed code. Better Auth counts wrong guesses on
 * each code, but parallel guesses can race that count. This budget is one
 * atomic counter per address across all of them, so the number of guesses
 * stays bounded however they are sent.
 */
export const EMAIL_CODE_CHECK_PATHS: ReadonlySet<string> = new Set([
  "/email-otp/reset-password",
  "/email-otp/check-verification-otp",
  "/email-otp/verify-email",
  "/sign-in/email-otp",
]);
export const EMAIL_CODE_CHECK_BUDGET: AuthBudget = { windowSeconds: 15 * 60, max: 10 };
export const EMAIL_CODE_ATTEMPTS_LIMITED_CODE = "CODE_ATTEMPTS_LIMITED";

/** On in production; elsewhere only when `AUTH_EMAIL_RECIPIENT_LIMITS=on` (tests, staging drills). */
export function emailRecipientLimitsEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "production" || env.AUTH_EMAIL_RECIPIENT_LIMITS?.trim().toLowerCase() === "on";
}

export interface EmailRecipientLimiter {
  plugin: BetterAuthPlugin;
  /**
   * Wraps an email sender. Mail from an endpoint the hook didn't count (an
   * unverified account's password sign-in re-sends its verification code)
   * is counted here and skipped when over budget, without failing the request.
   * If delivery fails, the address gets its budget back, so a provider outage
   * can't lock anyone out of the codes they retry.
   */
  guardDelivery<T extends { email: string }>(send: (data: T) => Promise<void>): (data: T, ctx?: { context?: { secret?: string } }) => Promise<void>;
}

export function emailRecipientLimiter(options: { store: AuthBudgetStore; enabled: boolean }): EmailRecipientLimiter {
  const { store, enabled } = options;
  // Set by the hook once this request's mail is counted. Request state, not the
  // endpoint path: native code can send from a nested endpoint call.
  const counted = defineRequestState(() => ({ value: false }));
  const plugin = {
    id: "docslurp-email-recipient-limits",
    hooks: {
      before: [{
        matcher: (ctx: { path?: string }) => enabled && EMAIL_CODE_CHECK_PATHS.has(ctx.path ?? ""),
        handler: createAuthMiddleware(async (ctx) => {
          const email = typeof ctx.body?.email === "string" ? ctx.body.email : "";
          if (!email.trim()) return;
          const budget = EMAIL_CODE_CHECK_BUDGET;
          const result = await store.consume(recipientBudgetKey(ctx.context.secret, email, budget.windowSeconds, "email-code-check"), budget);
          if (!result.allowed) {
            logAuthBudgetDenied("email-code-check", budget, result);
            throw new APIError("TOO_MANY_REQUESTS", {
              code: EMAIL_CODE_ATTEMPTS_LIMITED_CODE,
              message: "Too many code attempts for this address. Try again later.",
            }, { "Retry-After": String(result.retryAfterSeconds) });
          }
        }),
      }, {
        matcher: (ctx: { path?: string }) => enabled && EMAIL_SENDING_PATHS.has(ctx.path ?? ""),
        handler: createAuthMiddleware(async (ctx) => {
          const email = typeof ctx.body?.email === "string" ? ctx.body.email : "";
          // No address: the endpoint's own validation answers.
          if (!email.trim()) return;
          for (const budget of EMAIL_RECIPIENT_BUDGETS) {
            const result = await store.consume(recipientBudgetKey(ctx.context.secret, email, budget.windowSeconds), budget);
            if (!result.allowed) {
              logAuthBudgetDenied("email-recipient", budget, result);
              throw new APIError("TOO_MANY_REQUESTS", {
                code: EMAIL_RATE_LIMITED_CODE,
                message: "Too many emails were requested for this address. Try again later.",
              }, { "Retry-After": String(result.retryAfterSeconds) });
            }
          }
          (await counted.get()).value = true;
        }),
      }],
    },
  } as BetterAuthPlugin;
  return {
    plugin,
    guardDelivery: (send) => async (data, ctx) => {
      const secret = ctx?.context?.secret;
      const alreadyCounted = await hasRequestState() && (await counted.get()).value;
      if (enabled && secret && !alreadyCounted) {
        for (const budget of EMAIL_RECIPIENT_BUDGETS) {
          const result = await store.consume(recipientBudgetKey(secret, data.email, budget.windowSeconds), budget);
          if (!result.allowed) {
            logAuthBudgetDenied("email-recipient-indirect", budget, result);
            return;
          }
        }
      }
      try {
        await send(data);
      } catch (error) {
        if (enabled && secret) {
          for (const budget of EMAIL_RECIPIENT_BUDGETS) {
            await store.release(recipientBudgetKey(secret, data.email, budget.windowSeconds))
              .catch(releaseError => console.warn("[auth-rate-limit] release failed", releaseError instanceof Error ? releaseError.message : releaseError));
          }
        }
        throw error;
      }
    },
  };
}

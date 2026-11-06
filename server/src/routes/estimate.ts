import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { zValidator } from "@hono/zod-validator";
import { ESTIMATE_MAX_FILES_ANONYMOUS, estimateRequestSchema, QuoteSettingsError, quoteEstimate } from "@docslurp/shared";

import { apiErrorResponse, nativeBodyLimit } from "../lib/api-error.js";
import { requestIp } from "../lib/request-context.js";
import { rateLimitAddress } from "../lib/rate-limit-keys.js";
import { authenticatedByRoute } from "../lib/route-auth.js";
import { consumeFeatureRateLimit } from "../middleware/rate-limit.js";

/*
 * `POST /v1/estimate`: the public quote. Anyone (no account) sends file profiles from the offline profiler
 * (`@docslurp/estimate`) and settings, and gets the pricing provider's estimate: ingest credits, monthly hosting and
 * usage, neutral lines and ranges. Files never reach the server, only their profiles.
 *
 * - No tenant data: the route reads no database row and stores nothing; it prices with new-project defaults.
 *   Authenticated callers quote against a project with `POST /v1/uploads/estimate` (same quote function).
 * - Bounded: a 1 MiB body, at most ESTIMATE_MAX_FILES_ANONYMOUS files, strict schemas (unknown fields refused), profiles
 *   clamped against each file's size.
 * - Rate limited per client IP (ESTIMATE_RATE_LIMIT_PER_MINUTE, default 120 quotes a minute) and per quote session
 *   (ESTIMATE_SESSION_RATE_LIMIT_PER_MINUTE, default 60): an opaque random cookie issued on the first quote, holding no
 *   identity and stored nowhere but the limiter's counter. Dropping the cookie only falls back to the IP limit, on top of
 *   the API's unauthenticated IP limits.
 * - An estimate is never a charge.
 */

const ESTIMATE_MAX_BODY_BYTES = 1024 * 1024;
const WINDOW_MS = 60_000;

const SESSION_COOKIE = "ds_estimate_session";
const SESSION_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * Whether the quote-session cookie is marked Secure: always in production and whenever the configured public URL is https.
 * Never from the request: behind TLS termination the request URL reads http, and a forwarded-proto header is the client's to
 * forge where no trusted proxy rewrites it.
 */
export function estimateCookieSecure(env: Record<string, string | undefined> = process.env): boolean {
  if (env.NODE_ENV === "production") return true;
  return [env.APP_URL, env.API_URL].some((url) => url?.trim().toLowerCase().startsWith("https://"));
}

function perMinuteLimit(name: string, fallback: number, env: Record<string, string | undefined> = process.env): number {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export const estimateRoutes = new Hono().post(
  "/",
  // No quote, refusal or rate-limit answer is ever cached: set before anything else answers (the body limit's 413, the
  // schema's 400, the limiter's 429) and again on whatever response the chain produced.
  async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
    c.res.headers.set("Cache-Control", "no-store");
  },
  nativeBodyLimit(ESTIMATE_MAX_BODY_BYTES),
  zValidator("json", estimateRequestSchema),
  async (c) => {
    const ip = requestIp(c);
    // A quote session: the browser's cookie when it is one we could have issued, else a new one.
    let session = getCookie(c, SESSION_COOKIE);
    if (!session || !SESSION_PATTERN.test(session)) {
      session = randomBytes(16).toString("base64url");
      setCookie(c, SESSION_COOKIE, session, { httpOnly: true, sameSite: "Lax", secure: estimateCookieSecure(), path: "/", maxAge: 24 * 3600 });
    }
    let retryAfter = await consumeFeatureRateLimit({
      feature: "public-estimate",
      subject: `ip:${ip ? rateLimitAddress(ip) : "unknown"}`,
      limit: perMinuteLimit("ESTIMATE_RATE_LIMIT_PER_MINUTE", 120),
      windowMs: WINDOW_MS,
    });
    retryAfter ??= await consumeFeatureRateLimit({
      feature: "public-estimate-session",
      subject: `session:${session}`,
      limit: perMinuteLimit("ESTIMATE_SESSION_RATE_LIMIT_PER_MINUTE", 60),
      windowMs: WINDOW_MS,
    });
    if (retryAfter !== null) {
      c.header("Retry-After", String(retryAfter));
      return apiErrorResponse(c, 429, "rate_limited", "Too many estimates; try again shortly");
    }
    const body = c.req.valid("json");
    if (body.project) {
      return apiErrorResponse(c, 400, "invalid_request", "Quote a project with POST /v1/uploads/estimate (signed in or with an API key)");
    }
    if (body.files.length > ESTIMATE_MAX_FILES_ANONYMOUS) {
      return apiErrorResponse(c, 413, "payload_too_large", `Send at most ${ESTIMATE_MAX_FILES_ANONYMOUS} files per estimate`);
    }
    try {
      return c.json(quoteEstimate(body));
    } catch (error) {
      if (error instanceof QuoteSettingsError) return apiErrorResponse(c, 400, "invalid_request", error.message);
      throw error;
    }
  },
);

// Public: no session or key; the route bounds itself (above).
authenticatedByRoute(estimateRoutes, ["POST /"]);

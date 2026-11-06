import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { ESTIMATE_MAX_FILES_ANONYMOUS, estimateRequestSchema, quoteEstimate } from "@docslurp/shared";

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
 * - No tenant data: the route reads no database row and stores nothing; it prices with new-workspace defaults.
 *   Authenticated callers quote against a workspace with `POST /v1/uploads/estimate` (same quote function).
 * - Bounded: a 1 MiB body, at most ESTIMATE_MAX_FILES_ANONYMOUS files, strict schemas (unknown fields refused), profiles
 *   clamped against each file's size.
 * - Rate limited per client IP (ESTIMATE_RATE_LIMIT_PER_MINUTE, default 120 quotes a minute) on top of the API's
 *   unauthenticated IP limits.
 * - An estimate is never a charge.
 */

const ESTIMATE_MAX_BODY_BYTES = 1024 * 1024;
const WINDOW_MS = 60_000;

function perMinuteLimit(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number.parseInt(env.ESTIMATE_RATE_LIMIT_PER_MINUTE ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 120;
}

export const estimateRoutes = new Hono().post(
  "/",
  nativeBodyLimit(ESTIMATE_MAX_BODY_BYTES),
  zValidator("json", estimateRequestSchema),
  async (c) => {
    const ip = requestIp(c);
    const retryAfter = await consumeFeatureRateLimit({
      feature: "public-estimate",
      subject: `ip:${ip ? rateLimitAddress(ip) : "unknown"}`,
      limit: perMinuteLimit(),
      windowMs: WINDOW_MS,
    });
    if (retryAfter !== null) {
      c.header("Retry-After", String(retryAfter));
      return apiErrorResponse(c, 429, "rate_limited", "Too many estimates; try again shortly");
    }
    const body = c.req.valid("json");
    if (body.workspace) {
      return apiErrorResponse(c, 400, "invalid_request", "Quote a workspace with POST /v1/uploads/estimate (signed in or with an API key)");
    }
    if (body.files.length > ESTIMATE_MAX_FILES_ANONYMOUS) {
      return apiErrorResponse(c, 413, "payload_too_large", `Send at most ${ESTIMATE_MAX_FILES_ANONYMOUS} files per estimate`);
    }
    c.header("Cache-Control", "no-store");
    return c.json(quoteEstimate(body));
  },
);

// Public: no session or key; the route bounds itself (above).
authenticatedByRoute(estimateRoutes, ["POST /"]);

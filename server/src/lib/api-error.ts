import type { Context, MiddlewareHandler } from "hono";
import { boundedBodyLimit } from "./bounded-body-limit.js";
import { HTTPException } from "hono/http-exception";
import { apiError, apiErrorCodeForStatus, isApiErrorCode, publicApiErrorLinks, publicApiErrorMessage, type ApiErrorCode, type ApiErrorDetails } from "@docslurp/shared";
import { upgradeLinkHeader, withUpgradeLinks } from "./upgrade-links.js";

type ErrorStatus = 400 | 401 | 402 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 502 | 503 | 504;

/** Native error envelope response; `publicErrorMiddleware` stamps `requestId` and sanitizes copy. */
export function apiErrorResponse(c: Context, status: ErrorStatus, code: ApiErrorCode, message: string, details?: ApiErrorDetails): Response {
  const linked = linkedDetails(c, code, details);
  return c.json(apiError(code, message, linked), status);
}

/**
 * Credit, budget, plan and rate-limit errors carry `details.links` (where to
 * buy credits, turn on auto top-up or raise a key's limit) and the matching `Link` header.
 */
function linkedDetails(c: Context, code: ApiErrorCode, details?: ApiErrorDetails): ApiErrorDetails | undefined {
  const linked = withUpgradeLinks(code, details);
  const header = upgradeLinkHeader(publicApiErrorLinks(linked?.links));
  if (header) c.header("Link", header);
  return linked;
}

/**
 * Native error whose code is derived from the status, or taken from a domain
 * error's own `code` when it is in the closed vocabulary. Prefer
 * `apiErrorResponse` when the code is known statically.
 */
export function apiStatusError(c: Context, status: number, message: string, options: { code?: unknown; details?: ApiErrorDetails } = {}): Response {
  const code = isApiErrorCode(options.code) ? options.code : apiErrorCodeForStatus(status);
  return apiErrorResponse(c, status as ErrorStatus, code, message, options.details);
}

/** Request body cap that answers 413 in the native envelope (with the cap as `details.maxBytes`). */
export function nativeBodyLimit(maxSize: number): MiddlewareHandler {
  return boundedBodyLimit(maxSize, (c) => middlewareErrorResponse(c, 413, "payload_too_large", `Request body exceeds ${maxSize} bytes`, { maxBytes: maxSize }));
}

/**
 * The native API: `/v1/*` plus the first-party `/dashboard/*` and `/meta`
 * surfaces. Surfaces that speak another protocol keep their own error shapes:
 * the OpenAI-compatible chat API, MCP, OAuth, the search compat adapters and the
 * Stripe webhook. Health, docs and metrics endpoints are not JSON APIs.
 */
export function usesNativeErrorEnvelope(path: string): boolean {
  if (/^\/v1\/(?:mcp(?:\/|$)|chat\/completions\/?$|models\/?$)/.test(path)) return false;
  return /^\/(?:v1|dashboard|meta)(?:\/|$)/.test(path);
}

/**
 * Error answered by middleware that guards native and protocol surfaces alike
 * (rate limits, authentication, CORS, request validation): the native envelope
 * on the native API and `{ error, code }` on protocol surfaces, whose clients
 * parse that shape. Headers set earlier on the context are kept.
 */
export function middlewareErrorResponse(c: Context, status: ErrorStatus, code: ApiErrorCode, message: string, details?: ApiErrorDetails): Response {
  if (usesNativeErrorEnvelope(c.req.path)) return apiErrorResponse(c, status, code, message, details);
  return c.json({ error: message, code, ...linkedDetails(c, code, details) }, status);
}

const thrownErrorDetails = new WeakMap<object, ApiErrorDetails>();

/**
 * Attach server-authored details to an error before rethrowing it, so the
 * envelope built for it (envelopeForError) carries them. The public boundary
 * still forwards only the allowlisted keys (publicApiErrorDetails).
 */
export function withApiErrorDetails<T>(error: T, details: ApiErrorDetails): T {
  if (error && typeof error === "object") {
    thrownErrorDetails.set(error, { ...thrownErrorDetails.get(error), ...details });
  }
  return error;
}

const DROPPED_HEADERS = new Set(["content-type", "content-length", "content-encoding", "transfer-encoding"]);

/**
 * The one place a thrown error becomes an envelope response. Copy comes from the
 * closed code vocabulary, never the error text; headers of the original error
 * response (`Retry-After`, `WWW-Authenticate`, CORS, ...) and of an
 * `HTTPException`'s own response are carried over.
 */
export function envelopeForError(c: Context, error: unknown, status: number, originalHeaders?: Headers): Response {
  const { code: named } = error as { code?: unknown };
  const code = isApiErrorCode(named) ? named : apiErrorCodeForStatus(status);
  const spendDetails = (error as { spendDetails?: unknown } | null)?.spendDetails;
  const thrown = { ...(spendDetails && typeof spendDetails === "object" ? spendDetails : {}),
    ...(error && typeof error === "object" ? thrownErrorDetails.get(error) : undefined) };
  // A blocked spend knows whether the org's auto top-up is on (no "turn on auto top-up" link then).
  const autoTopUpOn = (error as { autoTopUpOn?: unknown } | null)?.autoTopUpOn === true;
  const details = withUpgradeLinks(code, autoTopUpOn ? { ...thrown, autoTopUpOn } : thrown);
  const response = apiErrorResponse(c, status as ErrorStatus, code, publicApiErrorMessage(code, details), details);
  for (const source of [error instanceof HTTPException ? error.res?.headers : undefined, originalHeaders]) {
    source?.forEach((value, name) => {
      if (!DROPPED_HEADERS.has(name.toLowerCase())) response.headers.set(name, value);
    });
  }
  return response;
}

/**
 * Turns errors thrown inside a native router (blocked spend, workspace access,
 * unexpected failures) into the same envelope the router's handlers return.
 * Hono hands thrown errors to the app's `onError` (which reports them), so
 * this reads `c.error` after the handlers ran and only reshapes the body.
 */
export const nativeApiErrors: MiddlewareHandler = async (c, next) => {
  await next();
  const error = c.error;
  if (!error) return;
  const { statusCode } = error as { statusCode?: unknown };
  const status = error instanceof HTTPException ? error.status : typeof statusCode === "number" ? statusCode : 500;
  c.res = envelopeForError(c, error, status, c.res.headers);
};

/** App-level `onError` for the native API: the envelope for thrown errors, blocked spend included. */
export function nativeErrorHandler(fallback: (error: Error, c: Context) => Response | Promise<Response>) {
  return async (error: Error, c: Context): Promise<Response> => {
    const response = await fallback(error, c);
    return usesNativeErrorEnvelope(c.req.path) ? envelopeForError(c, error, response.status, response.headers) : response;
  };
}

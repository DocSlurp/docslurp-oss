import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { apiError, apiErrorCodeForStatus, API_ERROR_PUBLIC_MESSAGES, isApiErrorCode, type ApiErrorCode, type ApiErrorDetails } from "@docslurp/shared";

type ErrorStatus = 400 | 401 | 402 | 403 | 404 | 409 | 413 | 429 | 500 | 503;

/** Native error envelope response; `publicErrorMiddleware` stamps `requestId` and sanitizes copy. */
export function apiErrorResponse(c: Context, status: ErrorStatus, code: ApiErrorCode, message: string, details?: ApiErrorDetails): Response {
  return c.json(apiError(code, message, details), status);
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
  const { statusCode, code: named } = error as { statusCode?: unknown; code?: unknown };
  const status = error instanceof HTTPException ? error.status : typeof statusCode === "number" ? statusCode : 500;
  const code = isApiErrorCode(named) ? named : apiErrorCodeForStatus(status);
  c.res = apiErrorResponse(c, status as ErrorStatus, code, API_ERROR_PUBLIC_MESSAGES[code]);
};

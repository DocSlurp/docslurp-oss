import type { MiddlewareHandler } from "hono";
import { PUBLIC_ERROR_MESSAGES } from "@docslurp/shared";
import { safeErrorResponse as sharedSafeErrorResponse } from "@docslurp/shared/error-response";
import { reportException } from "@docslurp/shared/error-reporting";
import { usesNativeErrorEnvelope } from "./api-error.js";
import { errorContext } from "./error-context.js";

export { exceptionDetails } from "@docslurp/shared/error-reporting";

export function reportPublicError(error: unknown, context: Record<string, string | number | boolean> = {}, signal?: AbortSignal): string {
  reportException(error, { ...errorContext.getStore(), ...context }, signal);
  return PUBLIC_ERROR_MESSAGES.unexpected;
}

/** Last line of defence for handled errors, including third-party auth responses. */
export function safeErrorResponse(response: Response, requestId?: string, native = false): Promise<Response> {
  return sharedSafeErrorResponse(response, requestId, reportPublicError, native);
}

export const publicErrorMiddleware: MiddlewareHandler = async (c, next) => {
  await next();
  c.res = await safeErrorResponse(c.res, c.get("requestId"));
};

/**
 * The server's outermost boundary: protocol surfaces keep their shapes, every
 * other error leaves as the native envelope (see `usesNativeErrorEnvelope`).
 */
export const apiPublicErrorMiddleware: MiddlewareHandler = async (c, next) => {
  await next();
  c.res = await safeErrorResponse(c.res, c.get("requestId"), usesNativeErrorEnvelope(c.req.path));
};

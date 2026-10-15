import type { MiddlewareHandler } from "hono";
import { PUBLIC_ERROR_MESSAGES } from "@docslurp/shared";
import { safeErrorResponse as sharedSafeErrorResponse } from "@docslurp/shared/error-response";
import { reportException } from "@docslurp/shared/error-reporting";
import { errorContext } from "./error-context.js";

export { exceptionDetails } from "@docslurp/shared/error-reporting";

export function reportPublicError(error: unknown, context: Record<string, string | number | boolean> = {}): string {
  reportException(error, { ...errorContext.getStore(), ...context });
  return PUBLIC_ERROR_MESSAGES.unexpected;
}

/** Last line of defence for handled errors, including third-party auth responses. */
export function safeErrorResponse(response: Response, requestId?: string): Promise<Response> {
  return sharedSafeErrorResponse(response, requestId, reportPublicError);
}

export const publicErrorMiddleware: MiddlewareHandler = async (c, next) => {
  await next();
  c.res = await safeErrorResponse(c.res, c.get("requestId"));
};

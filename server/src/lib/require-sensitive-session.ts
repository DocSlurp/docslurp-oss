import type { MiddlewareHandler } from "hono";

import { appDbPool } from "./auth.js";
import { hasSensitiveAccess } from "./auth-sensitive-access.js";
import { apiStatusError } from "./api-error.js";
import { getRequestActor } from "./request-actor.js";

/** Checked against the live same-user session, never a cookie or client timestamp. */
export const requireSensitiveSession: MiddlewareHandler = async (c, next) => {
  const actor = getRequestActor(c);
  if (actor.type !== "session") {
    return apiStatusError(c, 403, "This change requires a signed-in session", { code: "session_required" });
  }
  if (!await hasSensitiveAccess(appDbPool, actor.userId, actor.sessionId)) {
    return apiStatusError(c, 403, "Verify your identity before changing sensitive account settings", { code: "REAUTH_REQUIRED" });
  }
  await next();
};

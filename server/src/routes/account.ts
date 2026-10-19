import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { auth } from "../lib/auth.js";
import { getRequestActor } from "../lib/request-actor.js";
import { deleteAccount, OffboardingError, planAccountDeletion } from "../services/tenant-offboarding.js";
import { apiStatusError } from "../lib/api-error.js";
import { validationHook } from "../lib/validation.js";

const deleteAccountSchema = z.object({ confirmation: z.string().min(1).max(500) }).strict();

/**
 * Account lifecycle for the signed-in user (session only; /v1/account is not
 * an API-key route). See docs/data-deletion.md.
 */
export const accountRoutes = new Hono()
  .onError((error, c) => {
    if (error instanceof OffboardingError) return apiStatusError(c, error.status, error.message, { code: error.code, details: error.details });
    throw error;
  })
  .use("*", async (c, next) => {
    if (getRequestActor(c).type !== "session") {
      return apiStatusError(c, 403, "Account management requires a signed-in session", { code: "session_required" });
    }
    await next();
  })
  /** What deleting the account would do: orgs deleted, orgs left, and blockers. */
  .get("/deletion", async (c) => c.json(await planAccountDeletion(getRequestActor(c).userId)))
  .delete("/", zValidator("json", deleteAccountSchema, validationHook), async (c) => {
    const userId = getRequestActor(c).userId;
    const result = await deleteAccount({ userId, confirmation: c.req.valid("json").confirmation });
    const response = c.json({ ok: true, ...result });
    // The sessions are already gone; clear this browser's cookies too.
    try {
      const signOut = await auth.api.signOut({ headers: c.req.raw.headers, asResponse: true });
      for (const cookie of signOut.headers.getSetCookie()) response.headers.append("Set-Cookie", cookie);
    } catch (error) {
      console.warn(`[offboarding] sign-out after account deletion failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return response;
  });

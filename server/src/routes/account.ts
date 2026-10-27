import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

import { getAuthenticatorName } from "@better-auth/passkey";

import { appDbPool, auth, mfaConfig } from "../lib/auth.js";
import { evaluateMfaPolicy } from "../lib/auth-mfa.js";
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
  /**
   * Sign-in methods and MFA state for the settings page: TOTP 2FA, passkeys
   * (with last use), this session's assurance and re-auth window, and any org
   * policy deadline. The only API route a session blocked by an org's MFA
   * policy may call. Changes go through Better Auth (/api/auth/two-factor/*,
   * /api/auth/passkey/*).
   */
  .get("/security", async (c) => {
    const actor = getRequestActor(c);
    if (actor.type !== "session") return apiStatusError(c, 403, "Account management requires a signed-in session", { code: "session_required" });
    const [{ rows: [account] }, { rows: passkeys }, { rows: [session] }] = await Promise.all([
      appDbPool.query<{ two_factor_enabled: boolean; has_password: boolean; pending_totp: boolean }>(
        `select u."twoFactorEnabled" as two_factor_enabled,
                exists (select 1 from account a where a."userId" = u.id and a."providerId" = 'credential' and a.password is not null) as has_password,
                exists (select 1 from "twoFactor" t where t."userId" = u.id and t.verified = false) as pending_totp
           from "user" u where u.id = $1`, [actor.userId]),
      appDbPool.query<{ id: string; name: string | null; aaguid: string | null; device_type: string; backed_up: boolean; created_at: Date | null; last_used_at: Date | null }>(
        `select id, name, aaguid, "deviceType" as device_type, "backedUp" as backed_up, "createdAt" as created_at, "lastUsedAt" as last_used_at
           from passkey where "userId" = $1 order by "createdAt" desc nulls last`, [actor.userId]),
      appDbPool.query<{ mfa_verified: boolean; authenticated_at: Date | null; created_at: Date }>(
        `select "mfaVerified" as mfa_verified, "authenticatedAt" as authenticated_at, "createdAt" as created_at from session where id = $1 and "userId" = $2`,
        [actor.sessionId, actor.userId]),
    ]);
    const mfaVerified = session?.mfa_verified === true;
    const authenticatedAt = session ? (session.authenticated_at ?? session.created_at) : null;
    const reauthUntil = authenticatedAt ? new Date(new Date(authenticatedAt).getTime() + mfaConfig.reauthMaxAgeSeconds * 1000) : null;
    return c.json({
      twoFactor: { enabled: account?.two_factor_enabled === true, pendingSetup: account?.pending_totp === true },
      hasPassword: account?.has_password === true,
      passkeys: passkeys.map((row) => ({
        id: row.id,
        name: row.name,
        authenticator: getAuthenticatorName(row.aaguid ?? undefined) ?? null,
        deviceType: row.device_type,
        backedUp: row.backed_up,
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
        lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
      })),
      session: {
        mfaVerified,
        authenticatedAt: authenticatedAt ? new Date(authenticatedAt).toISOString() : null,
        /** Removing a factor needs a sign-in no older than this. */
        reauthUntil: reauthUntil?.toISOString() ?? null,
      },
      policy: await evaluateMfaPolicy(appDbPool, actor.userId, mfaVerified),
      settings: { trustDeviceDays: Math.round(mfaConfig.trustDeviceMaxAgeSeconds / 86_400), reauthWindowSeconds: mfaConfig.reauthMaxAgeSeconds, rpID: mfaConfig.rpID },
    });
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

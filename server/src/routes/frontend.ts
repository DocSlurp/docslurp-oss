import { Hono } from "hono";

import { sql } from "../db.js";
import { configuredEmailAuth, configuredSocialProviders, getDevSeedAccountDescriptors } from "../lib/better-auth.js";
import { hasConfiguredSsoProvider } from "../lib/sso-lookup.js";
import { mcpOrigin } from "../lib/mcp-origin.js";
import { authenticatedByRoute } from "../lib/route-auth.js";
import { getRequestActor } from "../lib/request-actor.js";
import { notifySignup } from "../lib/signup-notifications.js";
import { getInvitePreview, listOrganizations } from "../services/organizations.js";
import { listWorkspaces } from "../services/workspaces.js";

/**
 * Endpoints the dashboard (a separate process in hosting mode b) reads over HTTP
 * instead of importing services. Each is authorised exactly like the in-process
 * call it replaced: a Better Auth session cookie, the invite token, or nothing
 * for public configuration. API keys are never accepted here (session-only default).
 */

/** GET /dashboard/bootstrap: the signed-in user's admin flag, organizations and accessible workspaces. */
export const dashboardRoutes = new Hono().get("/", async (c) => {
  const actor = getRequestActor(c);
  if (actor.type !== "session") return c.json({ error: "Forbidden" }, 403);
  c.header("Cache-Control", "private, no-store");
  const isAdmin = actor.user.isAdmin === true;
  const [organizations, workspaces] = await Promise.all([listOrganizations(actor.userId), listWorkspaces(actor.userId, { refineNames: false })]);
  return c.json({ isAdmin, organizations, workspaces });
});

/** GET /v1/invites/:token?kind=organization|workspace: what the accept page offers. The token is the credential. */
export const inviteRoutes = new Hono().get("/:token", async (c) => {
  const actor = getRequestActor(c);
  if (actor.type !== "session") return c.json({ error: "Forbidden" }, 403);
  const kind = c.req.query("kind") === "organization" ? "organization" : "workspace";
  const preview = await getInvitePreview(c.req.param("token"), kind);
  return preview ? c.json(preview) : c.json({ error: "Invite not found" }, 404);
});

/** GET /meta/mcp-origin: the canonical public MCP origin. Public configuration, no auth. */
export const metaRoutes = new Hono().get("/mcp-origin", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({ origin: mcpOrigin(c.req.url) });
});

/** GET /meta/auth-config: sign-in options. Public; dev quick-login accounts exist only when NODE_ENV=development. */
metaRoutes.get("/auth-config", async (c) => {
  c.header("Cache-Control", "no-store");
  return c.json({
    emailAuth: configuredEmailAuth,
    socialProviders: configuredSocialProviders,
    ssoConfigured: await hasConfiguredSsoProvider(),
    devSeedAccounts: getDevSeedAccountDescriptors(),
  });
});

/** POST /v1/waitlist: public signup capture. The dashboard validates and relays. */
export const waitlistRoutes = new Hono().post("/", async (c) => {
  let body: { email?: unknown; name?: unknown; use_case?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !email.includes("@") || email.length > 320) return c.json({ error: "Valid email is required" }, 400);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) || null : null;
  const useCase = typeof body.use_case === "string" ? body.use_case.trim().slice(0, 1000) || null : null;
  const inserted = await sql`
    INSERT INTO waitlist_signups (email, name, use_case)
    VALUES (${email}, ${name}, ${useCase})
    ON CONFLICT (email) DO NOTHING
    RETURNING id`;
  const alreadyRegistered = inserted.length === 0;
  if (!alreadyRegistered) {
    await notifySignup({ kind: "waitlist", email, name, useCase });
    const webhookUrl = process.env.SLACK_WAITLIST_WEBHOOK_URL;
    if (webhookUrl) {
      const lines = ["*New waitlist signup*", `• Email: ${email}`];
      if (name) lines.push(`• Name: ${name}`);
      if (useCase) lines.push(`• Use case: ${useCase}`);
      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: lines.join("\n") }),
      }).catch((error) => console.error("[waitlist] Slack webhook failed:", error));
    }
  }
  return c.json({ ok: true, already_registered: alreadyRegistered });
});
authenticatedByRoute(waitlistRoutes);

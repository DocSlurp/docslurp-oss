import { Hono } from "hono";

import { apiErrorResponse } from "../lib/api-error.js";
import { appDbPool } from "../lib/auth.js";
import { getRequestActor } from "../lib/request-actor.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { findDefaultProject } from "../services/projects.js";

/**
 * GET /v1/whoami: the identity behind the presented credential, for
 * `docslurp whoami` / `docslurp auth status`. A server API key or a
 * REST-audience OAuth token sees its own user, organization, default
 * project, scopes and (for OAuth) expiry. Client (browser) keys are refused:
 * they sit in page source and must not reveal the owner's account.
 * Never echoes the credential itself.
 */
export const whoamiRoutes = new Hono().get("/", async (c) => {
  const actor = getRequestActor(c);
  c.header("Cache-Control", "no-store");
  const userRow = (await appDbPool.query(`SELECT id, name, email FROM "user" WHERE id=$1`, [actor.userId])).rows[0] as { id: string; name: string | null; email: string | null } | undefined;
  const user = userRow ? { id: userRow.id, name: userRow.name, email: userRow.email } : { id: actor.userId, name: null, email: null };
  if (actor.type === "session") {
    return c.json({ user, organization: null, defaultProject: null, credential: { type: "session", scopes: [], expiresAt: null } });
  }
  const key = actor.apiKey;
  if (key.keyType !== "server") return apiErrorResponse(c, 403, "forbidden", "Client keys cannot read account identity");
  const orgRow = key.orgId
    ? (await appDbPool.query(`SELECT o.id, o.name, o.slug FROM organizations o JOIN org_memberships m ON m.org_id=o.id AND m.user_id=$2 WHERE o.id=$1`, [key.orgId, actor.userId])).rows[0] as { id: string; name: string; slug: string } | undefined
    : undefined;
  const project = key.orgId ? await findDefaultProject({ userId: actor.userId, orgId: key.orgId }) : null;
  const projectAllowed = project && (key.projectIds.length === 0 || key.projectIds.includes(project.id));
  return c.json({
    user,
    organization: orgRow ? { id: orgRow.id, name: orgRow.name, slug: orgRow.slug } : null,
    defaultProject: project && projectAllowed ? { id: project.id, name: project.name, slug: project.slug ?? null } : null,
    credential: key.oauth
      ? { type: "oauth", client: key.oauth.clientName, scopes: key.oauth.grantedScopes, apiKeyScopes: key.scopes, expiresAt: key.oauth.expiresAt }
      : { type: "apiKey", scopes: key.scopes, expiresAt: null },
  });
});
acceptApiKeys(whoamiRoutes);

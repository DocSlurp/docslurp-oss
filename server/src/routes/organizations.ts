import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createOrganizationInviteSchema, createOrganizationSchema, updateOrganizationMfaPolicySchema, updateOrganizationSchema, type OrganizationAccess } from "@docslurp/shared";
import { getRequestActor } from "../lib/request-actor.js";
import { inviteAcceptUrl } from "../services/notifications.js";
import { listOrganizationApiKeys, revokeOrganizationApiKeys } from "../services/api-keys.js";
import { acceptOrganizationInvite, createOrganization, getOrganization, getOrganizationAccess, getOrganizationDetails, inviteOrganizationMember,
  listOrganizationInvites, listOrganizationMembers, listOrganizations, removeOrganizationMember, revokeOrganizationInvite, updateOrganization,
  updateOrganizationMemberRole, OrganizationError, getOrganizationMfaPolicy, updateOrganizationMfaPolicy } from "../services/organizations.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { deleteOrganization, OffboardingError } from "../services/tenant-offboarding.js";
import { apiStatusError } from "../lib/api-error.js";
import { validationHook } from "../lib/validation.js";

const updateMemberSchema = z.object({ role: z.enum(["owner", "admin", "member", "billing"]) }).strict();
const deleteOrganizationSchema = z.object({ confirmation: z.string().min(1).max(500) }).strict();


function scopeAccess(access: OrganizationAccess, actor: ReturnType<typeof getRequestActor>): OrganizationAccess {
  if (actor.type !== "apiKey" || actor.apiKey.scopes.includes("organizations:manage")) return access;
  return { ...access, capabilities: { read: true, update: false, manageMembers: false, manageOwners: false, manageApiKeys: false, leave: false } };
}

export const organizationsRoutes = new Hono()
  .onError((error, c) => {
    if (error instanceof OrganizationError) return apiStatusError(c, error.status, error.message, { code: error.code });
    if (error instanceof OffboardingError) return apiStatusError(c, error.status, error.message, { code: error.code, details: error.details });
    throw error;
  })
  // Session only: the invitee accepts as themselves (declared session-only below).
  .post("/invites/:token/accept", async c => {
    const actor = getRequestActor(c);
    if (actor.type !== "session") return apiStatusError(c, 403, "Accept invites while signed in", { code: "session_required" });
    return c.json(await acceptOrganizationInvite(c.req.param("token"), actor.userId));
  })
  .use("*", async (c, next) => {
    const actor = getRequestActor(c);
    if (actor.type === "apiKey") {
      const key = actor.apiKey;
      if (key.keyType === "client") return apiStatusError(c, 403, "Organization management requires a server key", { code: "organization_forbidden" });
      const orgId = c.req.param("orgId")
        ?? c.req.path.replace(/\/$/, "").match(/\/organizations\/([^/]+)/)?.[1];
      if (c.req.method === "POST" && !orgId) return apiStatusError(c, 403, "Create organizations using session authentication", { code: "session_required" });
      if (orgId && orgId !== key.orgId) return apiStatusError(c, 404, "Organization not found", { code: "organization_not_found" });
      const scopes = c.req.method === "GET" ? ["organizations:read", "organizations:manage"] : ["organizations:manage"];
      if (!scopes.some(scope => key.scopes.includes(scope))) return apiStatusError(c, 403, "Organization API key scope required", { code: "organization_forbidden" });
    }
    await next();
  })
  .get("/", async c => {
    const actor = getRequestActor(c);
    if (actor.type === "apiKey") {
      const organization = actor.apiKey.orgId ? await getOrganization(actor.apiKey.orgId, actor.userId) : null;
      return c.json({ organizations: organization ? [organization] : [] });
    }
    return c.json({ organizations: await listOrganizations(actor.userId) });
  })
  .get("/:orgId", async c => {
    const organization = await getOrganization(c.req.param("orgId"), getRequestActor(c).userId);
    if (!organization) throw new OrganizationError(404, "organization_not_found", "Organization not found");
    return c.json(organization);
  })
  .get("/:orgId/details", async c => {
    const actor = getRequestActor(c);
    const details = await getOrganizationDetails(c.req.param("orgId"), actor.userId);
    return c.json({ ...details, access: scopeAccess(details.access, actor) });
  })
  .get("/:orgId/access", async c => {
    const actor = getRequestActor(c);
    return c.json(scopeAccess(await getOrganizationAccess(c.req.param("orgId"), actor.userId), actor));
  })
  // Permanent: owner only, from a signed-in session, confirmed by the org name (docs/data-deletion.md).
  .delete("/:orgId", zValidator("json", deleteOrganizationSchema, validationHook), async c => {
    const actor = getRequestActor(c);
    if (actor.type === "apiKey") {
      return apiStatusError(c, 403, "Deleting an organization requires a signed-in owner", { code: "session_required" });
    }
    const result = await deleteOrganization({ orgId: c.req.param("orgId"), userId: actor.userId, confirmation: c.req.valid("json").confirmation });
    return c.json({ ok: true, ...result });
  })
  .patch("/:orgId", zValidator("json", updateOrganizationSchema, validationHook), async c =>
    c.json(await updateOrganization(c.req.param("orgId"), getRequestActor(c).userId, c.req.valid("json"))))
  .get("/:orgId/security-policy", async c => c.json(await getOrganizationMfaPolicy(c.req.param("orgId"), getRequestActor(c).userId)))
  // Session only: changing who must use MFA needs an MFA-verified admin session, which an API key can't show.
  .put("/:orgId/security-policy", zValidator("json", updateOrganizationMfaPolicySchema, validationHook), async c => {
    const actor = getRequestActor(c);
    if (actor.type !== "session") return apiStatusError(c, 403, "Change the MFA policy while signed in", { code: "session_required" });
    return c.json(await updateOrganizationMfaPolicy(c.req.param("orgId"), actor.userId, c.req.valid("json"), { mfaVerified: actor.mfaVerified === true }));
  })
  .get("/:orgId/members", async c => c.json({ memberships: await listOrganizationMembers(c.req.param("orgId"), getRequestActor(c).userId) }))
  .get("/:orgId/api-keys", async c => c.json({ keys: await listOrganizationApiKeys(c.req.param("orgId"), getRequestActor(c).userId) }))
  .post("/", zValidator("json", createOrganizationSchema, validationHook), async c =>
    c.json(await createOrganization({ ...c.req.valid("json"), userId: getRequestActor(c).userId }), 201))
  .delete("/:orgId/api-keys", async c => {
    const keys = await revokeOrganizationApiKeys(c.req.param("orgId"), getRequestActor(c).userId);
    return c.json({ keys, revokedCount: keys.length });
  })
  // Membership starts with an email invite the invitee accepts (G-02); there is no add-by-user-ID.
  .get("/:orgId/invites", async c => c.json({ invites: await listOrganizationInvites(c.req.param("orgId"), getRequestActor(c).userId) }))
  .post("/:orgId/invites", zValidator("json", createOrganizationInviteSchema, validationHook), async c => {
    const { invite, token } = await inviteOrganizationMember(c.req.param("orgId"), getRequestActor(c).userId, c.req.valid("json"));
    // The token is returned once so an admin can share the link if email is not configured.
    return c.json({ invite, inviteUrl: inviteAcceptUrl(token, "organization") }, 201);
  })
  .delete("/:orgId/invites/:inviteId", async c =>
    c.json(await revokeOrganizationInvite(c.req.param("orgId"), getRequestActor(c).userId, c.req.param("inviteId"))))
  .patch("/:orgId/members/:memberUserId", zValidator("json", updateMemberSchema, validationHook), async c =>
    c.json(await updateOrganizationMemberRole({ orgId: c.req.param("orgId"), userId: getRequestActor(c).userId,
      memberUserId: c.req.param("memberUserId"), role: c.req.valid("json").role })))
  .delete("/:orgId/members/:memberUserId", async c => {
    await removeOrganizationMember({ orgId: c.req.param("orgId"), userId: getRequestActor(c).userId, memberUserId: c.req.param("memberUserId") });
    return c.json({ ok: true });
  })
  .post("/:orgId/leave", async c => {
    const userId = getRequestActor(c).userId;
    await removeOrganizationMember({ orgId: c.req.param("orgId"), userId, memberUserId: userId });
    return c.json({ ok: true });
  });

// The guard above checks the key's type, organizations:* scope and org.
// Creating an organization stays session-only.
acceptApiKeys(organizationsRoutes, [
  "GET /",
  "GET /:orgId",
  "GET /:orgId/details",
  "GET /:orgId/access",
  "PATCH /:orgId",
  "GET /:orgId/members",
  "GET /:orgId/api-keys",
  "DELETE /:orgId/api-keys",
  "GET /:orgId/invites",
  "POST /:orgId/invites",
  "DELETE /:orgId/invites/:inviteId",
  "PATCH /:orgId/members/:memberUserId",
  "DELETE /:orgId/members/:memberUserId",
  "POST /:orgId/leave",
]);

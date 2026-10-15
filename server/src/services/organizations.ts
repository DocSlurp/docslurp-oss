import { createHash, randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { updateOrganizationSchema, type InvitePreview, type OrganizationAccess, type OrganizationDetails, type OrganizationMember, type UpdateOrganizationInput } from "@docslurp/shared";

import {
  createOrganizationInviteSchema,
  createOrganizationSchema,
  createWorkspaceInviteSchema,
  organizationInviteSchema,
  organizationMembershipSchema,
  organizationSchema,
  workspaceInviteSchema,
  workspaceMemberSchema,
  updateWorkspaceMemberSchema,
  type CreateOrganizationInput,
  type CreateOrganizationInviteInput,
  type CreateWorkspaceInviteInput,
  type OrganizationInviteRecord,
  type OrganizationMembership,
  type OrganizationRecord,
  type WorkspaceInviteRecord,
  type WorkspaceMemberRecord
} from "@docslurp/shared";

import { sql } from "../db.js";
import { insertDefaultWorkspace } from "./default-workspace.js";
import { sendOrganizationInviteEmail, sendWorkspaceInviteEmail } from "./notifications.js";
import { currentRequestApiKeyWorkspaceIds } from "../lib/request-context.js";

/** Narrows workspace IDs to the current API key request's allowlist, if any. */
function withinRequestKeyAllowlist(workspaceIds: string[]): string[] {
  const allowlist = currentRequestApiKeyWorkspaceIds();
  return allowlist ? workspaceIds.filter((id) => allowlist.includes(id)) : workspaceIds;
}

type OrganizationRow = {
  id: string;
  name: string;
  slug: string | null;
  is_personal: boolean;
  personal_owner_user_id: string | null;
  created_by_user_id: string | null;
  credit_balance_cents: number;
  member_role: OrganizationRecord["memberRole"];
  created_at: string;
  updated_at: string;
};

type MembershipRow = {
  org_id: string;
  user_id: string;
  role: OrganizationMembership["role"];
  created_at: string;
};

type WorkspaceMemberRow = {
  workspace_id: string;
  user_id: string;
  email: string | null;
  name: string | null;
  role: WorkspaceMemberRecord["role"];
  invited_by_user_id: string | null;
  created_at: string;
};

type WorkspaceInviteRow = {
  id: string;
  workspace_id: string;
  org_id: string;
  email: string;
  role: WorkspaceInviteRecord["role"];
  token: string;
  status: WorkspaceInviteRecord["status"];
  invited_by_user_id: string;
  accepted_by_user_id: string | null;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
};

export interface WorkspaceAccess {
  workspaceId: string;
  orgId: string;
  workspaceOwnerUserId: string;
  /** Every org member may read and write the org's default workspace. */
  isDefaultWorkspace?: boolean;
  orgRole: OrganizationRecord["memberRole"] | null;
  workspaceRole: WorkspaceMemberRecord["role"] | null;
}

const elevatedWorkspaceOrgRoles = new Set<OrganizationRecord["memberRole"]>(["owner", "admin"]);

function mapOrganization(row: OrganizationRow): OrganizationRecord {
  return organizationSchema.parse({
    id: row.id,
    name: row.name,
    slug: row.slug,
    isPersonal: row.is_personal,
    personalOwnerUserId: row.personal_owner_user_id,
    createdByUserId: row.created_by_user_id,
    creditBalanceCents: row.credit_balance_cents,
    memberRole: row.member_role,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function mapMembership(row: MembershipRow): OrganizationMembership {
  return organizationMembershipSchema.parse({
    orgId: row.org_id,
    userId: row.user_id,
    role: row.role,
    createdAt: row.created_at
  });
}

function mapWorkspaceMember(row: WorkspaceMemberRow): WorkspaceMemberRecord {
  return workspaceMemberSchema.parse({
    workspaceId: row.workspace_id,
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    invitedByUserId: row.invited_by_user_id,
    createdAt: row.created_at
  });
}

function mapWorkspaceInvite(row: WorkspaceInviteRow): WorkspaceInviteRecord {
  return workspaceInviteSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    orgId: row.org_id,
    email: row.email,
    role: row.role,
    token: row.token,
    status: row.status,
    invitedByUserId: row.invited_by_user_id,
    acceptedByUserId: row.accepted_by_user_id,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at
  });
}

async function getUser(userId: string): Promise<{ id: string; email: string; name: string } | null> {
  const [row] = await sql<{ id: string; email: string; name: string }[]>`
    select id, email, name
    from "user"
    where id = ${userId} and deleted_at is null
    limit 1
  `;
  return row ?? null;
}

/** The user only when their email is verified: invites are bound to an email address. */
async function getVerifiedUser(userId: string): Promise<{ id: string; email: string; name: string } | null> {
  const [row] = await sql<{ id: string; email: string; name: string }[]>`
    select id, email, name from "user" where id = ${userId} and "emailVerified" = true limit 1
  `;
  return row ?? null;
}

function personalOrgName(name: string): string {
  return `${name.split(" ")[0] ?? "Personal"} Workspace`;
}

export async function ensurePersonalOrganization(userId: string): Promise<OrganizationRecord> {
  const [existing] = await sql<OrganizationRow[]>`
    select
      o.id,
      o.name,
      o.slug,
      o.is_personal,
      o.personal_owner_user_id,
      o.created_by_user_id,
      o.credit_balance_cents,
      om.role as member_role,
      o.created_at::text,
      o.updated_at::text
    from organizations o
    join org_memberships om on om.org_id = o.id and om.user_id = ${userId}
    where o.personal_owner_user_id = ${userId}
    limit 1
  `;

  if (existing) {
    return mapOrganization(existing);
  }

  const user = await getUser(userId);
  if (!user) {
    throw new Error("User not found");
  }

  const organizationId = randomUUID();
  await sql`
    insert into organizations (
      id,
      name,
      slug,
      is_personal,
      personal_owner_user_id,
      created_by_user_id,
      credit_balance_cents
    )
    values (
      ${organizationId},
      ${personalOrgName(user.name)},
      ${`${user.id}-personal`},
      true,
      ${user.id},
      ${user.id},
      0
    )
  `;

  await sql`
    insert into org_memberships (org_id, user_id, role)
    values (${organizationId}, ${user.id}, 'owner')
  `;
  // Every organization starts with a default workspace, so dashboard-only
  // users and requests that omit workspaceId have somewhere to land.
  await insertDefaultWorkspace(sql, { orgId: organizationId, userId: user.id });

  return await ensurePersonalOrganization(userId);
}

export async function listOrganizations(userId: string): Promise<OrganizationRecord[]> {
  const rows = await sql<OrganizationRow[]>`
    select
      o.id,
      o.name,
      o.slug,
      o.is_personal,
      o.personal_owner_user_id,
      o.created_by_user_id,
      o.credit_balance_cents,
      om.role as member_role,
      o.created_at::text,
      o.updated_at::text
    from organizations o
    join org_memberships om on om.org_id = o.id
    where om.user_id = ${userId}
    order by o.is_personal desc, o.created_at asc
  `;

  return rows.map(mapOrganization);
}

export async function getOrganization(orgId: string, userId: string): Promise<OrganizationRecord | null> {
  const [row] = await sql<OrganizationRow[]>`
    select
      o.id,
      o.name,
      o.slug,
      o.is_personal,
      o.personal_owner_user_id,
      o.created_by_user_id,
      o.credit_balance_cents,
      om.role as member_role,
      o.created_at::text,
      o.updated_at::text
    from organizations o
    join org_memberships om on om.org_id = o.id
    where o.id = ${orgId} and om.user_id = ${userId}
    limit 1
  `;

  return row ? mapOrganization(row) : null;
}

export class OrganizationError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409, readonly code: string, message: string) { super(message); }
}
type OrgTransaction = postgres.TransactionSql<Record<string, postgres.PostgresType>>;

export function organizationCapabilities(role: OrganizationMembership["role"], isPersonal = false, ownerCount = 2): OrganizationAccess["capabilities"] {
  const elevated = role === "owner" || role === "admin";
  return { read: true, update: elevated, manageMembers: elevated && !isPersonal, manageOwners: role === "owner" && !isPersonal, manageApiKeys: elevated, leave: !isPersonal && (role !== "owner" || ownerCount > 1) };
}

async function auditOrganization(tx: OrgTransaction, orgId: string, userId: string, action: string, metadata: Record<string, unknown> = {}) {
  await tx`insert into audit_log (id, org_id, user_id, action, resource_type, resource_id, metadata)
    values (${randomUUID()}, ${orgId}, ${userId}, ${action}, 'organization', ${orgId}, ${tx.json(metadata as postgres.JSONValue)})`;
}

export async function createOrganization(input: CreateOrganizationInput): Promise<OrganizationRecord> {
  const parsed = createOrganizationSchema.parse(input);
  try {
    const orgId = randomUUID();
    await sql.begin(async tx => {
      const [user] = await tx`select id from "user" where id = ${parsed.userId}`;
      if (!user) throw new OrganizationError(404, "user_not_found", "User not found");
      await tx`insert into organizations (id, name, slug, is_personal, created_by_user_id, credit_balance_cents)
        values (${orgId}, ${parsed.name}, ${parsed.slug ?? null}, false, ${parsed.userId}, 0)`;
      await tx`insert into org_memberships (org_id, user_id, role) values (${orgId}, ${parsed.userId}, 'owner')`;
      await insertDefaultWorkspace(tx, { orgId, userId: parsed.userId });
      await auditOrganization(tx, orgId, parsed.userId, "organization.created");
    });
    return (await getOrganization(orgId, parsed.userId))!;
  } catch (error) { throw organizationConflict(error); }
}

function organizationConflict(error: unknown): unknown {
  if (error && typeof error === "object" && "code" in error && error.code === "23505") {
    return new OrganizationError(409, "organization_conflict", "Organization slug or membership already exists");
  }
  return error;
}

export async function getOrganizationAccess(orgId: string, userId: string): Promise<OrganizationAccess> {
  const org = await getOrganization(orgId, userId);
  if (!org) throw new OrganizationError(404, "organization_not_found", "Organization not found");
  const [owners] = await sql<{ count: number }[]>`select count(*)::int as count from org_memberships where org_id = ${orgId} and role = 'owner'`;
  return { orgId, userId, role: org.memberRole, capabilities: organizationCapabilities(org.memberRole, org.isPersonal, owners!.count) };
}

export async function getOrganizationDetails(orgId: string, userId: string): Promise<OrganizationDetails> {
  const organization = await getOrganization(orgId, userId);
  if (!organization) throw new OrganizationError(404, "organization_not_found", "Organization not found");
  const elevated = organization.memberRole === "owner" || organization.memberRole === "admin";
  const [counts] = await sql<{ members: number; workspaces: number; owners: number }[]>`
    select (select count(*)::int from org_memberships where org_id = ${orgId}) as members,
      (select count(*)::int from org_memberships where org_id = ${orgId} and role = 'owner') as owners,
      (select count(*)::int from workspaces w where w.org_id = ${orgId} and
        (${elevated} or w.user_id = ${userId} or exists
          (select 1 from workspace_members wm where wm.workspace_id = w.id and wm.user_id = ${userId}))) as workspaces`;
  return { organization, access: { orgId, userId, role: organization.memberRole, capabilities: organizationCapabilities(organization.memberRole, organization.isPersonal, counts!.owners) }, counts: { members: counts!.members, workspaces: counts!.workspaces } };
}

export async function withOrganizationLock<T>(orgId: string, userId: string, operation: (tx: OrgTransaction, actor: OrganizationMembership, personal: boolean) => Promise<T>): Promise<T> {
  return await sql.begin(async tx => {
    const [org] = await tx<{ is_personal: boolean }[]>`select is_personal from organizations where id = ${orgId} for update`;
    const [actor] = await tx<MembershipRow[]>`select org_id, user_id, role, created_at::text from org_memberships where org_id = ${orgId} and user_id = ${userId}`;
    if (!org || !actor) throw new OrganizationError(404, "organization_not_found", "Organization not found");
    return await operation(tx, mapMembership(actor), org.is_personal);
  }) as T;
}

export async function updateOrganization(orgId: string, userId: string, input: UpdateOrganizationInput): Promise<OrganizationDetails> {
  const parsed = updateOrganizationSchema.parse(input);
  try {
    await withOrganizationLock(orgId, userId, async (tx, actor) => {
      if (!organizationCapabilities(actor.role).update) throw new OrganizationError(403, "organization_forbidden", "Organization admin access required");
      await tx`update organizations set name = coalesce(${parsed.name ?? null}, name),
        slug = case when ${parsed.slug !== undefined} then ${parsed.slug ?? null} else slug end,
        updated_at = now() where id = ${orgId}`;
      await auditOrganization(tx, orgId, userId, "organization.updated", parsed);
    });
    return await getOrganizationDetails(orgId, userId);
  } catch (error) { throw organizationConflict(error); }
}

export async function listOrganizationMembers(orgId: string, userId: string): Promise<OrganizationMember[]> {
  await getOrganizationAccess(orgId, userId);
  const rows = await sql<(MembershipRow & { email: string; name: string })[]>`
    select om.org_id, om.user_id, om.role, om.created_at::text, u.email, u.name
    from org_memberships om join "user" u on u.id = om.user_id where om.org_id = ${orgId} order by om.created_at, om.user_id`;
  return rows.map(row => ({ ...mapMembership(row), email: row.email, name: row.name }));
}

export function assertMembershipMutation(actor: OrganizationMembership["role"], target: OrganizationMembership["role"] | null,
  next: OrganizationMembership["role"] | null, personal: boolean, ownerCount: number, self = false): void {
  if (personal) throw new OrganizationError(409, "personal_organization", "Personal organization memberships cannot be changed");
  if (self && next === null && actor !== "owner") return;
  if (actor !== "owner" && (actor !== "admin" || target === "owner" || target === "admin" || next === "owner" || next === "admin"))
    throw new OrganizationError(403, "membership_forbidden", "Only owners can manage owners and admins");
  if (target === "owner" && next !== "owner" && ownerCount <= 1)
    throw new OrganizationError(409, "last_owner", "Organization must retain an owner");
}

async function mutateMembership(orgId: string, userId: string, memberUserId: string, kind: "update" | "remove", role: OrganizationMembership["role"] | null) {
  try {
    return await withOrganizationLock(orgId, userId, async (tx, actor, personal) => {
      const [target] = await tx<MembershipRow[]>`select org_id, user_id, role, created_at::text from org_memberships where org_id = ${orgId} and user_id = ${memberUserId}`;
      const [owners] = await tx<{ count: number }[]>`select count(*)::int as count from org_memberships where org_id = ${orgId} and role = 'owner'`;
      assertMembershipMutation(actor.role, target?.role ?? null, role, personal, owners!.count, userId === memberUserId);
      if (!target) throw new OrganizationError(404, "membership_not_found", "Membership not found");
      let result: OrganizationMembership | boolean;
      if (kind === "remove") {
        await tx`delete from org_memberships where org_id = ${orgId} and user_id = ${memberUserId}`;
        // G-06: leaving or removal ends every path into this org's data.
        // Organization-bound keys and MCP OAuth grants stop working.
        await tx`update api_keys set revoked_at = now() where org_id = ${orgId} and user_id = ${memberUserId} and revoked_at is null`;
        await tx`update mcp_oauth_grants set revoked_at = now() where org_id = ${orgId} and user_id = ${memberUserId} and revoked_at is null`;
        // Their workspaces pass to the longest-standing owner (the last owner
        // can't be removed, so one remains), and their direct shares go.
        await tx`update workspaces set user_id = (
            select om.user_id from org_memberships om where om.org_id = ${orgId} and om.role = 'owner' order by om.created_at, om.user_id limit 1
          ), updated_at = now()
          where org_id = ${orgId} and user_id = ${memberUserId}`;
        await tx`delete from workspace_members where user_id = ${memberUserId} and workspace_id in (select id from workspaces where org_id = ${orgId})`;
        // Webhooks are per user, not per org: deliveries re-check workspace
        // access (services/webhooks.ts), so this org's events stop reaching them.
        result = true;
      } else {
        const rows = await tx<MembershipRow[]>`update org_memberships set role = ${role} where org_id = ${orgId} and user_id = ${memberUserId} returning org_id, user_id, role, created_at::text`;
        result = mapMembership(rows[0]!);
      }
      await auditOrganization(tx, orgId, userId, `organization.member.${kind}`, { memberUserId, previousRole: target?.role ?? null, role });
      return result;
    });
  } catch (error) { throw organizationConflict(error); }
}

type OrgInviteRow = {
  id: string;
  org_id: string;
  email: string;
  role: OrganizationMembership["role"];
  status: OrganizationInviteRecord["status"];
  invited_by_user_id: string;
  accepted_by_user_id: string | null;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
};


function mapOrganizationInvite(row: OrgInviteRow): OrganizationInviteRecord {
  return organizationInviteSchema.parse({
    id: row.id,
    orgId: row.org_id,
    email: row.email,
    role: row.role,
    status: row.status,
    invitedByUserId: row.invited_by_user_id,
    acceptedByUserId: row.accepted_by_user_id,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at
  });
}

function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function newInviteToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Invites an email address into an organization (G-02). The invitee joins
 * only by accepting while signed in with that email, so admins can no longer
 * place arbitrary user IDs into their org, and nothing here reveals whether
 * an account exists for the address. The raw token is returned once (and
 * emailed); only its hash is stored.
 */
export async function inviteOrganizationMember(orgId: string, userId: string, input: CreateOrganizationInviteInput): Promise<{ invite: OrganizationInviteRecord; token: string }> {
  const parsed = createOrganizationInviteSchema.parse(input);
  const token = newInviteToken();
  const result = await withOrganizationLock(orgId, userId, async (tx, actor, personal) => {
    const [owners] = await tx<{ count: number }[]>`select count(*)::int as count from org_memberships where org_id = ${orgId} and role = 'owner'`;
    assertMembershipMutation(actor.role, null, parsed.role, personal, owners!.count);
    const [member] = await tx<{ user_id: string }[]>`
      select om.user_id from org_memberships om join "user" u on u.id = om.user_id
      where om.org_id = ${orgId} and lower(u.email) = ${parsed.email} limit 1`;
    if (member) throw new OrganizationError(409, "membership_exists", "That email already belongs to a member; update their role instead");
    // A fresh invite replaces any pending one for the same address.
    await tx`update org_invites set status = 'revoked' where org_id = ${orgId} and email = ${parsed.email} and status = 'pending'`;
    const expiresAt = new Date(Date.now() + parsed.expiresInDays * 24 * 60 * 60 * 1000).toISOString();
    const [row] = await tx<OrgInviteRow[]>`
      insert into org_invites (id, org_id, email, role, token_hash, status, invited_by_user_id, expires_at)
      values (${randomUUID()}, ${orgId}, ${parsed.email}, ${parsed.role}, ${hashInviteToken(token)}, 'pending', ${userId}, ${expiresAt}::timestamptz)
      returning id, org_id, email, role, status, invited_by_user_id, accepted_by_user_id, expires_at::text, accepted_at::text, created_at::text`;
    await auditOrganization(tx, orgId, userId, "organization.invite.sent", { inviteId: row!.id, email: parsed.email, role: parsed.role });
    const [org] = await tx<{ name: string }[]>`select name from organizations where id = ${orgId}`;
    return { invite: mapOrganizationInvite(row!), orgName: org?.name ?? "an organization" };
  }).catch((error: unknown) => { throw organizationConflict(error); });

  const inviter = await getUser(userId);
  await sendOrganizationInviteEmail({
    actorUserId: userId,
    recipientEmail: result.invite.email,
    orgId,
    organizationName: result.orgName,
    inviterName: inviter?.name ?? "A DocSlurp user",
    inviteToken: token
  }).catch((error) => {
    console.error("organization invite email failed:", error instanceof Error ? error.message : String(error));
  });
  return { invite: result.invite, token };
}

export async function listOrganizationInvites(orgId: string, userId: string): Promise<OrganizationInviteRecord[]> {
  const access = await getOrganizationAccess(orgId, userId);
  if (!access.capabilities.manageMembers) throw new OrganizationError(403, "membership_forbidden", "Only owners and admins can view invites");
  const rows = await sql<OrgInviteRow[]>`
    select id, org_id, email, role, status, invited_by_user_id, accepted_by_user_id, expires_at::text, accepted_at::text, created_at::text from org_invites where org_id = ${orgId} order by created_at desc`;
  return rows.map(mapOrganizationInvite);
}

export async function revokeOrganizationInvite(orgId: string, userId: string, inviteId: string): Promise<OrganizationInviteRecord> {
  return await withOrganizationLock(orgId, userId, async (tx, actor, personal) => {
    const [invite] = await tx<OrgInviteRow[]>`select id, org_id, email, role, status, invited_by_user_id, accepted_by_user_id, expires_at::text, accepted_at::text, created_at::text from org_invites where id = ${inviteId} and org_id = ${orgId} for update`;
    if (!invite) throw new OrganizationError(404, "invite_not_found", "Invite not found");
    const [owners] = await tx<{ count: number }[]>`select count(*)::int as count from org_memberships where org_id = ${orgId} and role = 'owner'`;
    assertMembershipMutation(actor.role, null, invite.role, personal, owners!.count);
    if (invite.status !== "pending") throw new OrganizationError(409, "invite_inactive", `Invite is already ${invite.status}`);
    const [row] = await tx<OrgInviteRow[]>`update org_invites set status = 'revoked' where id = ${inviteId} returning id, org_id, email, role, status, invited_by_user_id, accepted_by_user_id, expires_at::text, accepted_at::text, created_at::text`;
    await auditOrganization(tx, orgId, userId, "organization.invite.revoked", { inviteId, email: invite.email });
    return mapOrganizationInvite(row!);
  });
}

async function pendingOrgInvite(token: string): Promise<(OrgInviteRow & { org_name: string; inviter_name: string | null }) | null> {
  const [row] = await sql<(OrgInviteRow & { org_name: string; inviter_name: string | null })[]>`
    select i.id, i.org_id, i.email, i.role, i.status, i.invited_by_user_id, i.accepted_by_user_id,
      i.expires_at::text, i.accepted_at::text, i.created_at::text, o.name as org_name, u.name as inviter_name
    from org_invites i
    join organizations o on o.id = i.org_id
    left join "user" u on u.id = i.invited_by_user_id
    where i.token_hash = ${hashInviteToken(token)}
    limit 1`;
  return row ?? null;
}

/** Joins the organization named by an invite token as the signed-in user. */
export async function acceptOrganizationInvite(token: string, userId: string): Promise<OrganizationMembership> {
  const invite = await pendingOrgInvite(token);
  if (!invite) throw new OrganizationError(404, "invite_not_found", "Invite not found");
  if (invite.status !== "pending") throw new OrganizationError(409, "invite_inactive", "Invite is no longer active");
  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    await sql`update org_invites set status = 'expired' where id = ${invite.id} and status = 'pending'`;
    throw new OrganizationError(409, "invite_expired", "Invite has expired");
  }
  const user = await getVerifiedUser(userId);
  if (!user) throw new OrganizationError(403, "email_not_verified", "Verify your email address before accepting an invite");
  if (user.email.toLowerCase() !== invite.email) throw new OrganizationError(403, "invite_email_mismatch", "Invite email does not match the accepting user");

  try {
    return await sql.begin(async (tx) => {
      // Lock the invite so two tabs can't both accept it.
      const [locked] = await tx<{ status: string }[]>`select status from org_invites where id = ${invite.id} for update`;
      if (locked?.status !== "pending") throw new OrganizationError(409, "invite_inactive", "Invite is no longer active");
      const [existing] = await tx<MembershipRow[]>`select org_id, user_id, role, created_at::text from org_memberships where org_id = ${invite.org_id} and user_id = ${userId}`;
      const [row] = existing
        ? [existing]
        : await tx<MembershipRow[]>`insert into org_memberships (org_id, user_id, role) values (${invite.org_id}, ${userId}, ${invite.role}) returning org_id, user_id, role, created_at::text`;
      await tx`update org_invites set status = 'accepted', accepted_by_user_id = ${userId}, accepted_at = now() where id = ${invite.id}`;
      await auditOrganization(tx, invite.org_id, userId, "organization.invite.accepted", { inviteId: invite.id, role: row!.role, alreadyMember: Boolean(existing) });
      return mapMembership(row!);
    }) as OrganizationMembership;
  } catch (error) { throw organizationConflict(error); }
}

export type { InvitePreview };

/** What an invite link offers, for the accept page. The token is the credential. */
export async function getInvitePreview(token: string, kind: "organization" | "workspace"): Promise<InvitePreview | null> {
  if (!token || token.length > 200) return null;
  if (kind === "organization") {
    const invite = await pendingOrgInvite(token);
    if (!invite) return null;
    const expired = invite.status === "pending" && new Date(invite.expires_at).getTime() <= Date.now();
    return { kind, status: expired ? "expired" : invite.status, email: invite.email, role: invite.role, organizationName: invite.org_name,
      workspaceName: null, inviterName: invite.inviter_name, expiresAt: invite.expires_at };
  }
  const [row] = await sql<{ status: InvitePreview["status"]; email: string; role: string; expires_at: string; workspace_name: string; org_name: string; inviter_name: string | null }[]>`
    select i.status, i.email, i.role, i.expires_at::text, w.name as workspace_name, o.name as org_name, u.name as inviter_name
    from workspace_invites i
    join workspaces w on w.id = i.workspace_id
    join organizations o on o.id = i.org_id
    left join "user" u on u.id = i.invited_by_user_id
    where i.token = ${token}
    limit 1`;
  if (!row) return null;
  const expired = row.status === "pending" && new Date(row.expires_at).getTime() <= Date.now();
  return { kind, status: expired ? "expired" : row.status, email: row.email, role: row.role, organizationName: row.org_name,
    workspaceName: row.workspace_name, inviterName: row.inviter_name, expiresAt: row.expires_at };
}
export async function updateOrganizationMemberRole(args: { orgId: string; userId: string; memberUserId: string; role: OrganizationMembership["role"] }): Promise<OrganizationMembership> {
  return await mutateMembership(args.orgId, args.userId, args.memberUserId, "update", args.role) as OrganizationMembership;
}
export async function removeOrganizationMember(args: { orgId: string; userId: string; memberUserId: string }): Promise<boolean> {
  return await mutateMembership(args.orgId, args.userId, args.memberUserId, "remove", null) as boolean;
}

export async function listAccessibleWorkspaceIds(userId: string): Promise<string[]> {
  const rows = await sql<{ workspace_id: string }[]>`
    with accessible as (
      -- G-06: every team-org branch requires an org membership, so a removed
      -- member keeps neither owned workspaces nor direct shares.
      select w.id as workspace_id
      from workspaces w
      join org_memberships om on om.org_id = w.org_id and om.user_id = ${userId}
      left join workspace_members wm on wm.workspace_id = w.id and wm.user_id = ${userId}
      where om.role in ('owner', 'admin') or w.is_default or w.user_id = ${userId} or wm.user_id is not null
      union
      -- Direct shares out of a personal org (its one member can't be removed).
      select wm.workspace_id
      from workspace_members wm
      join workspaces w on w.id = wm.workspace_id
      join organizations o on o.id = w.org_id and o.is_personal
      where wm.user_id = ${userId}
    )
    select workspace_id
    from accessible
  `;

  return withinRequestKeyAllowlist(rows.map((row) => row.workspace_id));
}

export async function listEditableWorkspaceIds(userId: string): Promise<string[]> {
  const rows = await sql<{ workspace_id: string }[]>`
    with editable as (
      select w.id as workspace_id
      from workspaces w
      join org_memberships om on om.org_id = w.org_id and om.user_id = ${userId}
      left join workspace_members wm on wm.workspace_id = w.id and wm.user_id = ${userId}
      where om.role in ('owner', 'admin') or w.is_default or w.user_id = ${userId} or wm.role in ('admin', 'editor')
      union
      select wm.workspace_id
      from workspace_members wm
      join workspaces w on w.id = wm.workspace_id
      join organizations o on o.id = w.org_id and o.is_personal
      where wm.user_id = ${userId}
        and wm.role in ('admin', 'editor')
    )
    select workspace_id
    from editable
  `;

  return withinRequestKeyAllowlist(rows.map((row) => row.workspace_id));
}

export async function getWorkspaceAccess(workspaceId: string, userId: string): Promise<WorkspaceAccess | null> {
  const [row] = await sql<{
    workspace_id: string;
    org_id: string;
    workspace_owner_user_id: string;
    is_default: boolean;
    org_role: OrganizationRecord["memberRole"] | null;
    workspace_role: WorkspaceMemberRecord["role"] | null;
  }[]>`
    select
      w.id as workspace_id,
      w.org_id,
      w.user_id as workspace_owner_user_id,
      w.is_default,
      om.role as org_role,
      wm.role as workspace_role,
      o.is_personal
    from workspaces w
    join organizations o on o.id = w.org_id
    left join org_memberships om
      on om.org_id = w.org_id
      and om.user_id = ${userId}
    left join workspace_members wm
      on wm.workspace_id = w.id
      and wm.user_id = ${userId}
    where w.id = ${workspaceId}
      and (
        (om.user_id is not null and (w.user_id = ${userId} or wm.user_id is not null or om.role in ('owner', 'admin') or w.is_default))
        or (wm.user_id is not null and o.is_personal)
      )
    limit 1
  `;

  if (!row || withinRequestKeyAllowlist([row.workspace_id]).length === 0) {
    return null;
  }

  return {
    workspaceId: row.workspace_id,
    orgId: row.org_id,
    workspaceOwnerUserId: row.workspace_owner_user_id,
    isDefaultWorkspace: row.is_default,
    orgRole: row.org_role,
    workspaceRole: row.workspace_role
  };
}

export function canEditWorkspace(access: WorkspaceAccess, userId: string): boolean {
  return access.workspaceOwnerUserId === userId
    || (access.isDefaultWorkspace === true && access.orgRole !== null)
    || (access.orgRole !== null && elevatedWorkspaceOrgRoles.has(access.orgRole))
    || access.workspaceRole === "admin"
    || access.workspaceRole === "editor";
}

export function canManageWorkspace(access: WorkspaceAccess, userId: string): boolean {
  return access.workspaceOwnerUserId === userId
    || (access.orgRole !== null && elevatedWorkspaceOrgRoles.has(access.orgRole))
    || access.workspaceRole === "admin";
}

export async function listWorkspaceMembers(workspaceId: string, userId: string): Promise<WorkspaceMemberRecord[]> {
  const access = await getWorkspaceAccess(workspaceId, userId);
  if (!access) {
    throw new Error("Workspace not found");
  }

  const rows = await sql<WorkspaceMemberRow[]>`
    select *
    from (
      select
        w.id as workspace_id,
        owner.id as user_id,
        owner.email,
        owner.name,
        'admin'::text as role,
        null::text as invited_by_user_id,
        w.created_at::text as created_at
      from workspaces w
      join "user" owner on owner.id = w.user_id
      where w.id = ${workspaceId}
      union all
      select
        wm.workspace_id,
        wm.user_id,
        auth_user.email,
        auth_user.name,
        wm.role::text,
        wm.invited_by_user_id,
        wm.created_at::text
      from workspace_members wm
      join "user" auth_user on auth_user.id = wm.user_id
      join workspaces w on w.id = wm.workspace_id
      where wm.workspace_id = ${workspaceId}
        and wm.user_id <> w.user_id
    ) members
    order by created_at asc
  `;

  return rows.map(mapWorkspaceMember);
}

export async function updateWorkspaceMemberRole(args: {
  workspaceId: string;
  userId: string;
  memberUserId: string;
  role: WorkspaceMemberRecord["role"];
}): Promise<WorkspaceMemberRecord> {
  const parsed = updateWorkspaceMemberSchema.parse({ role: args.role });
  const access = await getWorkspaceAccess(args.workspaceId, args.userId);
  if (!access) {
    throw new Error("Workspace not found");
  }
  if (!canManageWorkspace(access, args.userId)) {
    throw new Error("Only workspace admins can manage sharing");
  }
  if (args.memberUserId === access.workspaceOwnerUserId) {
    throw new Error("Workspace ownership must be changed separately");
  }

  const [row] = await sql<WorkspaceMemberRow[]>`
    update workspace_members wm
    set role = ${parsed.role}
    from "user" auth_user
    where wm.workspace_id = ${args.workspaceId}
      and wm.user_id = ${args.memberUserId}
      and auth_user.id = wm.user_id
    returning
      wm.workspace_id,
      wm.user_id,
      auth_user.email,
      auth_user.name,
      wm.role,
      wm.invited_by_user_id,
      wm.created_at::text
  `;

  if (!row) {
    throw new Error("Workspace membership not found");
  }

  return mapWorkspaceMember(row);
}

export async function removeWorkspaceMember(args: {
  workspaceId: string;
  userId: string;
  memberUserId: string;
}): Promise<boolean> {
  const access = await getWorkspaceAccess(args.workspaceId, args.userId);
  if (!access) {
    throw new Error("Workspace not found");
  }
  if (!canManageWorkspace(access, args.userId)) {
    throw new Error("Only workspace admins can manage sharing");
  }
  if (args.memberUserId === access.workspaceOwnerUserId) {
    throw new Error("Workspace owner cannot be removed from this surface");
  }
  if (args.memberUserId === args.userId && access.orgRole !== "owner" && access.orgRole !== "admin" && access.workspaceRole !== "admin") {
    throw new Error("Only workspace admins can manage sharing");
  }

  const [row] = await sql<{ user_id: string }[]>`
    delete from workspace_members
    where workspace_id = ${args.workspaceId}
      and user_id = ${args.memberUserId}
    returning user_id
  `;

  return !!row;
}

export async function listWorkspaceInvites(workspaceId: string, userId: string): Promise<WorkspaceInviteRecord[]> {
  const access = await getWorkspaceAccess(workspaceId, userId);
  if (!access) {
    throw new Error("Workspace not found");
  }
  if (!canManageWorkspace(access, userId)) {
    throw new Error("Only workspace admins can view invites");
  }

  const rows = await sql<WorkspaceInviteRow[]>`
    select
      id,
      workspace_id,
      org_id,
      email,
      role,
      token,
      status,
      invited_by_user_id,
      accepted_by_user_id,
      expires_at::text,
      accepted_at::text,
      created_at::text
    from workspace_invites
    where workspace_id = ${workspaceId}
    order by created_at desc
  `;

  return rows.map(mapWorkspaceInvite);
}

export async function inviteWorkspaceMember(workspaceId: string, input: CreateWorkspaceInviteInput): Promise<WorkspaceInviteRecord> {
  const parsed = createWorkspaceInviteSchema.parse(input);
  const access = await getWorkspaceAccess(workspaceId, parsed.userId);
  if (!access) {
    throw new Error("Workspace not found");
  }
  if (!canManageWorkspace(access, parsed.userId)) {
    throw new Error("Only workspace admins can invite members");
  }
  await assertWorkspaceInviteeAllowed(access, parsed.email);

  const expiresAt = new Date(Date.now() + parsed.expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  const [row] = await sql<WorkspaceInviteRow[]>`
    insert into workspace_invites (
      id,
      workspace_id,
      org_id,
      email,
      role,
      token,
      status,
      invited_by_user_id,
      expires_at
    )
    values (
      ${randomUUID()},
      ${workspaceId},
      ${access.orgId},
      ${parsed.email},
      ${parsed.role},
      ${randomUUID()},
      'pending',
      ${parsed.userId},
      ${expiresAt}::timestamptz
    )
    returning
      id,
      workspace_id,
      org_id,
      email,
      role,
      token,
      status,
      invited_by_user_id,
      accepted_by_user_id,
      expires_at::text,
      accepted_at::text,
      created_at::text
  `;

  const invite = mapWorkspaceInvite(row);
  const [workspaceRow] = await sql<{ name: string }[]>`
    select name from workspaces where id = ${workspaceId} limit 1
  `;
  const inviter = await getUser(parsed.userId);
  if (workspaceRow?.name && inviter) {
    await sendWorkspaceInviteEmail({
      actorUserId: parsed.userId,
      recipientEmail: parsed.email,
      orgId: access.orgId,
      workspaceId,
      workspaceName: workspaceRow.name,
      inviterName: inviter.name,
      inviteToken: invite.token
    }).catch((error) => {
      console.error("workspace invite email failed:", error instanceof Error ? error.message : String(error));
    });
  }

  return invite;
}

/**
 * Workspace access in a team organization requires org membership (G-06), and
 * accepting a workspace invite makes an outsider an org member. Only org
 * owners and admins may bring new people into the org that way; workspace
 * admins can share with existing members.
 */
async function assertWorkspaceInviteeAllowed(access: WorkspaceAccess, email: string): Promise<void> {
  const [org] = await sql<{ is_personal: boolean }[]>`select is_personal from organizations where id = ${access.orgId}`;
  if (!org || org.is_personal) return;
  if (access.orgRole === "owner" || access.orgRole === "admin") return;
  const [member] = await sql<{ user_id: string }[]>`
    select om.user_id from org_memberships om join "user" u on u.id = om.user_id
    where om.org_id = ${access.orgId} and lower(u.email) = ${email.toLowerCase()} limit 1`;
  if (!member) throw new Error("Only organization owners and admins can invite people outside the organization");
}

export async function revokeWorkspaceInvite(args: {
  workspaceId: string;
  userId: string;
  inviteId: string;
}): Promise<WorkspaceInviteRecord> {
  const access = await getWorkspaceAccess(args.workspaceId, args.userId);
  if (!access) {
    throw new Error("Workspace not found");
  }
  if (!canManageWorkspace(access, args.userId)) {
    throw new Error("Only workspace admins can invite members");
  }

  const [row] = await sql<WorkspaceInviteRow[]>`
    update workspace_invites
    set status = 'revoked'
    where id = ${args.inviteId}
      and workspace_id = ${args.workspaceId}
      and status = 'pending'
    returning
      id,
      workspace_id,
      org_id,
      email,
      role,
      token,
      status,
      invited_by_user_id,
      accepted_by_user_id,
      expires_at::text,
      accepted_at::text,
      created_at::text
  `;

  if (!row) {
    const [existing] = await sql<WorkspaceInviteRow[]>`
      select
        id,
        workspace_id,
        org_id,
        email,
        role,
        token,
        status,
        invited_by_user_id,
        accepted_by_user_id,
        expires_at::text,
        accepted_at::text,
        created_at::text
      from workspace_invites
      where id = ${args.inviteId}
        and workspace_id = ${args.workspaceId}
      limit 1
    `;

    if (!existing) {
      throw new Error("Workspace invite not found");
    }

    throw new Error(`Workspace invite is already ${existing.status}`);
  }

  return mapWorkspaceInvite(row);
}

export async function acceptWorkspaceInvite(token: string, userId: string): Promise<WorkspaceMemberRecord> {
  const inviteRows = await sql<WorkspaceInviteRow[]>`
    select
      id,
      workspace_id,
      org_id,
      email,
      role,
      token,
      status,
      invited_by_user_id,
      accepted_by_user_id,
      expires_at::text,
      accepted_at::text,
      created_at::text
    from workspace_invites
    where token = ${token}
    limit 1
  `;

  const invite = inviteRows[0];
  if (!invite) {
    throw new Error("Invite not found");
  }
  if (invite.status !== "pending") {
    throw new Error("Invite is no longer active");
  }
  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    await sql`
      update workspace_invites
      set status = 'expired'
      where id = ${invite.id}
    `;
    throw new Error("Invite has expired");
  }

  const user = await getVerifiedUser(userId);
  if (!user) {
    throw new Error("Verify your email address before accepting an invite");
  }
  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    throw new Error("Invite email does not match the accepting user");
  }

  await sql.begin(async (tx) => {
    const [org] = await tx<{ is_personal: boolean }[]>`select is_personal from organizations where id = ${invite.org_id}`;
    if (org && !org.is_personal) {
      // Team-org workspace access requires org membership. An outsider joins
      // as a member only if the inviter can still add people to the org.
      const [membership] = await tx`select 1 from org_memberships where org_id = ${invite.org_id} and user_id = ${userId}`;
      if (!membership) {
        const [inviter] = await tx<{ role: string }[]>`
          select role from org_memberships where org_id = ${invite.org_id} and user_id = ${invite.invited_by_user_id}`;
        if (inviter?.role !== "owner" && inviter?.role !== "admin") {
          throw new Error("This invite can no longer add you to the organization; ask an organization admin to invite you");
        }
        await tx`insert into org_memberships (org_id, user_id, role) values (${invite.org_id}, ${userId}, 'member') on conflict do nothing`;
        await auditOrganization(tx, invite.org_id, userId, "organization.member.joined_via_workspace_invite", { inviteId: invite.id, workspaceId: invite.workspace_id });
      }
    }
    await tx`
      insert into workspace_members (workspace_id, user_id, role, invited_by_user_id)
      values (${invite.workspace_id}, ${userId}, ${invite.role}, ${invite.invited_by_user_id})
      on conflict (workspace_id, user_id) do update
        set role = excluded.role,
            invited_by_user_id = excluded.invited_by_user_id
    `;
    await tx`
      update workspace_invites
      set
        status = 'accepted',
        accepted_by_user_id = ${userId},
        accepted_at = now()
      where id = ${invite.id} and status = 'pending'
    `;
  });

  const [row] = await sql<WorkspaceMemberRow[]>`
    select
      wm.workspace_id,
      wm.user_id,
      auth_user.email,
      auth_user.name,
      wm.role,
      wm.invited_by_user_id,
      wm.created_at::text
    from workspace_members wm
    join "user" auth_user on auth_user.id = wm.user_id
    where wm.workspace_id = ${invite.workspace_id} and wm.user_id = ${userId}
    limit 1
  `;

  return mapWorkspaceMember(row);
}

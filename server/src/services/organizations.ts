import { createHash, randomBytes, randomUUID } from "node:crypto";
import type postgres from "postgres";
import { updateOrganizationMfaPolicySchema, updateOrganizationSchema, type UpdateOrganizationMfaPolicyInput, type InvitePreview, type OrganizationAccess, type OrganizationDetails, type OrganizationMember, type UpdateOrganizationInput } from "@docslurp/shared";

import {
  createOrganizationInviteSchema,
  createOrganizationSchema,
  createProjectInviteSchema,
  organizationInviteSchema,
  organizationMembershipSchema,
  organizationSchema,
  projectInviteSchema,
  projectMemberSchema,
  updateProjectMemberSchema,
  type CreateOrganizationInput,
  type CreateOrganizationInviteInput,
  type CreateProjectInviteInput,
  type OrganizationInviteRecord,
  type OrganizationMembership,
  type OrganizationRecord,
  type ProjectInviteRecord,
  type ProjectMemberRecord
} from "@docslurp/shared";

import { sql } from "../db.js";
import { insertDefaultProject } from "./default-project.js";
import { sendOrganizationInviteEmail, sendProjectInviteEmail } from "./notifications.js";
import { currentRequestApiKeyProjectIds } from "../lib/request-context.js";
import { assertUserMayJoinOrg, UserAlreadyInOrgError } from "./org-membership-limit.js";
import { forgetProviderPolicy } from "../lib/provider-policy.js";

/** Narrows project IDs to the current API key request's allowlist, if any. */
function withinRequestKeyAllowlist(projectIds: string[]): string[] {
  const allowlist = currentRequestApiKeyProjectIds();
  return allowlist ? projectIds.filter((id) => allowlist.includes(id)) : projectIds;
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
  funded?: boolean | null;
  retain_document_versions?: number | null;
  allow_china_providers?: boolean;
  created_at: string;
  updated_at: string;
};

type MembershipRow = {
  org_id: string;
  user_id: string;
  role: OrganizationMembership["role"];
  created_at: string;
};

type ProjectMemberRow = {
  project_id: string;
  user_id: string;
  email: string | null;
  name: string | null;
  role: ProjectMemberRecord["role"];
  invited_by_user_id: string | null;
  created_at: string;
};

type ProjectInviteRow = {
  id: string;
  project_id: string;
  org_id: string;
  email: string;
  role: ProjectInviteRecord["role"];
  token: string;
  status: ProjectInviteRecord["status"];
  invited_by_user_id: string;
  accepted_by_user_id: string | null;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
};

export interface ProjectAccess {
  projectId: string;
  orgId: string;
  projectOwnerUserId: string;
  /**
   * Every org member may read the org's default project and add content to it
   * (`canContributeToProject`); changing its settings still needs edit rights.
   */
  isDefaultProject?: boolean;
  orgRole: OrganizationRecord["memberRole"] | null;
  projectRole: ProjectMemberRecord["role"] | null;
}

const elevatedProjectOrgRoles = new Set<OrganizationRecord["memberRole"]>(["owner", "admin"]);

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
    funded: row.funded === true,
    retainDocumentVersions: row.retain_document_versions ?? null,
    allowChinaProviders: row.allow_china_providers !== false,
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

function mapProjectMember(row: ProjectMemberRow): ProjectMemberRecord {
  return projectMemberSchema.parse({
    projectId: row.project_id,
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    invitedByUserId: row.invited_by_user_id,
    createdAt: row.created_at
  });
}

function mapProjectInvite(row: ProjectInviteRow): ProjectInviteRecord {
  return projectInviteSchema.parse({
    id: row.id,
    projectId: row.project_id,
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
  return `${name.split(" ")[0] ?? "Personal"} Project`;
}

/**
 * The organization a request that names none acts in: the user's personal organization, else their oldest membership,
 * else (a user with no organization at all) a personal organization provisioned now. Callers still check membership of
 * whatever organization they then use; this only picks the default, as an org picker would.
 */
export async function resolveDefaultOrganization(userId: string): Promise<OrganizationRecord> {
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
      o.funded_at is not null as funded,
      o.retain_document_versions, o.allow_china_providers,
      o.created_at::text,
      o.updated_at::text
    from organizations o
    join org_memberships om on om.org_id = o.id and om.user_id = ${userId}
    where o.deleted_at is null
    order by (o.personal_owner_user_id = ${userId}) desc, om.created_at, o.id
    limit 1
  `;

  if (existing) {
    return mapOrganization(existing);
  }

  if (!(await getUser(userId))) {
    throw new Error("User not found");
  }
  await sql.begin(async (tx) => {
    await provisionPersonalOrganization(tx, userId);
  });
  return await resolveDefaultOrganization(userId);
}

/**
 * Gives a user who has no organization their personal one: re-joins it when it still exists (memberships removed by
 * 0127 or by leaving keep the row and its data), else creates it with a default project. Runs inside the caller's
 * transaction; the caller has established that the user may join (they have no other membership while
 * DOCSLURP_MAX_ORGS_PER_USER is 1).
 */
async function provisionPersonalOrganization(tx: OrgTransaction, userId: string): Promise<string> {
  const [user] = await tx<{ id: string; name: string }[]>`select id, name from "user" where id = ${userId} and deleted_at is null`;
  if (!user) throw new OrganizationError(404, "user_not_found", "User not found");
  const [existing] = await tx<{ id: string }[]>`
    select id from organizations where personal_owner_user_id = ${userId} and deleted_at is null limit 1
  `;
  const organizationId = existing?.id ?? randomUUID();
  if (!existing) {
    await tx`
      insert into organizations (id, name, slug, is_personal, personal_owner_user_id, created_by_user_id, credit_balance_cents)
      values (${organizationId}, ${personalOrgName(user.name)}, ${`${user.id}-personal`}, true, ${user.id}, ${user.id}, 0)
    `;
  }
  await tx`
    insert into org_memberships (org_id, user_id, role) values (${organizationId}, ${user.id}, 'owner')
    on conflict (org_id, user_id) do nothing
  `;
  // Every organization starts with a default project, so dashboard-only
  // users and requests that omit projectId have somewhere to land.
  await insertDefaultProject(tx, { orgId: organizationId, userId: user.id });
  return organizationId;
}

/**
 * The membership-limit check for a join or create (org-membership-limit.ts), translated to this module's error. When the
 * user's empty personal organization is all that stands in the way, it is deleted here and the new membership replaces it.
 */
async function admitToOrganization(tx: OrgTransaction, userId: string, targetOrgId: string | null): Promise<void> {
  let replacePersonalOrgId: string | null;
  try {
    ({ replacePersonalOrgId } = await assertUserMayJoinOrg(tx, userId, targetOrgId));
  } catch (error) {
    if (error instanceof UserAlreadyInOrgError) throw new OrganizationError(409, error.code, error.message);
    throw error;
  }
  if (!replacePersonalOrgId) return;
  // Lock the organization and its projects (a concurrent API key, run, chat or upload that references them now waits),
  // then re-check under the locks that it is still empty. projects.org_id has no foreign key, so its projects are deleted
  // explicitly; anything else that hangs off them is empty by docslurp_personal_org_is_empty. Fails closed: an organization
  // that gained data keeps the user in it and the join is refused.
  await tx`select id from organizations where id = ${replacePersonalOrgId} for update`;
  await tx`select id from projects where org_id = ${replacePersonalOrgId} for update`;
  const [stillEmpty] = await tx<{ empty: boolean }[]>`
    select is_personal and personal_owner_user_id = ${userId} and docslurp_personal_org_is_empty(id) as empty
    from organizations where id = ${replacePersonalOrgId}
  `;
  if (!stillEmpty?.empty) throw new OrganizationError(409, "user_already_in_org", new UserAlreadyInOrgError().message);
  await tx`delete from projects where org_id = ${replacePersonalOrgId}`;
  await tx`delete from organizations where id = ${replacePersonalOrgId}`;
  await tx`insert into audit_log (id, user_id, action, resource_type, resource_id, metadata)
    values (${randomUUID()}, ${userId}, 'organization.personal.replaced', 'organization', ${replacePersonalOrgId}, ${tx.json({ joinedOrgId: targetOrgId })})`;
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
      o.funded_at is not null as funded,
      o.retain_document_versions, o.allow_china_providers,
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
      o.funded_at is not null as funded,
      o.retain_document_versions, o.allow_china_providers,
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
  constructor(readonly status: 400 | 402 | 403 | 404 | 409, readonly code: string, message: string) { super(message); }
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
      await admitToOrganization(tx, parsed.userId, null);
      await tx`insert into organizations (id, name, slug, is_personal, created_by_user_id, credit_balance_cents)
        values (${orgId}, ${parsed.name}, ${parsed.slug ?? null}, false, ${parsed.userId}, 0)`;
      await tx`insert into org_memberships (org_id, user_id, role) values (${orgId}, ${parsed.userId}, 'owner')`;
      await insertDefaultProject(tx, { orgId, userId: parsed.userId });
      await auditOrganization(tx, orgId, parsed.userId, "organization.created");
    });
    return (await getOrganization(orgId, parsed.userId))!;
  } catch (error) { throw organizationConflict(error); }
}

function organizationConflict(error: unknown): unknown {
  // The unique index behind the one-organization-per-user policy (migration 0127), hit by a concurrent join.
  if (error && typeof error === "object" && "constraint_name" in error && error.constraint_name === "org_memberships_one_org_per_user") {
    return new OrganizationError(409, "user_already_in_org", new UserAlreadyInOrgError().message);
  }
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
  const [counts] = await sql<{ members: number; projects: number; owners: number }[]>`
    select (select count(*)::int from org_memberships where org_id = ${orgId}) as members,
      (select count(*)::int from org_memberships where org_id = ${orgId} and role = 'owner') as owners,
      (select count(*)::int from projects w where w.org_id = ${orgId} and docslurp_project_access(w.id, ${userId})) as projects`;
  return { organization, access: { orgId, userId, role: organization.memberRole, capabilities: organizationCapabilities(organization.memberRole, organization.isPersonal, counts!.owners) }, counts: { members: counts!.members, projects: counts!.projects } };
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
      // Retention is open to every org: archived versions are billed as storage per GB.
      await tx`update organizations set name = coalesce(${parsed.name ?? null}, name),
        slug = case when ${parsed.slug !== undefined} then ${parsed.slug ?? null} else slug end,
        retain_document_versions = case when ${parsed.retainDocumentVersions !== undefined} then ${parsed.retainDocumentVersions ?? null}::integer else retain_document_versions end,
        allow_china_providers = coalesce(${parsed.allowChinaProviders ?? null}::boolean, allow_china_providers),
        updated_at = now() where id = ${orgId}`;
      await auditOrganization(tx, orgId, userId, "organization.updated", parsed);
    });
    if (parsed.allowChinaProviders !== undefined) forgetProviderPolicy(orgId);
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
        // Their projects pass to the longest-standing owner (the last owner
        // can't be removed, so one remains), and their direct shares go.
        await tx`update projects set user_id = (
            select om.user_id from org_memberships om where om.org_id = ${orgId} and om.role = 'owner' order by om.created_at, om.user_id limit 1
          ), updated_at = now()
          where org_id = ${orgId} and user_id = ${memberUserId}`;
        await tx`delete from project_members where user_id = ${memberUserId} and project_id in (select id from projects where org_id = ${orgId})`;
        // Webhooks they created here stop delivering: a webhook delivers only while its creator
        // administers its organization (services/webhooks.ts).
        // Nobody is left without an organization: one who has none now gets their personal one back.
        const [remaining] = await tx`select 1 from org_memberships where user_id = ${memberUserId} limit 1`;
        if (!remaining) await provisionPersonalOrganization(tx, memberUserId);
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
      if (!existing) await admitToOrganization(tx, userId, invite.org_id);
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
export async function getInvitePreview(token: string, kind: "organization" | "project"): Promise<InvitePreview | null> {
  if (!token || token.length > 200) return null;
  if (kind === "organization") {
    const invite = await pendingOrgInvite(token);
    if (!invite) return null;
    const expired = invite.status === "pending" && new Date(invite.expires_at).getTime() <= Date.now();
    return { kind, status: expired ? "expired" : invite.status, email: invite.email, role: invite.role, organizationName: invite.org_name,
      projectName: null, inviterName: invite.inviter_name, expiresAt: invite.expires_at };
  }
  const [row] = await sql<{ status: InvitePreview["status"]; email: string; role: string; expires_at: string; project_name: string; org_name: string; inviter_name: string | null }[]>`
    select i.status, i.email, i.role, i.expires_at::text, w.name as project_name, o.name as org_name, u.name as inviter_name
    from project_invites i
    join projects w on w.id = i.project_id
    join organizations o on o.id = i.org_id
    left join "user" u on u.id = i.invited_by_user_id
    where i.token = ${token}
    limit 1`;
  if (!row) return null;
  const expired = row.status === "pending" && new Date(row.expires_at).getTime() <= Date.now();
  return { kind, status: expired ? "expired" : row.status, email: row.email, role: row.role, organizationName: row.org_name,
    projectName: row.project_name, inviterName: row.inviter_name, expiresAt: row.expires_at };
}
export async function updateOrganizationMemberRole(args: { orgId: string; userId: string; memberUserId: string; role: OrganizationMembership["role"] }): Promise<OrganizationMembership> {
  return await mutateMembership(args.orgId, args.userId, args.memberUserId, "update", args.role) as OrganizationMembership;
}
export async function removeOrganizationMember(args: { orgId: string; userId: string; memberUserId: string }): Promise<boolean> {
  return await mutateMembership(args.orgId, args.userId, args.memberUserId, "remove", null) as boolean;
}

export async function listAccessibleProjectIds(userId: string): Promise<string[]> {
  const rows = await sql<{ project_id: string }[]>`
    -- The rule itself lives in docslurp_project_access (migration 0124). The
    -- candidate filter only narrows the scan to projects in the user's orgs or
    -- shared with them, which is a superset of what the function can grant.
    select w.id as project_id
    from projects w
    where (
        w.org_id in (select om.org_id from org_memberships om where om.user_id = ${userId})
        or w.id in (select wm.project_id from project_members wm where wm.user_id = ${userId})
      )
      and docslurp_project_access(w.id, ${userId})
  `;

  return withinRequestKeyAllowlist(rows.map((row) => row.project_id));
}

/**
 * Projects the user may reprocess or spend on (re-index, full index, figure resume): canEditProject, the same rule as
 * callerCanReprocess. Unlike listEditableProjectIds (the upload/contribute rule), membership of the org's default project
 * alone does not qualify: org owners and admins, the project's owner, and its admins and editors do (owner decision,
 * council L3, 2026-11-13).
 */
export async function listReprocessableProjectIds(userId: string): Promise<string[]> {
  const rows = await sql<{ project_id: string }[]>`
    select w.id as project_id
    from projects w
    left join org_memberships om on om.org_id = w.org_id and om.user_id = ${userId}
    left join project_members wm on wm.project_id = w.id and wm.user_id = ${userId}
    where (om.user_id is not null or wm.user_id is not null)
      and (om.role in ('owner', 'admin') or w.user_id = ${userId} or wm.role in ('admin', 'editor'))
      and docslurp_project_access(w.id, ${userId})
  `;
  return withinRequestKeyAllowlist(rows.map((row) => row.project_id));
}

/** Projects the user may manage (archive, delete, members): canManageProject. Org owners and admins, the project's owner, its admins. */
export async function listManageableProjectIds(userId: string): Promise<string[]> {
  const rows = await sql<{ project_id: string }[]>`
    select w.id as project_id
    from projects w
    left join org_memberships om on om.org_id = w.org_id and om.user_id = ${userId}
    left join project_members wm on wm.project_id = w.id and wm.user_id = ${userId}
    where (om.user_id is not null or wm.user_id is not null)
      and (om.role in ('owner', 'admin') or w.user_id = ${userId} or wm.role = 'admin')
      and docslurp_project_access(w.id, ${userId})
  `;
  return withinRequestKeyAllowlist(rows.map((row) => row.project_id));
}

/**
 * Projects the user may contribute to: upload into, tag documents in. Includes every org member for the org's default
 * project (canContributeToProject). Not for reprocessing or other spend on existing documents: listReprocessableProjectIds.
 */
export async function listEditableProjectIds(userId: string): Promise<string[]> {
  const rows = await sql<{ project_id: string }[]>`
    with editable as (
      select w.id as project_id
      from projects w
      join org_memberships om on om.org_id = w.org_id and om.user_id = ${userId}
      left join project_members wm on wm.project_id = w.id and wm.user_id = ${userId}
      where om.role in ('owner', 'admin') or w.is_default or w.user_id = ${userId} or wm.role in ('admin', 'editor')
      union
      select wm.project_id
      from project_members wm
      join projects w on w.id = wm.project_id
      join organizations o on o.id = w.org_id and o.is_personal
      where wm.user_id = ${userId}
        and wm.role in ('admin', 'editor')
    )
    select project_id
    from editable
  `;

  return withinRequestKeyAllowlist(rows.map((row) => row.project_id));
}

export async function getProjectAccess(projectId: string, userId: string, client: postgres.Sql | postgres.TransactionSql = sql): Promise<ProjectAccess | null> {
  const access = await projectAccessRow(projectId, userId, client, false);
  if (!access) return null;
  const { pipeline: _pipeline, ...rest } = access;
  return rest;
}

/**
 * getProjectAccess plus the stored pipeline, in the same single query, for
 * callers that decide on access and privacy mode together (the search response cache).
 */
export async function getProjectAccessWithPipeline(projectId: string, userId: string, client: postgres.Sql | postgres.TransactionSql = sql): Promise<(ProjectAccess & { pipeline: unknown }) | null> {
  return await projectAccessRow(projectId, userId, client, true);
}

async function projectAccessRow(projectId: string, userId: string, client: postgres.Sql | postgres.TransactionSql, includePipeline: boolean): Promise<(ProjectAccess & { pipeline: unknown }) | null> {
  const [row] = await client<{
    project_id: string;
    org_id: string;
    project_owner_user_id: string;
    is_default: boolean;
    org_role: OrganizationRecord["memberRole"] | null;
    project_role: ProjectMemberRecord["role"] | null;
    pipeline: unknown;
  }[]>`
    select
      w.id as project_id,
      w.org_id,
      w.user_id as project_owner_user_id,
      w.is_default,
      om.role as org_role,
      wm.role as project_role,
      o.is_personal,
      case when ${includePipeline}::boolean then w.pipeline end as pipeline
    from projects w
    join organizations o on o.id = w.org_id
    left join org_memberships om
      on om.org_id = w.org_id
      and om.user_id = ${userId}
    left join project_members wm
      on wm.project_id = w.id
      and wm.user_id = ${userId}
    where w.id = ${projectId}
      and docslurp_project_access(w.id, ${userId})
    limit 1
  `;

  if (!row || withinRequestKeyAllowlist([row.project_id]).length === 0) {
    return null;
  }

  return {
    projectId: row.project_id,
    orgId: row.org_id,
    projectOwnerUserId: row.project_owner_user_id,
    isDefaultProject: row.is_default,
    orgRole: row.org_role,
    projectRole: row.project_role,
    pipeline: row.pipeline,
  };
}

/** May change the project's settings, search and chat configuration, and spend-heavy builds. */
export function canEditProject(access: ProjectAccess, userId: string): boolean {
  return access.projectOwnerUserId === userId
    || (access.orgRole !== null && elevatedProjectOrgRoles.has(access.orgRole))
    || access.projectRole === "admin"
    || access.projectRole === "editor";
}

/**
 * May upload into the project and manage those runs. Every org member may add
 * to the org's default project, including one listed as a viewer of it; that
 * membership alone never grants settings changes (SEC-2026-10-PROD-14).
 */
export function canContributeToProject(access: ProjectAccess, userId: string): boolean {
  return canEditProject(access, userId)
    || (access.isDefaultProject === true && access.orgRole !== null);
}

export function canManageProject(access: ProjectAccess, userId: string): boolean {
  return access.projectOwnerUserId === userId
    || (access.orgRole !== null && elevatedProjectOrgRoles.has(access.orgRole))
    || access.projectRole === "admin";
}

export async function listProjectMembers(projectId: string, userId: string): Promise<ProjectMemberRecord[]> {
  const access = await getProjectAccess(projectId, userId);
  if (!access) {
    throw new Error("Project not found");
  }

  const rows = await sql<ProjectMemberRow[]>`
    select *
    from (
      select
        w.id as project_id,
        owner.id as user_id,
        owner.email,
        owner.name,
        'admin'::text as role,
        null::text as invited_by_user_id,
        w.created_at::text as created_at
      from projects w
      join "user" owner on owner.id = w.user_id
      where w.id = ${projectId}
      union all
      select
        wm.project_id,
        wm.user_id,
        auth_user.email,
        auth_user.name,
        wm.role::text,
        wm.invited_by_user_id,
        wm.created_at::text
      from project_members wm
      join "user" auth_user on auth_user.id = wm.user_id
      join projects w on w.id = wm.project_id
      where wm.project_id = ${projectId}
        and wm.user_id <> w.user_id
    ) members
    order by created_at asc
  `;

  return rows.map(mapProjectMember);
}

export async function updateProjectMemberRole(args: {
  projectId: string;
  userId: string;
  memberUserId: string;
  role: ProjectMemberRecord["role"];
}): Promise<ProjectMemberRecord> {
  const parsed = updateProjectMemberSchema.parse({ role: args.role });
  const access = await getProjectAccess(args.projectId, args.userId);
  if (!access) {
    throw new Error("Project not found");
  }
  if (!canManageProject(access, args.userId)) {
    throw new Error("Only project admins can manage sharing");
  }
  if (args.memberUserId === access.projectOwnerUserId) {
    throw new Error("Project ownership must be changed separately");
  }

  const [row] = await sql<ProjectMemberRow[]>`
    update project_members wm
    set role = ${parsed.role}
    from "user" auth_user
    where wm.project_id = ${args.projectId}
      and wm.user_id = ${args.memberUserId}
      and auth_user.id = wm.user_id
    returning
      wm.project_id,
      wm.user_id,
      auth_user.email,
      auth_user.name,
      wm.role,
      wm.invited_by_user_id,
      wm.created_at::text
  `;

  if (!row) {
    throw new Error("Project membership not found");
  }

  return mapProjectMember(row);
}

export async function removeProjectMember(args: {
  projectId: string;
  userId: string;
  memberUserId: string;
}): Promise<boolean> {
  const access = await getProjectAccess(args.projectId, args.userId);
  if (!access) {
    throw new Error("Project not found");
  }
  if (!canManageProject(access, args.userId)) {
    throw new Error("Only project admins can manage sharing");
  }
  if (args.memberUserId === access.projectOwnerUserId) {
    throw new Error("Project owner cannot be removed from this surface");
  }
  if (args.memberUserId === args.userId && access.orgRole !== "owner" && access.orgRole !== "admin" && access.projectRole !== "admin") {
    throw new Error("Only project admins can manage sharing");
  }

  const [row] = await sql<{ user_id: string }[]>`
    delete from project_members
    where project_id = ${args.projectId}
      and user_id = ${args.memberUserId}
    returning user_id
  `;

  return !!row;
}

export async function listProjectInvites(projectId: string, userId: string): Promise<ProjectInviteRecord[]> {
  const access = await getProjectAccess(projectId, userId);
  if (!access) {
    throw new Error("Project not found");
  }
  if (!canManageProject(access, userId)) {
    throw new Error("Only project admins can view invites");
  }

  const rows = await sql<ProjectInviteRow[]>`
    select
      id,
      project_id,
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
    from project_invites
    where project_id = ${projectId}
    order by created_at desc
  `;

  return rows.map(mapProjectInvite);
}

export async function inviteProjectMember(projectId: string, input: CreateProjectInviteInput): Promise<ProjectInviteRecord> {
  const parsed = createProjectInviteSchema.parse(input);
  const access = await getProjectAccess(projectId, parsed.userId);
  if (!access) {
    throw new Error("Project not found");
  }
  if (!canManageProject(access, parsed.userId)) {
    throw new Error("Only project admins can invite members");
  }
  await assertProjectInviteeAllowed(access, parsed.email);

  const expiresAt = new Date(Date.now() + parsed.expiresInDays * 24 * 60 * 60 * 1000).toISOString();
  const [row] = await sql<ProjectInviteRow[]>`
    insert into project_invites (
      id,
      project_id,
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
      ${projectId},
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
      project_id,
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

  const invite = mapProjectInvite(row);
  const [projectRow] = await sql<{ name: string }[]>`
    select name from projects where id = ${projectId} limit 1
  `;
  const inviter = await getUser(parsed.userId);
  if (projectRow?.name && inviter) {
    await sendProjectInviteEmail({
      actorUserId: parsed.userId,
      recipientEmail: parsed.email,
      orgId: access.orgId,
      projectId,
      projectName: projectRow.name,
      inviterName: inviter.name,
      inviteToken: invite.token
    }).catch((error) => {
      console.error("project invite email failed:", error instanceof Error ? error.message : String(error));
    });
  }

  return invite;
}

/**
 * Project access in a team organization requires org membership (G-06), and
 * accepting a project invite makes an outsider an org member. Only org
 * owners and admins may bring new people into the org that way; project
 * admins can share with existing members.
 */
async function assertProjectInviteeAllowed(access: ProjectAccess, email: string): Promise<void> {
  const [org] = await sql<{ is_personal: boolean }[]>`select is_personal from organizations where id = ${access.orgId}`;
  if (!org || org.is_personal) return;
  if (access.orgRole === "owner" || access.orgRole === "admin") return;
  const [member] = await sql<{ user_id: string }[]>`
    select om.user_id from org_memberships om join "user" u on u.id = om.user_id
    where om.org_id = ${access.orgId} and lower(u.email) = ${email.toLowerCase()} limit 1`;
  if (!member) throw new Error("Only organization owners and admins can invite people outside the organization");
}

export async function revokeProjectInvite(args: {
  projectId: string;
  userId: string;
  inviteId: string;
}): Promise<ProjectInviteRecord> {
  const access = await getProjectAccess(args.projectId, args.userId);
  if (!access) {
    throw new Error("Project not found");
  }
  if (!canManageProject(access, args.userId)) {
    throw new Error("Only project admins can invite members");
  }

  const [row] = await sql<ProjectInviteRow[]>`
    update project_invites
    set status = 'revoked'
    where id = ${args.inviteId}
      and project_id = ${args.projectId}
      and status = 'pending'
    returning
      id,
      project_id,
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
    const [existing] = await sql<ProjectInviteRow[]>`
      select
        id,
        project_id,
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
      from project_invites
      where id = ${args.inviteId}
        and project_id = ${args.projectId}
      limit 1
    `;

    if (!existing) {
      throw new Error("Project invite not found");
    }

    throw new Error(`Project invite is already ${existing.status}`);
  }

  return mapProjectInvite(row);
}

export async function acceptProjectInvite(token: string, userId: string): Promise<ProjectMemberRecord> {
  const inviteRows = await sql<ProjectInviteRow[]>`
    select
      id,
      project_id,
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
    from project_invites
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
      update project_invites
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

  try { await sql.begin(async (tx) => {
    const [org] = await tx<{ is_personal: boolean }[]>`select is_personal from organizations where id = ${invite.org_id}`;
    if (org && !org.is_personal) {
      // Team-org project access requires org membership. An outsider joins
      // as a member only if the inviter can still add people to the org.
      const [membership] = await tx`select 1 from org_memberships where org_id = ${invite.org_id} and user_id = ${userId}`;
      if (!membership) {
        const [inviter] = await tx<{ role: string }[]>`
          select role from org_memberships where org_id = ${invite.org_id} and user_id = ${invite.invited_by_user_id}`;
        if (inviter?.role !== "owner" && inviter?.role !== "admin") {
          throw new Error("This invite can no longer add you to the organization; ask an organization admin to invite you");
        }
        await admitToOrganization(tx, userId, invite.org_id);
        // Only this exact membership may already exist. A target-less ON CONFLICT would also swallow the one-organization
        // index (a concurrent join that committed first) and accept the invite without a membership.
        await tx`insert into org_memberships (org_id, user_id, role) values (${invite.org_id}, ${userId}, 'member') on conflict (org_id, user_id) do nothing`;
        await auditOrganization(tx, invite.org_id, userId, "organization.member.joined_via_project_invite", { inviteId: invite.id, projectId: invite.project_id });
      }
    }
    await tx`
      insert into project_members (project_id, user_id, role, invited_by_user_id)
      values (${invite.project_id}, ${userId}, ${invite.role}, ${invite.invited_by_user_id})
      on conflict (project_id, user_id) do update
        set role = excluded.role,
            invited_by_user_id = excluded.invited_by_user_id
    `;
    await tx`
      update project_invites
      set
        status = 'accepted',
        accepted_by_user_id = ${userId},
        accepted_at = now()
      where id = ${invite.id} and status = 'pending'
    `;
  }); } catch (error) {
    // The one-organization index refusing a join that passed the check (a race) is the policy's 409, not a 500.
    const conflict = organizationConflict(error);
    if (conflict instanceof OrganizationError && conflict.code === "user_already_in_org") throw conflict;
    throw error;
  }

  const [row] = await sql<ProjectMemberRow[]>`
    select
      wm.project_id,
      wm.user_id,
      auth_user.email,
      auth_user.name,
      wm.role,
      wm.invited_by_user_id,
      wm.created_at::text
    from project_members wm
    join "user" auth_user on auth_user.id = wm.user_id
    where wm.project_id = ${invite.project_id} and wm.user_id = ${userId}
    limit 1
  `;

  return mapProjectMember(row);
}

export interface OrganizationMfaPolicy {
  orgId: string;
  requireMfa: boolean;
  gracePeriodDays: number;
  /** When the requirement was turned on; members' grace periods start here (or when they join). */
  requireMfaSince: string | null;
  members: number;
  /** Members with TOTP 2FA on or at least one passkey. */
  membersWithMfa: number;
}

/** The org's "require MFA for members" policy, readable by any member. */
export async function getOrganizationMfaPolicy(orgId: string, userId: string): Promise<OrganizationMfaPolicy> {
  await getOrganizationAccess(orgId, userId);
  const [row] = await sql<{ require_mfa: boolean; mfa_grace_period_days: number; require_mfa_since: string | null; members: number; members_with_mfa: number }[]>`
    select o.require_mfa, o.mfa_grace_period_days, o.require_mfa_since::text,
      (select count(*)::int from org_memberships m where m.org_id = o.id) as members,
      (select count(*)::int from org_memberships m join "user" u on u.id = m.user_id
        where m.org_id = o.id and (u."twoFactorEnabled" or exists (select 1 from passkey p where p."userId" = u.id))) as members_with_mfa
    from organizations o where o.id = ${orgId}`;
  if (!row) throw new OrganizationError(404, "organization_not_found", "Organization not found");
  return { orgId, requireMfa: row.require_mfa, gracePeriodDays: row.mfa_grace_period_days, requireMfaSince: row.require_mfa_since, members: row.members, membersWithMfa: row.members_with_mfa };
}

/**
 * Turns the policy on or off (owners and admins). The admin must themselves be
 * on an MFA-verified session, so nobody can impose a requirement they could
 * not meet, and personal organizations have no members to require it of.
 */
export async function updateOrganizationMfaPolicy(orgId: string, userId: string, input: UpdateOrganizationMfaPolicyInput, session: { mfaVerified: boolean }): Promise<OrganizationMfaPolicy> {
  const parsed = updateOrganizationMfaPolicySchema.parse(input);
  await withOrganizationLock(orgId, userId, async (tx, actor, personal) => {
    if (!organizationCapabilities(actor.role).update) throw new OrganizationError(403, "organization_forbidden", "Organization admin access required");
    if (personal) throw new OrganizationError(409, "personal_organization", "Personal organizations have no members to require MFA of");
    if (!session.mfaVerified) throw new OrganizationError(403, "mfa_required", "Turn on two-factor authentication (or sign in with a passkey) before requiring it for members");
    await tx`update organizations set
        require_mfa = ${parsed.requireMfa},
        require_mfa_since = case when ${parsed.requireMfa} then coalesce(require_mfa_since, now()) else null end,
        mfa_grace_period_days = coalesce(${parsed.gracePeriodDays ?? null}::integer, mfa_grace_period_days),
        updated_at = now()
      where id = ${orgId}`;
    await auditOrganization(tx, orgId, userId, "organization.mfa_policy_updated", parsed);
  });
  return await getOrganizationMfaPolicy(orgId, userId);
}

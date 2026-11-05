import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

import { maxOrgsPerUser } from "../services/org-membership-limit.js";

/**
 * The one-organization-per-user policy (DOCSLURP_MAX_ORGS_PER_USER=1, index org_memberships_one_org_per_user): joining or
 * creating a second organization answers 409 user_already_in_org unless the user's current organization is an empty personal
 * one, which is then replaced; leaving gives the user their personal organization back; a user moved out loses access at once.
 */
vi.mock("../services/notifications.js", () => ({ sendProjectInviteEmail: vi.fn(async () => null), sendOrganizationInviteEmail: vi.fn(async () => null) }));

let sql: postgres.Sql;
let stop: () => Promise<void>;
let orgs: typeof import("../services/organizations.js");

const membershipsOf = async (userId: string) =>
  (await sql<{ org_id: string; role: string }[]>`select org_id, role from org_memberships where user_id = ${userId} order by org_id`);

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  });
  vi.doMock("../db.js", () => ({ sql, apiPool: undefined }));
  vi.doMock("../lib/auth.js", () => ({ auth: { api: { getSession: async () => null } }, appDbPool: {} }));
  orgs = await import("../services/organizations.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

let seq = 0;
async function user(name: string): Promise<string> {
  const id = `${name}-${++seq}`;
  await sql`insert into "user"(id, name, email, "emailVerified") values (${id}, ${name}, ${`${id}@example.test`}, true)`;
  return id;
}
async function team(ownerId: string): Promise<string> {
  const [{ id }] = await sql<{ id: string }[]>`select id from organizations where id = ${(await orgs.createOrganization({ userId: ownerId, name: `Team ${++seq}` })).id}`;
  return id!;
}
async function invite(orgId: string, ownerId: string, inviteeId: string) {
  const { token } = await orgs.inviteOrganizationMember(orgId, ownerId, { email: `${inviteeId}@example.test`, role: "member", expiresInDays: 7 });
  return token;
}

describe("one organization per user", () => {
  beforeEach(() => { vi.unstubAllEnvs(); });

  it("defaults to one and never widens on a malformed value", () => {
    expect(maxOrgsPerUser({})).toBe(1);
    expect(maxOrgsPerUser({ DOCSLURP_MAX_ORGS_PER_USER: "3" })).toBe(3);
    expect(maxOrgsPerUser({ DOCSLURP_MAX_ORGS_PER_USER: "0" })).toBe(1);
    expect(maxOrgsPerUser({ DOCSLURP_MAX_ORGS_PER_USER: "lots" })).toBe(1);
  });

  it("refuses a second membership row outright", async () => {
    const owner = await user("owner");
    const other = await user("other");
    const orgId = await team(owner);
    await orgs.resolveDefaultOrganization(other);
    await expect(sql`insert into org_memberships (org_id, user_id, role) values (${orgId}, ${other}, 'member')`)
      .rejects.toMatchObject({ constraint_name: "org_memberships_one_org_per_user" });
  });

  it("replaces an empty personal organization when an invite is accepted", async () => {
    const owner = await user("owner");
    const invitee = await user("invitee");
    const orgId = await team(owner);
    const personal = await orgs.resolveDefaultOrganization(invitee);
    expect(personal.isPersonal).toBe(true);
    await orgs.acceptOrganizationInvite(await invite(orgId, owner, invitee), invitee);
    expect(await membershipsOf(invitee)).toEqual([{ org_id: orgId, role: "member" }]);
    expect(await sql`select id from organizations where id = ${personal.id}`).toEqual([]);
  });

  it("answers 409 user_already_in_org when the current organization has data, and changes nothing", async () => {
    const owner = await user("owner");
    const invitee = await user("invitee");
    const orgId = await team(owner);
    const personal = await orgs.resolveDefaultOrganization(invitee);
    await sql`insert into api_keys (id, user_id, org_id, key_hash, name) values (${`k-${invitee}`}, ${invitee}, ${personal.id}, ${`h-${invitee}`}, 'n')`;
    const token = await invite(orgId, owner, invitee);
    await expect(orgs.acceptOrganizationInvite(token, invitee)).rejects.toMatchObject({ status: 409, code: "user_already_in_org" });
    expect(await membershipsOf(invitee)).toEqual([{ org_id: personal.id, role: "owner" }]);
    expect(await sql`select status from org_invites where org_id = ${orgId}`).toEqual([{ status: "pending" }]);
  });

  it("answers 409 for an invite from a team member to a member of another team", async () => {
    const ownerA = await user("owner-a");
    const ownerB = await user("owner-b");
    const orgA = await team(ownerA);
    await team(ownerB);
    await expect(orgs.acceptOrganizationInvite(await invite(orgA, ownerA, ownerB), ownerB)).rejects.toMatchObject({ status: 409, code: "user_already_in_org" });
  });

  it("refuses creating a second organization the same way, unless the current one is an empty personal one", async () => {
    const someone = await user("creator");
    const personal = await orgs.resolveDefaultOrganization(someone);
    const first = await orgs.createOrganization({ userId: someone, name: "First" });
    expect(await membershipsOf(someone)).toEqual([{ org_id: first.id, role: "owner" }]);
    expect(await sql`select id from organizations where id = ${personal.id}`).toEqual([]);
    await expect(orgs.createOrganization({ userId: someone, name: "Second" })).rejects.toMatchObject({ status: 409, code: "user_already_in_org" });
    expect(await membershipsOf(someone)).toEqual([{ org_id: first.id, role: "owner" }]);
  });

  it("answers 409 for a project invite that would add a second organization", async () => {
    const ownerA = await user("owner-a");
    const ownerB = await user("owner-b");
    const orgA = await team(ownerA);
    await team(ownerB);
    const [project] = await sql<{ id: string }[]>`select id from projects where org_id = ${orgA} and is_default`;
    await orgs.inviteProjectMember(project!.id, { userId: ownerA, email: `${ownerB}@example.test`, role: "viewer", expiresInDays: 7 });
    const [{ token }] = await sql<{ token: string }[]>`select token from project_invites where project_id = ${project!.id}`;
    await expect(orgs.acceptProjectInvite(token!, ownerB)).rejects.toMatchObject({ status: 409, code: "user_already_in_org" });
    expect(await sql`select 1 from project_members where project_id = ${project!.id} and user_id = ${ownerB}`).toEqual([]);
  });

  it("gives a member who leaves exactly one organization again: their personal one", async () => {
    const owner = await user("owner");
    const leaver = await user("leaver");
    const orgId = await team(owner);
    await orgs.acceptOrganizationInvite(await invite(orgId, owner, leaver), leaver);
    await orgs.removeOrganizationMember({ orgId, userId: leaver, memberUserId: leaver });
    const memberships = await membershipsOf(leaver);
    expect(memberships).toHaveLength(1);
    const [personal] = await sql<{ is_personal: boolean; personal_owner_user_id: string }[]>`
      select is_personal, personal_owner_user_id from organizations where id = ${memberships[0]!.org_id}`;
    expect(personal).toEqual({ is_personal: true, personal_owner_user_id: leaver });
    expect((await orgs.resolveDefaultOrganization(leaver)).id).toBe(memberships[0]!.org_id);
  });

  it("cuts a removed member off from the organization's data at once", async () => {
    const owner = await user("owner");
    const removed = await user("removed");
    const orgId = await team(owner);
    await orgs.acceptOrganizationInvite(await invite(orgId, owner, removed), removed);
    const [project] = await sql<{ id: string }[]>`select id from projects where org_id = ${orgId} and is_default`;
    await sql`update org_memberships set role = 'admin' where org_id = ${orgId} and user_id = ${removed}`;
    await sql`insert into api_keys (id, user_id, org_id, key_hash, name) values (${`k-${removed}`}, ${removed}, ${orgId}, ${`h-${removed}`}, 'n')`;
    expect(await orgs.getProjectAccess(project!.id, removed)).not.toBeNull();
    await orgs.removeOrganizationMember({ orgId, userId: owner, memberUserId: removed });
    expect(await orgs.getProjectAccess(project!.id, removed)).toBeNull();
    expect(await orgs.getOrganization(orgId, removed)).toBeNull();
    expect(await sql`select revoked_at is not null as revoked from api_keys where id = ${`k-${removed}`}`).toEqual([{ revoked: true }]);
    // The org's data stays the org's: the removed user's new organization is a fresh personal one with none of it.
    const [mine] = await membershipsOf(removed);
    expect(mine!.org_id).not.toBe(orgId);
  });
});

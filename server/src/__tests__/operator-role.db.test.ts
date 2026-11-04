import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Platform operators (ADMIN_EMAILS) are a role of their own. Being one never
 * changes a role inside a customer organization, and the operator-only run
 * diagnostics (worker CPU/RAM, regions) are removed on the server for everyone
 * else, including that organization's owners and admins.
 */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let orgs: typeof import("../services/organizations.js");
let adminEmails: typeof import("../lib/admin-emails.js");

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/auth.js", () => ({ auth: { api: { getSession: async () => null } }, appDbPool: {} }));
  await sql`insert into "user"(id, name, email, "emailVerified") values
    ('owner', 'Owner', 'owner@customer.example', true),
    ('ops', 'Ops', 'ops@example.com', true),
    ('ops-unverified', 'Ops2', 'ops2@example.com', false)`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('customer', 'Customer', 'customer', 'owner')`;
  await sql`insert into org_memberships(org_id, user_id, role) values
    ('customer', 'owner', 'owner'), ('customer', 'ops', 'member'), ('customer', 'ops-unverified', 'member')`;
  await sql`insert into workspaces(id, org_id, user_id, name, is_default) values
    ('customer-default', 'customer', 'owner', 'Default', true), ('customer-private', 'customer', 'owner', 'Private', false)`;
  orgs = await import("../services/organizations.js");
  adminEmails = await import("../lib/admin-emails.js");
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

describe("operator is separate from customer roles", () => {
  it("recognizes only verified ADMIN_EMAILS identities", async () => {
    vi.stubEnv("ADMIN_EMAILS", "ops@example.com,ops2@example.com");
    expect(await adminEmails.isConfiguredAdminUserSql(sql as never, "ops")).toBe(true);
    expect(await adminEmails.isConfiguredAdminUserSql(sql as never, "ops-unverified")).toBe(false);
    expect(await adminEmails.isConfiguredAdminUserSql(sql as never, "owner")).toBe(false);
    vi.unstubAllEnvs();
  });

  it("leaves an operator's membership in a customer org untouched and gives no access to its private workspaces", async () => {
    vi.stubEnv("ADMIN_EMAILS", "ops@example.com");
    expect(await adminEmails.isConfiguredAdminUserSql(sql as never, "ops")).toBe(true);
    const [membership] = await sql<{ role: string }[]>`select role from org_memberships where org_id = 'customer' and user_id = 'ops'`;
    expect(membership!.role).toBe("member");
    expect(await orgs.getWorkspaceAccess("customer-private", "ops")).toBeNull();
    expect(await orgs.getWorkspaceAccess("customer-default", "ops")).toMatchObject({ orgRole: "member" });
    vi.unstubAllEnvs();
  });
});

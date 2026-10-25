import postgres from "postgres";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/** `PATCH /v1/organizations/:id { allowChinaProviders }` and the request policy OpenRouter calls read. */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let orgs: typeof import("../services/organizations.js");
let policy: typeof import("../lib/provider-policy.js");
let context: typeof import("../lib/request-context.js");

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {}, types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } } }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x'), ('u2', 'B', 'b@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('open', 'Open', 'open', 'u1'), ('closed', 'Closed', 'closed', 'u1')`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('open', 'u1', 'owner'), ('closed', 'u1', 'owner'), ('open', 'u2', 'owner')`;
  orgs = await import("../services/organizations.js");
  policy = await import("../lib/provider-policy.js");
  context = await import("../lib/request-context.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

/** The policy as a request acting as `userId` (and in `orgId`, when set) sees it. */
async function policyFor(userId: string, orgId?: string) {
  const app = new Hono().use("*", context.requestContextMiddleware).get("/", async (c) => {
    context.setCurrentRequestUserId(userId);
    context.setCurrentRequestOrgId(orgId);
    return c.json(await policy.requestProviderPolicy() ?? null);
  });
  return await (await app.request("/")).json();
}

describe("organization allowChinaProviders", () => {
  it("defaults to allowed and is stored when an admin turns it off", async () => {
    expect((await orgs.getOrganization("closed", "u1"))!.allowChinaProviders).toBe(true);
    await orgs.updateOrganization("closed", "u1", { allowChinaProviders: false });
    expect((await orgs.getOrganization("closed", "u1"))!.allowChinaProviders).toBe(false);
    expect((await orgs.listOrganizations("u1")).find((org) => org.id === "open")).toMatchObject({ allowChinaProviders: true });
  });

  it("applies the request's org setting, and restricts a request without one if any of the user's orgs is restricted", async () => {
    expect(await policyFor("u1", "open")).toEqual({ allowChinaProviders: true });
    expect(await policyFor("u1", "closed")).toEqual({ allowChinaProviders: false });
    expect(await policyFor("u1")).toEqual({ allowChinaProviders: false });
    expect(await policyFor("u2")).toEqual({ allowChinaProviders: true });
  });

  it("applies a changed setting at once on this instance", async () => {
    await orgs.updateOrganization("closed", "u1", { allowChinaProviders: true });
    expect(await policyFor("u1", "closed")).toEqual({ allowChinaProviders: true });
    expect(await policyFor("u1")).toEqual({ allowChinaProviders: true });
  });
});

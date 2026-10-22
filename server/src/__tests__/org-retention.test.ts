import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/** `PATCH /v1/organizations/:id { retainDocumentVersions }`: open to every org (archived versions bill as storage). */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let orgs: typeof import("../services/organizations.js");

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {}, types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } } }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('starter', 'Starter', 'starter', 'u1'), ('funded', 'Funded', 'funded', 'u1')`;
  await sql`update organizations set funded_at = now() where id = 'funded'`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('starter', 'u1', 'owner'), ('funded', 'u1', 'owner')`;
  orgs = await import("../services/organizations.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

describe("organization retainDocumentVersions", () => {
  it("accepts the setting for a starter org while billing is enforced (no plan gate)", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    await expect(orgs.updateOrganization("starter", "u1", { retainDocumentVersions: 3 })).resolves.toBeTruthy();
    expect((await orgs.getOrganization("starter", "u1"))!.retainDocumentVersions).toBe(3);
    await orgs.updateOrganization("starter", "u1", { retainDocumentVersions: null });
    vi.unstubAllEnvs();
  });

  it("stores the setting and lists it with the funded flag", async () => {
    await orgs.updateOrganization("funded", "u1", { retainDocumentVersions: 5 });
    const listed = (await orgs.listOrganizations("u1")).find((org) => org.id === "funded");
    expect(listed).toMatchObject({ retainDocumentVersions: 5, funded: true });
    expect((await orgs.listOrganizations("u1")).find((org) => org.id === "starter")).toMatchObject({ funded: false });
    await orgs.updateOrganization("funded", "u1", { retainDocumentVersions: null });
    expect((await orgs.getOrganization("funded", "u1"))!.retainDocumentVersions).toBeNull();
  });
});

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/** `PATCH /v1/organizations/:id { retainDocumentVersions }`: paid plans only; free gets 402 upgrade_required. */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let orgs: typeof import("../services/organizations.js");

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {}, types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } } }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, plan_id) values ('free', 'Free', 'free', 'u1', 'free'), ('paid', 'Paid', 'paid', 'u1', 'silver')`;
  await sql`insert into org_memberships(org_id, user_id, role) values ('free', 'u1', 'owner'), ('paid', 'u1', 'owner')`;
  orgs = await import("../services/organizations.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

describe("organization retainDocumentVersions", () => {
  it("rejects a free org with 402 upgrade_required", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_x");
    await expect(orgs.updateOrganization("free", "u1", { retainDocumentVersions: 3 })).rejects.toMatchObject({ status: 402, code: "upgrade_required" });
  });

  it("honours the setting on a free org when billing is not enforced", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    await expect(orgs.updateOrganization("free", "u1", { retainDocumentVersions: 3 })).resolves.toBeTruthy();
    expect((await orgs.getOrganization("free", "u1"))!.retainDocumentVersions).toBe(3);
    await orgs.updateOrganization("free", "u1", { retainDocumentVersions: null });
  });

  it("stores the setting for a paid org and lists it with the plan", async () => {
    await orgs.updateOrganization("paid", "u1", { retainDocumentVersions: 5 });
    const listed = (await orgs.listOrganizations("u1")).find((org) => org.id === "paid");
    expect(listed).toMatchObject({ retainDocumentVersions: 5, planId: "silver" });
    await orgs.updateOrganization("paid", "u1", { retainDocumentVersions: null });
    expect((await orgs.getOrganization("paid", "u1"))!.retainDocumentVersions).toBeNull();
  });

  it("lets a free org clear the setting", async () => {
    await expect(orgs.updateOrganization("free", "u1", { retainDocumentVersions: null })).resolves.toBeTruthy();
  });
});

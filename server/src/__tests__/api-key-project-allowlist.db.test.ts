import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * A key's project allowlist may name only projects its owner can see under the one rule (docslurp_project_access,
 * migration 0124): the projects of the key's organization the owner created, was added to, administers, or that is the
 * organization's default. Never another organization's, and never a private one the owner cannot read.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let keys: typeof import("../services/api-keys.js");

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, {
    max: 1, prepare: false, onnotice: () => {},
    types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
  }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('owner', 'O', 'o@x'), ('member', 'M', 'm@x'), ('admin', 'A', 'a@x'), ('stranger', 'S', 's@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('team', 'Team', 'team', 'owner'), ('other', 'Other', 'other', 'stranger')`;
  await sql`insert into org_memberships(org_id, user_id, role) values
    ('team', 'owner', 'owner'), ('team', 'member', 'member'), ('team', 'admin', 'admin'), ('other', 'stranger', 'owner')`;
  await sql`insert into projects(id, org_id, user_id, name, is_default) values
    ('ws-default', 'team', 'owner', 'Default', true), ('ws-private', 'team', 'owner', 'Private', false),
    ('ws-shared', 'team', 'owner', 'Shared', false), ('ws-foreign', 'other', 'stranger', 'Foreign', true)`;
  await sql`insert into project_members(project_id, user_id, role) values ('ws-shared', 'member', 'viewer')`;
  keys = await import("../services/api-keys.js");
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

const create = (userId: string, projectIds: string[], orgId = "team") => keys.createApiKey(userId, "k", { orgId, projectIds, scopes: ["search"] });

describe("API key project allowlist", () => {
  it("accepts the default project, one the member was added to, and any project for an admin", async () => {
    expect((await create("member", ["ws-default", "ws-shared"])).key.projectIds).toEqual(["ws-default", "ws-shared"]);
    expect((await create("admin", ["ws-private"])).key.projectIds).toEqual(["ws-private"]);
    expect((await create("owner", ["ws-private"])).key.projectIds).toEqual(["ws-private"]);
  });

  it("refuses a private project the member cannot read, naming no other project", async () => {
    await expect(create("member", ["ws-default", "ws-private"])).rejects.toMatchObject({ status: 400, code: "invalid_key_projects", message: expect.stringContaining("ws-private") });
  });

  it("refuses another organization's project, even for someone who can read it there", async () => {
    await expect(create("owner", ["ws-foreign"])).rejects.toMatchObject({ code: "invalid_key_projects" });
    await expect(create("stranger", ["ws-foreign"], "team")).rejects.toBeDefined();
  });

  it("applies the same rule when the allowlist is edited, and after the member lost access", async () => {
    const { key } = await create("member", ["ws-shared"]);
    await expect(keys.updateApiKey(key.id, "member", { projectIds: ["ws-private"] })).rejects.toMatchObject({ code: "invalid_key_projects" });
    await sql`delete from project_members where project_id = 'ws-shared' and user_id = 'member'`;
    await expect(keys.updateApiKey(key.id, "member", { projectIds: ["ws-shared"] })).rejects.toMatchObject({ code: "invalid_key_projects" });
    await sql`insert into project_members(project_id, user_id, role) values ('ws-shared', 'member', 'viewer')`;
  });
});

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseProjectInput } from "@docslurp/shared";
import { startMigratedPostgres } from "@docslurp/worker/testing";
import { LIFT_ONE_ORG_PER_USER_POLICY } from "./helpers/multi-org.js";

vi.mock("../lib/auth.js", () => ({ appDbPool: { query: vi.fn() }, auth: { api: { getSession: vi.fn() } } }));

let sql: postgres.Sql;
let stop: () => Promise<void>;
let projects: typeof import("../services/projects.js");
let actors: typeof import("../lib/request-actor.js");
let legalId: string;

/** The `project` request value as the routes see it: parsed, then looked up in the caller's scope. */
async function find(value: string, scope: { userId: string; orgId?: string | null; allowedProjectIds?: string[] }) {
  const ref = parseProjectInput(value);
  if (ref.kind !== "id" && ref.kind !== "slug") throw new Error(`not a lookup: ${ref.kind}`);
  return (await projects.findProjectForInput(ref, scope))?.id ?? null;
}

beforeAll(async () => {
  const database = await startMigratedPostgres();
  await database.db.exec(LIFT_ONE_ORG_PER_USER_POLICY);
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user" (id, name, email) values ('alice', 'Alice', 'alice@example.test'), ('bob', 'Bob', 'bob@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('org-a', 'Org A', 'org-a', 'alice'), ('org-b', 'Org B', 'org-b', 'bob')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('org-a', 'alice', 'owner'), ('org-b', 'bob', 'owner')`;
  projects = await import("../services/projects.js");
  actors = await import("../lib/request-actor.js");
  // An upload naming "Legal Contracts" creates the project with the name as typed and its slug.
  const ref = parseProjectInput("Legal Contracts");
  if (ref.kind !== "slug") throw new Error("expected a slug");
  legalId = (await projects.createProject({ userId: "alice", orgId: "org-a", name: ref.name, slug: ref.slug })).id;
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

describe("project input resolution", () => {
  it("creates the named project with the slug of its name", async () => {
    const [row] = await sql<{ name: string; slug: string }[]>`select name, slug from projects where id = ${legalId}`;
    expect(row).toEqual({ name: "Legal Contracts", slug: "legal-contracts" });
  });

  it("finds a project by UUID, exact slug, name and differently formatted name", async () => {
    const alice = { userId: "alice", orgId: "org-a" };
    for (const value of [legalId, legalId.toUpperCase(), "legal-contracts", "Legal Contracts", "  Légal—Contracts!! ", "LEGAL CONTRACTS"]) {
      expect(await find(value, alice)).toBe(legalId);
    }
    expect(await find("legal-contracts", { userId: "alice" })).toBe(legalId);
  });

  it("keeps resolving a former slug after a rename", async () => {
    await sql`update projects set slug = 'contracts-legal' where id = ${legalId}`;
    try {
      expect(await find("Legal Contracts", { userId: "alice", orgId: "org-a" })).toBe(legalId);
      expect(await find("contracts-legal", { userId: "alice", orgId: "org-a" })).toBe(legalId);
    } finally {
      await sql`update projects set slug = 'legal-contracts' where id = ${legalId}`;
    }
  });

  it("returns nothing for an unknown slug or UUID", async () => {
    expect(await find("Unknown Project", { userId: "alice", orgId: "org-a" })).toBeNull();
    expect(await find("00000000-0000-4000-8000-00000000dead", { userId: "alice", orgId: "org-a" })).toBeNull();
  });

  it("never resolves another organization's project, and creating the same name there gets its own slug", async () => {
    const bob = { userId: "bob", orgId: "org-b" };
    expect(await find("Legal Contracts", bob)).toBeNull();
    expect(await find(legalId, bob)).toBeNull();
    expect(await find("Legal Contracts", { userId: "alice", orgId: "org-b" })).toBeNull();

    const created = await projects.createProject({ userId: "bob", orgId: "org-b", name: "Legal Contracts", slug: "legal-contracts" });
    expect(created.slug).toMatch(/^legal-contracts-[0-9a-f]{6}$/);
    // The name keeps finding Bob's project even though the plain slug belongs to Alice's.
    expect(await find("Legal Contracts", bob)).toBe(created.id);
    expect(await find("legal-contracts", bob)).toBe(created.id);
    expect(await find("Legal Contracts", { userId: "alice", orgId: "org-a" })).toBe(legalId);
  });

  it("only resolves projects inside an API key's allowlist", async () => {
    const other = await projects.createProject({ userId: "alice", orgId: "org-a", name: "Other Work", slug: "other-work" });
    expect(await find("Legal Contracts", { userId: "alice", orgId: "org-a", allowedProjectIds: [other.id] })).toBeNull();
    expect(await find(legalId, { userId: "alice", orgId: "org-a", allowedProjectIds: [other.id] })).toBeNull();
    expect(await find("Other Work", { userId: "alice", orgId: "org-a", allowedProjectIds: [other.id] })).toBe(other.id);
  });

  it("generates a slug when the preferred one is reserved or too short", async () => {
    const reserved = await projects.createProject({ userId: "alice", orgId: "org-a", name: "Settings", slug: "settings" });
    expect(reserved.slug).not.toBe("settings");
    const short = await projects.createProject({ userId: "alice", orgId: "org-a", name: "HR", slug: "hr" });
    expect(short.slug).not.toBe("hr");
    // Still reachable by name.
    expect(await find("HR", { userId: "alice", orgId: "org-a" })).toBe(short.id);
  });
});

describe("project names that exist in more than one of the caller's organizations", () => {
  it("answers 409 instead of picking one, and resolves once the organization is named", async () => {
    await sql`insert into organizations (id, name, slug, created_by_user_id) values ('org-c', 'Org C', 'org-c', 'alice')`;
    await sql`insert into org_memberships (org_id, user_id, role) values ('org-c', 'alice', 'owner')`;
    const inA = await projects.createProject({ userId: "alice", orgId: "org-a", name: "Contracts", slug: "contracts" });
    const inC = await projects.createProject({ userId: "alice", orgId: "org-c", name: "Contracts", slug: "contracts" });
    // Without an organization neither the slug owner nor the oldest match wins.
    await expect(find("Contracts", { userId: "alice" })).rejects.toMatchObject({ status: 409, code: "project_ambiguous" });
    await expect(find("contracts", { userId: "alice" })).rejects.toMatchObject({ status: 409, code: "project_ambiguous" });
    expect(await find("Contracts", { userId: "alice", orgId: "org-a" })).toBe(inA.id);
    expect(await find("Contracts", { userId: "alice", orgId: "org-c" })).toBe(inC.id);
    // A UUID is never ambiguous.
    expect(await find(inC.id, { userId: "alice" })).toBe(inC.id);
  });

  it("does not count organizations the caller cannot use, and never reveals them", async () => {
    // Bob's org-b also has "Legal Contracts"; Alice is not a member, so her lookup is not ambiguous.
    expect(await find("Legal Contracts", { userId: "alice" })).toBe(legalId);
    // A key allowlist narrows the candidates before ambiguity is judged.
    const inC = (await projects.listProjects("alice")).find((project) => project.orgId === "org-c" && project.name === "Contracts")!;
    expect(await find("Contracts", { userId: "alice", allowedProjectIds: [inC.id] })).toBe(inC.id);
  });
});

describe("request actor project boundary", () => {
  const session = { type: "session" as const, userId: "alice", sessionId: "s", user: { id: "alice", email: "alice@example.test", name: "Alice" } };
  const key = (projectIds: string[]) => ({
    type: "apiKey" as const, userId: "alice",
    apiKey: { keyId: "k", userId: "alice", orgId: "org-a", keyType: "server" as const, allowedDomains: [], scopes: ["search"], rateLimitRpm: 60, rateLimitPpd: 1000, rateLimits: [], projectIds },
  });

  it("resolves names for sessions and keys and answers 404 naming the slug it looked for", async () => {
    expect(await actors.resolveActorProjectId(session, "Legal Contracts", "org-a")).toBe(legalId);
    expect(await actors.resolveActorProjectId(key([]), "legal contracts")).toBe(legalId);
    const missing = await actors.resolveActorProjectId(session, "Missing Board!", "org-a").catch((error: unknown) => error);
    expect(missing).toMatchObject({ status: 404, code: "project_not_found", details: { projectSlug: "missing-board" } });
    expect((missing as Error).message).toContain('"missing-board"');
  });

  it("rejects a value with no letters or digits with 400", async () => {
    await expect(actors.resolveActorProjectId(session, "!!!")).rejects.toMatchObject({ status: 400, code: "invalid_request" });
  });

  it("keeps a restricted key inside its allowlist", async () => {
    const other = (await projects.listProjects("alice")).find((project) => project.slug === "other-work")!;
    await expect(actors.resolveActorProjectId(key([other.id]), "Legal Contracts")).rejects.toMatchObject({ status: 404 });
    expect(await actors.resolveActorProjectId(key([other.id]), "Other Work")).toBe(other.id);
  });

  it("uses the default project when the value is omitted or \"default\"", async () => {
    const fallback = await actors.resolveActorProjectId(session, undefined, "org-a");
    expect(await actors.resolveActorProjectId(session, "Default", "org-a")).toBe(fallback);
    const [row] = await sql<{ is_default: boolean; org_id: string }[]>`select is_default, org_id from projects where id = ${fallback}`;
    expect(row).toEqual({ is_default: true, org_id: "org-a" });
  });
});

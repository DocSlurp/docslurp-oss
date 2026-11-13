import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

import type { SearchAccessScope } from "../search/access-scope.js";
import type { ApiKeyRequestActor, SessionRequestActor } from "../lib/request-actor.js";

/**
 * The explicit search access scope (search/access-scope.ts) on a migrated database: the search module and the chat
 * turn read a project only inside the scope's org and allowlist, refuse without a scope, and the route-side
 * authorization (lib/search-access.ts) builds the scope from the actor in one access read.
 *
 * Tenants: org A (team org, user `u` owner) holds `pa` and `pa2`; org B is `v`'s personal org holding `pb`, shared
 * with `u` directly (project_members), so `u` can read `pb` through the share.
 */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let setup: typeof import("../search/session-setup.js");
let access: typeof import("../search/access-scope.js");
let searchAccess: typeof import("../lib/search-access.js");
let search: typeof import("../services/search.js");
let chat: typeof import("../services/project-chat.js");
let turnContext: typeof import("../services/chat-turn-context.js");

const scopeA: SearchAccessScope = { orgId: "org-a", projectIds: "org", modeCeiling: null };
const session: SessionRequestActor = { type: "session", userId: "u", sessionId: "s", user: { id: "u", email: "u@example.test", name: "U" } };
function key(overrides: Partial<ApiKeyRequestActor["apiKey"]> = {}): ApiKeyRequestActor {
  return {
    type: "apiKey", userId: "u",
    apiKey: { keyId: "k", userId: "u", orgId: "org-a", keyType: "server", allowedDomains: [], scopes: ["search:deep", "chat"],
      rateLimitRpm: null, rateLimitPpd: 0, rateLimits: [], projectIds: [], ...overrides },
  };
}

beforeAll(async () => {
  const database = await startMigratedPostgres();
  stop = database.stop;
  sql = postgres(database.url, { max: 1, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../lib/auth.js", () => ({ auth: { api: { getSession: async () => null } }, appDbPool: {} }));
  setup = await import("../search/session-setup.js");
  access = await import("../search/access-scope.js");
  searchAccess = await import("../lib/search-access.js");
  search = await import("../services/search.js");
  chat = await import("../services/project-chat.js");
  turnContext = await import("../services/chat-turn-context.js");
  await sql`insert into "user" (id, name, email) values ('u', 'U', 'u@example.test'), ('v', 'V', 'v@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id, is_personal, personal_owner_user_id) values
    ('org-a', 'A', 'scope-a', 'u', false, null), ('org-b', 'B', 'scope-b', 'v', true, 'v')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('org-a', 'u', 'owner'), ('org-b', 'v', 'owner')`;
  await sql`insert into projects (id, org_id, user_id, name) values
    ('pa', 'org-a', 'u', 'Alpha'), ('pa2', 'org-a', 'u', 'Alpha two'), ('pb', 'org-b', 'v', 'Beta')`;
  await sql`insert into project_members (project_id, user_id, role) values ('pb', 'u', 'viewer')`;
  await sql`insert into project_runs (id, org_id, user_id, project_id, kind, status, stage, pipeline)
    values ('run-b', 'org-b', 'v', 'pb', 'bulk-upload', 'completed', 'completed', '{}')`;
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });

describe("search module scope checks", () => {
  it("reads a project inside the scope", async () => {
    const context = await setup.loadSearchProjectContext("pa", "u", scopeA);
    expect(context.scope).toEqual({ projectId: "pa", orgId: "org-a" });
    expect(context.project.name).toBe("Alpha");
  });

  it("refuses a project in another org even though the user reaches it through a share", async () => {
    // The share is real: inside its own org's scope the same user reads it.
    await expect(setup.loadSearchProjectContext("pb", "u", { orgId: "org-b", projectIds: "org", modeCeiling: null })).resolves.toBeTruthy();
    await expect(setup.loadSearchProjectContext("pb", "u", scopeA)).rejects.toBeInstanceOf(setup.ProjectNotFoundError);
    // The non-native path (separate scope query) and run-scoped searches apply the same org rule.
    await expect(setup.resolveSearchSetup("u", { filters: { projectId: "pb" } }, scopeA)).rejects.toBeInstanceOf(setup.ProjectNotFoundError);
    await expect(setup.resolveSearchSetup("u", { runId: "run-b" }, scopeA)).rejects.toBeInstanceOf(setup.ProjectNotFoundError);
  });

  it("refuses a project the scope's allowlist excludes, and an empty allowlist reaches nothing", async () => {
    await expect(setup.loadSearchProjectContext("pa", "u", { ...scopeA, projectIds: ["pa2"] })).rejects.toBeInstanceOf(setup.ProjectNotFoundError);
    await expect(setup.loadSearchProjectContext("pa", "u", { ...scopeA, projectIds: [] })).rejects.toBeInstanceOf(setup.ProjectNotFoundError);
    await expect(setup.loadSearchProjectContext("pa2", "u", { ...scopeA, projectIds: ["pa2"] })).resolves.toBeTruthy();
  });

  it("refuses a search or a chat turn with no scope before reading or writing anything", async () => {
    await expect(setup.loadSearchProjectContext("pa", "u", undefined as never)).rejects.toBeInstanceOf(access.MissingSearchAccessScopeError);
    await expect(setup.resolveSearchSetup("u", { filters: { projectId: "pa" } }, undefined as never)).rejects.toBeInstanceOf(access.MissingSearchAccessScopeError);
    await expect(search.hybridSearch("pump", "u", { filters: { projectId: "pa" } }, undefined as never)).rejects.toBeInstanceOf(access.MissingSearchAccessScopeError);
    // Malformed scopes are refused too: an empty org, or a non-list allowlist.
    await expect(search.hybridSearch("pump", "u", { filters: { projectId: "pa" } }, { orgId: "", projectIds: "org", modeCeiling: null })).rejects.toBeInstanceOf(access.MissingSearchAccessScopeError);
    await expect(search.hybridSearch("pump", "u", { filters: { projectId: "pa" } }, { orgId: "org-a", projectIds: null as never, modeCeiling: null })).rejects.toBeInstanceOf(access.MissingSearchAccessScopeError);
    await expect(chat.chatProject({ projectId: "pa", userId: "u", query: "hello" } as never)).rejects.toBeInstanceOf(access.MissingSearchAccessScopeError);
    expect(await sql`select id from chat_sessions`).toEqual([]);
    expect(await sql`select id from search_sessions`).toEqual([]);
  });

  it("a chat turn outside the scope is not found, and creates no session", async () => {
    await expect(chat.chatProject({ projectId: "pb", userId: "u", query: "hello", scope: scopeA })).rejects.toBeInstanceOf(setup.ProjectNotFoundError);
    await expect(chat.chatProject({ projectId: "pa", userId: "u", query: "hello", scope: { ...scopeA, projectIds: ["pa2"] } })).rejects.toBeInstanceOf(setup.ProjectNotFoundError);
    expect(await sql`select id from chat_sessions`).toEqual([]);
  });

  it("the chat turn context is one read of name, prompt, pipeline and settings, without renaming the project", async () => {
    await sql`update projects set system_prompt = 'Be brief.' where id = 'pa'`;
    const context = await turnContext.loadChatTurnContext("pa", "u", scopeA);
    expect(context).toMatchObject({ projectId: "pa", orgId: "org-a", name: "Alpha", systemPrompt: "Be brief.", privacyMode: "standard" });
    expect(context.settings.chat.enabled).not.toBe(false);
  });
});

describe("route-side authorization (one access read)", () => {
  it("a session gets the project's org as its scope, including a project shared from another org", async () => {
    const own = await searchAccess.authorizeActorProjectSearch(session, "pa", "search");
    expect(own).toMatchObject({ ok: true, scope: { orgId: "org-a", projectIds: "org", modeCeiling: null }, access: { projectId: "pa", orgId: "org-a" } });
    const shared = await searchAccess.authorizeActorProjectSearch(session, "pb", "chat");
    expect(shared).toMatchObject({ ok: true, scope: { orgId: "org-b" } });
  });

  it("an API key never reaches a project outside its org, even one its owner reaches through a share", async () => {
    expect(await searchAccess.authorizeActorProjectSearch(key(), "pb", "search")).toEqual({ ok: false, status: 404 });
    expect(await searchAccess.authorizeActorProjectSearch(key(), "pa", "search")).toMatchObject({ ok: true, scope: { orgId: "org-a", projectIds: "org", modeCeiling: "deep" } });
  });

  it("a key allowlist that excludes the project, or a browser key with none, is refused", async () => {
    expect(await searchAccess.authorizeActorProjectSearch(key({ projectIds: ["pa2"] }), "pa", "search")).toEqual({ ok: false, status: 404 });
    expect(await searchAccess.authorizeActorProjectSearch(key({ keyType: "client", projectIds: [] }), "pa", "search")).toEqual({ ok: false, status: 404 });
    expect(await searchAccess.authorizeActorProjectSearch(key({ projectIds: ["pa2"] }), "pa2", "search")).toMatchObject({ ok: true, scope: { projectIds: ["pa2"] } });
  });

  it("a key without the needed scope is a 403, and the key's search mode becomes the scope's ceiling", async () => {
    expect(await searchAccess.authorizeActorProjectSearch(key({ scopes: ["search:deep"] }), "pa", "chat")).toEqual({ ok: false, status: 403 });
    expect(await searchAccess.authorizeActorProjectSearch(key({ scopes: ["chat"] }), "pa", "search")).toEqual({ ok: false, status: 403 });
    expect(await searchAccess.authorizeActorProjectSearch(key({ scopes: ["search:keyword"] }), "pa", "search")).toMatchObject({ ok: true, scope: { modeCeiling: "keyword" } });
  });

  it("a key whose org no longer matches (moved or revoked org binding) is refused", async () => {
    expect(await searchAccess.authorizeActorProjectSearch(key({ orgId: "org-b" }), "pa", "search")).toEqual({ ok: false, status: 404 });
    expect(await searchAccess.authorizeActorProjectSearch(key({ orgId: null as never }), "pa", "search")).toEqual({ ok: false, status: 404 });
  });

  it("an unknown project is a 404", async () => {
    expect(await searchAccess.authorizeActorProjectSearch(session, "missing", "search")).toEqual({ ok: false, status: 404 });
  });
});

import postgres from "postgres";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Full routes on a migrated database with real api_keys rows (revoked ones
 * included): chat completions, MCP and the Algolia shim, mounted as server.ts
 * mounts them behind their body limits. For each refused credential the body
 * budget charges the public pool, and usage is recorded only by the route's
 * own auth, at most once.
 */
let sql: postgres.Sql;
let stop: () => Promise<void>;
let app: Hono;
const recordApiKeyRequest = vi.fn();
const owners: Array<{ orgId: string | null; keyId: string } | null> = [];
let bufferedBodyBytes: typeof import("../lib/bounded-body-limit.js").bufferedBodyBytes;

const KEYS = {
  chat: "dslp_priv_chat_0000000000000000000000000000",
  searchOnly: "dslp_priv_search_00000000000000000000000000",
  manage: "dslp_priv_manage_00000000000000000000000000",
  revoked: "dslp_priv_revoked_0000000000000000000000000",
  browser: "dslp_pub_browser_00000000000000000000000000",
};
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");

beforeAll(async () => {
  const db = await startMigratedPostgres();
  stop = db.stop;
  sql = postgres(db.url, { max: 4, prepare: false, onnotice: () => {} });
  vi.doMock("../db.js", () => ({ sql }));
  vi.doMock("../services/api-key-usage.js", async (importOriginal) => ({
    ...await importOriginal<typeof import("../services/api-key-usage.js")>(), recordApiKeyRequest,
  }));
  await sql`insert into "user" (id, name, email) values ('u', 'U', 'budget-routes@example.test')`;
  await sql`insert into organizations (id, name, slug, created_by_user_id) values ('o', 'O', 'budget-routes', 'u')`;
  await sql`insert into org_memberships (org_id, user_id, role) values ('o', 'u', 'owner')`;
  await sql`insert into projects (id, org_id, user_id, name) values ('w', 'o', 'u', 'W')`;
  const key = (id: string, raw: string, type: string, scopes: string[], extra: { revoked?: boolean; domains?: string[]; projects?: string[] } = {}) => sql`
    insert into api_keys (id, user_id, org_id, key_hash, name, key_type, scopes, allowed_domains, project_ids, revoked_at)
    values (${id}, 'u', 'o', ${hash(raw)}, ${id}, ${type}, ${sql.array(scopes)}, ${sql.array(extra.domains ?? [])}, ${sql.array(extra.projects ?? [])},
      ${extra.revoked ? new Date() : null})`;
  await key("k-chat", KEYS.chat, "server", ["chat", "search:deep"]);
  await key("k-search", KEYS.searchOnly, "server", ["search:deep"]);
  await key("k-manage", KEYS.manage, "server", ["search:deep", "projects:manage"]);
  await key("k-revoked", KEYS.revoked, "server", ["chat", "search:deep", "projects:manage"], { revoked: true });
  await key("k-browser", KEYS.browser, "client", ["search:deep", "chat"], { domains: ["https://shop.example.com"], projects: ["w"] });

  const { requestContextMiddleware } = await import("../lib/request-context.js");
  const { nativeBodyLimit } = await import("../lib/api-error.js");
  const { v1BodyLimit } = await import("../lib/v1-body-limit.js");
  const { registerBodyBudgetCredentialResolver } = await import("../lib/body-budget-owner.js");
  const { verifyBodyBudgetCredential } = await import("../lib/body-budget-credentials.js");
  const { chatCompletionsRoutes } = await import("../routes/chat-completions.js");
  const { mcpRoutes } = await import("../routes/mcp.js");
  const { algoliaCompatRoutes } = await import("../routes/algolia-compat.js");
  ({ bufferedBodyBytes } = await import("../lib/bounded-body-limit.js"));
  // Record what the budget charged each request to.
  registerBodyBudgetCredentialResolver(async (c) => {
    const owner = await verifyBodyBudgetCredential(c);
    owners.push(owner);
    return owner;
  });
  app = new Hono();
  app.use("*", requestContextMiddleware);
  app.use("/v1/mcp", nativeBodyLimit(1024 * 1024));
  app.use("/v1/*", v1BodyLimit({ maxMultipartUploadBytes: 25 * 1024 * 1024 }));
  app.use("/compat/algolia/*", nativeBodyLimit(256 * 1024));
  app.route("/v1", chatCompletionsRoutes);
  app.route("/v1/mcp", mcpRoutes);
  app.route("/compat/algolia", algoliaCompatRoutes);
}, 120_000);
afterAll(async () => { await sql?.end(); await stop?.(); });
beforeEach(() => { owners.length = 0; recordApiKeyRequest.mockClear(); });

const post = (path: string, headers: Record<string, string>, body: unknown = {}, method = "POST") =>
  app.request(path, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
const bearer = (raw: string) => ({ Authorization: `Bearer ${raw}` });

describe("refused credentials are charged as public, with usage recorded only by the route's own auth", () => {
  it("chat completions: a key without chat (usage once, by the route) and a revoked key (no usage)", async () => {
    const chatBody = { model: "project:default", messages: [{ role: "user", content: "hi" }] };
    expect((await post("/v1/chat/completions", bearer(KEYS.searchOnly), chatBody)).status).toBe(403);
    expect(owners).toEqual([null]);
    expect(recordApiKeyRequest).toHaveBeenCalledTimes(1);
    owners.length = 0; recordApiKeyRequest.mockClear();
    expect((await post("/v1/chat/completions", bearer(KEYS.revoked), chatBody)).status).toBe(401);
    expect(owners).toEqual([null]);
    expect(recordApiKeyRequest).not.toHaveBeenCalled();
  });

  it("MCP: a browser key and a revoked key are public and record no usage", async () => {
    const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const mcpHeaders = { accept: "application/json, text/event-stream" };
    expect((await post("/v1/mcp", { ...mcpHeaders, ...bearer(KEYS.browser), origin: "https://shop.example.com" }, rpc)).status).toBe(403);
    expect((await post("/v1/mcp", { ...mcpHeaders, ...bearer(KEYS.revoked) }, rpc)).status).toBe(401);
    expect(owners).toEqual([null, null]);
    expect(recordApiKeyRequest).not.toHaveBeenCalled();
  });

  it("Algolia: no search scope on query, a search key on a settings write, a revoked key; a search key is charged", async () => {
    const chatOnly = "dslp_priv_chatonly_000000000000000000000000";
    await sql`insert into api_keys (id, user_id, org_id, key_hash, name, key_type, scopes) values ('k-chatonly', 'u', 'o', ${hash(chatOnly)}, 'chat only', 'server', ${sql.array(["chat"])})`;
    expect((await post("/compat/algolia/1/indexes/w/query", { "X-Algolia-API-Key": chatOnly }, { query: "a" })).status).toBe(403);
    expect((await post("/compat/algolia/1/indexes/w/settings", { "X-Algolia-API-Key": KEYS.searchOnly }, { searchableAttributes: [] }, "PUT")).status).toBe(403);
    expect((await post("/compat/algolia/1/indexes/w/query", { "X-Algolia-API-Key": KEYS.revoked }, { query: "a" })).status).toBe(403);
    expect(owners).toEqual([null, null, null]);
    // The two valid keys were each recorded once by apiKeyAuth; the revoked one never.
    expect(recordApiKeyRequest).toHaveBeenCalledTimes(2);
    owners.length = 0;
    await post("/compat/algolia/1/indexes/*/queries", { "X-Algolia-API-Key": KEYS.searchOnly }, { requests: [{ indexName: "w", query: "a" }] });
    await post("/compat/algolia/1/indexes/w/synonyms/batch", { "X-Algolia-API-Key": KEYS.manage }, []);
    expect(owners).toEqual([{ orgId: "o", keyId: "k-search" }, { orgId: "o", keyId: "k-manage" }]);
  });
});

describe("an oversized streamed body", () => {
  it("is refused at the cap without a declared length, and leaves nothing charged", async () => {
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (sent++ < 10) controller.enqueue(chunk);
      else controller.close();
    } });
    const response = await app.request(new Request("http://localhost/v1/chat/completions", {
      method: "POST", headers: { "content-type": "application/json", ...bearer(KEYS.chat) }, body, duplex: "half",
    } as RequestInit));
    expect(response.status).toBe(413);
    expect(owners).toEqual([{ orgId: "o", keyId: "k-chat" }]);
    expect(bufferedBodyBytes()).toBe(0);
  });
});

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { ApiErrorCode } from "@docslurp/shared";
import { apiKeyScopeMiddleware } from "../lib/api-key-authorization.js";
import { assertApiKeyWorkspaceAccess, setRequestActor } from "../lib/request-actor.js";
import type { ValidatedKey } from "../services/api-keys.js";
import { mcpAdapterRoutes } from "../services/mcp-tools.js";

/**
 * These handlers answer in the native envelope themselves. The apps below have
 * no public error boundary, so nothing reshapes or stamps `requestId`: what the
 * handler returns is what the client gets.
 */
const keyWith = (scopes: string[]) => ({
  keyId: "key-direct", userId: "user-direct", orgId: "org-direct", keyType: "server", allowedDomains: [],
  scopes, rateLimitRpm: 600, rateLimitPpd: 100_000, rateLimits: [], workspaceIds: [],
}) as unknown as ValidatedKey;

function withKey(scopes: string[]) {
  return new Hono().use("*", async (c, next) => {
    setRequestActor(c, { type: "apiKey", userId: "user-direct", apiKey: keyWith(scopes) });
    await next();
  });
}

async function expectEnvelope(response: Response, status: number, code: ApiErrorCode) {
  expect(response.status).toBe(status);
  const body = await response.json();
  expect(Object.keys(body)).toEqual(["error"]);
  expect(body.error).toMatchObject({ code, message: expect.any(String) });
  return body.error as { code: string; message: string; details?: { issues: unknown[] } };
}

describe("native handlers emit the envelope directly", () => {
  it("apiKeyScopeMiddleware answers a missing scope as forbidden", async () => {
    const app = withKey(["search"]).get("/guarded", apiKeyScopeMiddleware(["ingest"]), (c) => c.json({ ok: true }));
    await expectEnvelope(await app.request("/guarded"), 403, "forbidden");
    const allowed = withKey(["ingest"]).get("/guarded", apiKeyScopeMiddleware(["ingest"]), (c) => c.json({ ok: true }));
    expect((await allowed.request("/guarded")).status).toBe(200);
  });

  it("assertApiKeyWorkspaceAccess answers a missing scope as forbidden", async () => {
    const app = withKey(["ingest"]).get("/ws/:id", async (c) => (await assertApiKeyWorkspaceAccess(c, c.req.param("id"), "search")) ?? c.json({ ok: true }));
    await expectEnvelope(await app.request("/ws/any"), 403, "forbidden");
  });

  it("the shared MCP adapter answers in the envelope on /v1/session-tools and keeps the legacy body on /v1/mcp", async () => {
    const post = (path: string, tool: string, scopes: string[], body: unknown) =>
      withKey(scopes).route(path, mcpAdapterRoutes).request(`${path}/tools/${tool}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
    await expectEnvelope(await post("/v1/session-tools", "search", ["ingest"], {}), 403, "forbidden");
    expect(await (await post("/v1/mcp", "search", ["ingest"], {})).json()).toEqual({ error: expect.any(String) });

    const invalid = await expectEnvelope(await post("/v1/session-tools", "listWorkspaces", ["search"], { limit: "many" }), 400, "invalid_request");
    expect(invalid.details?.issues).toEqual([expect.objectContaining({ path: "limit" })]);
    expect(await (await post("/v1/mcp", "listWorkspaces", ["search"], { limit: "many" })).json()).toEqual({ error: expect.any(String) });
  });
});

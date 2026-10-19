import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";

import { apiErrorEnvelopeSchema, PUBLIC_ERROR_MESSAGES } from "@docslurp/shared";
import { apiErrorResponse, apiStatusError, nativeApiErrors, nativeBodyLimit, nativeErrorHandler, usesNativeErrorEnvelope } from "../lib/api-error.js";
import { apiPublicErrorMiddleware, publicErrorMiddleware } from "../lib/public-errors.js";
import { ApiKeyWorkspaceNotAllowedError } from "../lib/request-actor.js";
import { WorkspaceAccessError } from "../services/default-workspace.js";
import { SpendBlockedError, spendAwareErrorHandler } from "../services/billing/spend-guard.js";
import { validationHook } from "../lib/validation.js";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

function guarded(router: Hono) {
  const app = new Hono();
  app.use("*", async (c, next) => { c.set("requestId", "req-uniform"); await next(); });
  app.use("*", publicErrorMiddleware);
  app.route("/", router);
  return app;
}

describe("thrown errors inside a native router", () => {
  it("answers ApiKeyWorkspaceNotAllowedError with the workspace_not_found envelope", async () => {
    const router = new Hono()
      .use("*", nativeApiErrors)
      .get("/blocked", () => { throw new ApiKeyWorkspaceNotAllowedError(); });
    const response = await guarded(router).request("/blocked");
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toEqual({ error: { code: "workspace_not_found", message: PUBLIC_ERROR_MESSAGES.workspaceMissing, requestId: "req-uniform" } });
    expect(apiErrorEnvelopeSchema.safeParse(body).success).toBe(true);
  });

  it("maps workspace access errors to the closed vocabulary", async () => {
    const router = new Hono()
      .use("*", nativeApiErrors)
      .get("/org", () => { throw new WorkspaceAccessError(404, "organization_not_found", "Organization not found"); })
      .get("/forbidden", () => { throw new WorkspaceAccessError(403, "workspace_forbidden", "Default workspace is not accessible"); });
    const app = guarded(router);
    expect((await (await app.request("/org")).json()).error.code).toBe("organization_not_found");
    expect((await (await app.request("/forbidden")).json()).error.code).toBe("forbidden");
  });

  it("keeps the headers of the error response (Retry-After, WWW-Authenticate)", async () => {
    const router = new Hono()
      .use("*", nativeApiErrors)
      .get("/exception", () => {
        throw new HTTPException(401, { res: new Response("nope", { status: 401, headers: { "WWW-Authenticate": "Bearer realm=\"docslurp\"" } }) });
      })
      .get("/context", (c) => { c.header("Retry-After", "7"); throw Object.assign(new Error("slow down"), { statusCode: 429 }); });
    const app = guarded(router);
    app.onError((error, c) => error instanceof HTTPException ? error.getResponse() : c.json({ error: "x" }, (error as { statusCode?: 429 }).statusCode ?? 500));
    const exception = await app.request("/exception");
    expect(exception.status).toBe(401);
    expect(exception.headers.get("WWW-Authenticate")).toBe('Bearer realm="docslurp"');
    expect((await exception.json()).error.code).toBe("unauthorized");
    const throttled = await app.request("/context");
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("Retry-After")).toBe("7");
    expect((await throttled.json()).error.code).toBe("rate_limited");
  });
});

describe("app-level error handler", () => {
  function app() {
    const hono = new Hono();
    hono.onError(nativeErrorHandler((error, c) => spendAwareErrorHandler(error, c)));
    hono.use("*", async (c, next) => { c.set("requestId", "req-app"); await next(); });
    hono.use("*", apiPublicErrorMiddleware);
    hono.get("/v1/spend", () => { throw new SpendBlockedError("Out of credits", "credit_exhausted"); });
    hono.get("/v1/workspace", () => { throw new WorkspaceAccessError(404, "workspace_not_found", "Workspace not found"); });
    hono.get("/v1/boom", () => { throw new Error("postgres password=secret"); });
    hono.get("/v1/chat/completions", () => { throw new SpendBlockedError("Out of credits", "credit_exhausted"); });
    return hono;
  }

  it("answers blocked spend, access errors and crashes in the envelope on native paths", async () => {
    const hono = app();
    const spend = await hono.request("/v1/spend");
    expect(spend.status).toBe(402);
    expect(await spend.json()).toMatchObject({ error: { code: "credit_exhausted", requestId: "req-app" } });
    const workspace = await hono.request("/v1/workspace");
    expect(workspace.status).toBe(404);
    expect(await workspace.json()).toMatchObject({ error: { code: "workspace_not_found" } });
    const boom = await hono.request("/v1/boom");
    expect(boom.status).toBe(500);
    const body = await boom.json();
    expect(body).toMatchObject({ error: { code: "internal", message: PUBLIC_ERROR_MESSAGES.unexpected } });
    expect(JSON.stringify(body)).not.toMatch(/postgres|secret/);
  });

  it("leaves protocol surfaces in their own shape", async () => {
    const response = await app().request("/v1/chat/completions");
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({ error: PUBLIC_ERROR_MESSAGES.unavailable, code: "credit_exhausted" });
  });
});

describe("public error boundary for the native API", () => {
  function app() {
    const hono = new Hono();
    hono.use("*", async (c, next) => { c.set("requestId", "req-b"); await next(); });
    hono.use("*", apiPublicErrorMiddleware);
    hono.get("/v1/legacy", (c) => c.json({ error: "Document 42 missing in tenant acme", code: "not_found" }, 404));
    hono.get("/v1/legacy-unknown-code", (c) => c.json({ error: "x", code: "invite_expired" }, 409));
    hono.get("/v1/legacy-issues", (c) => c.json({ error: "bad", issues: [{ path: ["a", 0], message: "secret", code: "x" }] }, 422));
    hono.get("/v1/html", () => new Response("<h1>proxy</h1>", { status: 502, headers: { "content-type": "text/html" } }));
    hono.get("/v1/ok", (c) => c.json({ ok: true }));
    hono.get("/compat/algolia/x", (c) => c.json({ error: "legacy", code: "x" }, 400));
    hono.get("/v1/mcp", (c) => c.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "bad" } }, 400));
    hono.get("/v1/models", (c) => c.json({ error: { message: "m", type: "invalid_request_error", code: "x", param: null } }, 400));
    hono.get("/oauth/mcp/token", (c) => c.json({ error: "invalid_grant" }, 400));
    hono.get("/health", (c) => c.json({ error: "down" }, 503));
    return hono;
  }

  it("normalizes any other error body into the envelope", async () => {
    const hono = app();
    const legacy = await hono.request("/v1/legacy");
    expect(await legacy.json()).toEqual({ error: { code: "not_found", message: PUBLIC_ERROR_MESSAGES.missing, requestId: "req-b" } });
    expect((await (await hono.request("/v1/legacy-unknown-code")).json()).error.code).toBe("conflict");
    const issues = await (await hono.request("/v1/legacy-issues")).json();
    expect(issues).toEqual({ error: { code: "invalid_request", message: PUBLIC_ERROR_MESSAGES.invalid, requestId: "req-b",
      details: { issues: [{ path: "a.0", message: PUBLIC_ERROR_MESSAGES.invalid, code: "invalid_value" }] } } });
    const html = await hono.request("/v1/html");
    expect(html.status).toBe(502);
    expect((await html.json()).error.code).toBe("internal");
    expect(await (await hono.request("/v1/ok")).json()).toEqual({ ok: true });
  });

  it("keeps the shapes of protocol and non-API surfaces", async () => {
    const hono = app();
    expect(await (await hono.request("/compat/algolia/x")).json()).toMatchObject({ code: "x", requestId: "req-b" });
    expect(await (await hono.request("/v1/mcp")).json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 } });
    expect(await (await hono.request("/v1/models")).json()).toMatchObject({ error: { type: "invalid_request_error", param: null } });
    expect(await (await hono.request("/oauth/mcp/token")).json()).toMatchObject({ error: "invalid_grant" });
    expect(typeof (await (await hono.request("/health")).json()).error).toBe("string");
  });
});

describe("native request-size and validation errors", () => {
  it("answers an oversized body with a 413 envelope carrying the cap", async () => {
    const hono = new Hono();
    hono.use("/v1/upload", nativeBodyLimit(10));
    hono.post("/v1/upload", (c) => c.json({ ok: true }));
    const response = await hono.request("/v1/upload", { method: "POST", body: "x".repeat(64) });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ error: { code: "payload_too_large", details: { maxBytes: 10 } } });
  });

  it("answers a failed zValidator parse with invalid_request and field paths only", async () => {
    const hono = new Hono();
    hono.post("/v1/things", zValidator("json", z.object({ name: z.string() }), validationHook), (c) => c.json({ ok: true }));
    const response = await guarded(hono).request("/v1/things", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: 5 }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request", message: PUBLIC_ERROR_MESSAGES.invalid, requestId: "req-uniform",
      details: { issues: [{ path: "name", message: PUBLIC_ERROR_MESSAGES.invalid, code: "invalid_value" }] } } });
  });

  it("derives a code from the status unless a domain code is in the closed vocabulary", async () => {
    const hono = new Hono();
    hono.get("/a", (c) => apiStatusError(c, 409, "x", { code: "invite_expired" }));
    hono.get("/b", (c) => apiStatusError(c, 402, "x", { code: "credit_exhausted" }));
    hono.get("/c", (c) => apiErrorResponse(c, 404, "workspace_not_found", "x"));
    expect((await (await hono.request("/a")).json()).error.code).toBe("conflict");
    expect((await (await hono.request("/b")).json()).error.code).toBe("credit_exhausted");
    expect((await (await hono.request("/c")).json()).error.code).toBe("workspace_not_found");
  });
});

describe("usesNativeErrorEnvelope", () => {
  it.each(["/v1/search", "/v1/workspaces/ws/chat", "/v1/uploads/bulk", "/v1/session-tools/tools/x", "/dashboard/bootstrap", "/meta/config"])("treats %s as the native API", (path) => {
    expect(usesNativeErrorEnvelope(path)).toBe(true);
  });
  it.each(["/v1/mcp", "/v1/mcp/tools/x", "/v1/chat/completions", "/v1/models", "/compat/algolia/1/indexes/x/query", "/oauth/mcp/token", "/webhooks/stripe", "/.well-known/oauth-authorization-server", "/health", "/docs"])(
    "keeps %s on its own protocol shape", (path) => {
      expect(usesNativeErrorEnvelope(path)).toBe(false);
    });
});

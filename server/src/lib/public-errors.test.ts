import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
const report = vi.hoisted(() => vi.fn());
vi.mock("@docslurp/shared/error-reporting", () => ({ reportException: report, exceptionDetails: vi.fn() }));
vi.mock("./error-context.js", () => ({ errorContext: { getStore: () => ({ requestId: "req-test", userId: "user-test" }) } }));
import { publicErrorMiddleware, reportPublicError, safeErrorResponse } from "./public-errors.js";
import { PUBLIC_ERROR_MESSAGES } from "@docslurp/shared";

describe("public HTTP error boundary", () => {
  it.each([400, 402, 500, 503])("removes internal detail from handled %i responses and reports it", async status => {
    const res = await safeErrorResponse(Response.json({ error: "OpenRouter insufficient credits sk-secret", details: { sql: "select secret" }, stack: "private" }, { status }), "ref-1");
    const body = await res.json();
    expect(JSON.stringify(body)).not.toMatch(/OpenRouter|credits|sk-secret|sql|private/);
    expect(body.requestId).toBe("ref-1");
    expect(report).toHaveBeenCalled();
    expect(res.status).toBe(status);
  });
  it("preserves headers and compatible error envelopes", async () => {
    const res = await safeErrorResponse(Response.json({ error: { message: "provider quota exhausted", type: "provider_error" } }, { status: 429, headers: { "retry-after": "15", "access-control-allow-origin": "https://app.example", "set-cookie": "session=; Max-Age=0" } }));
    expect((await res.json()).error.message).toBe(PUBLIC_ERROR_MESSAGES.rateLimit);
    expect(res.headers.get("retry-after")).toBe("15");
    expect(res.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://app.example");
  });
  it("handles proxy HTML without exposing it", async () => {
    const res = await safeErrorResponse(new Response("<h1>upstream 10.0.0.1</h1>", { status: 502 }));
    expect((await res.json()).error).toBe(PUBLIC_ERROR_MESSAGES.unexpected);
  });
  it("leaves successful content and streaming bodies untouched", async () => {
    const res = new Response('data: {"content":"error: user document text"}\n\n', { headers: { "content-type": "text/event-stream" } });
    expect(await safeErrorResponse(res)).toBe(res);
  });
  it("sanitizes caught route failures through Hono middleware", async () => {
    const app = new Hono().use("*", publicErrorMiddleware).get("/", c => c.json({ error: "postgres private connection", details: "stack" }, 500));
    expect(await (await app.request("/")).json()).toEqual({ error: PUBLIC_ERROR_MESSAGES.unexpected });
  });
  it("reports the original exception with correlation before returning safe copy", () => {
    const original = new Error("provider credits depleted");
    expect(reportPublicError(original)).toBe(PUBLIC_ERROR_MESSAGES.unexpected);
    expect(report).toHaveBeenLastCalledWith(original, { requestId: "req-test", userId: "user-test" }, undefined);
  });
  it("hands the caller's request signal to the reporter so a disconnect is not reported as a failure", () => {
    const controller = new AbortController();
    reportPublicError("Client connection prematurely closed.", { operation: "chat" }, controller.signal);
    expect(report).toHaveBeenLastCalledWith("Client connection prematurely closed.", { requestId: "req-test", userId: "user-test", operation: "chat" }, controller.signal);
  });
});

describe("validation issue paths", () => {
  it("keeps field paths from array and string issues while redacting messages", async () => {
    const res = await safeErrorResponse(Response.json({ error: "Invalid search input", issues: [
      { path: ["filters", 0, "q"], message: "Expected string, received secret-token", code: "invalid_type" },
      { path: "limit", message: "internal", code: "too_big" },
      { message: "no path" },
    ] }, { status: 400 }), "ref-2");
    const body = await res.json();
    expect(body.issues.map((issue: { path: string }) => issue.path)).toEqual(["filters.0.q", "limit", ""]);
    expect(JSON.stringify(body)).not.toMatch(/secret-token|internal/);
  });
});

describe("protocol error compatibility", () => {
  it("preserves JSON-RPC request identity and numeric codes", async () => {
    const response = await safeErrorResponse(Response.json({ jsonrpc: "2.0", id: 7, error: { code: -32603, message: "database password=secret" } }, { status: 500 }));
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32603, message: PUBLIC_ERROR_MESSAGES.unexpected } });
  });
  it("preserves OAuth machine errors with safe descriptions", async () => {
    const response = await safeErrorResponse(Response.json({ error: "invalid_grant", error_description: "internal token lookup failed" }, { status: 400 }));
    expect(await response.json()).toEqual({ error: "invalid_grant", error_description: PUBLIC_ERROR_MESSAGES.invalid });
  });
});

import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spans, posthog } = vi.hoisted(() => ({ spans: [] as Array<Record<string, unknown>>, posthog: [] as Array<Record<string, unknown>> }));

vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(), { json: (value: unknown) => value, array: (value: unknown) => value }) }));
// Capture what the request span exports, exactly as request-context hands it over.
vi.mock("@docslurp/shared/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@docslurp/shared/observability")>()),
  withHttpSpan: async (options: { attributes?: () => Record<string, unknown> }, fn: () => Promise<unknown>) => {
    try { return await fn(); } finally { spans.push(options.attributes?.() ?? {}); }
  },
}));
vi.mock("../lib/posthog-ai-observability.js", () => ({
  emitPostHogApiLog: (args: { attributes?: Record<string, unknown> }) => { posthog.push(args.attributes ?? {}); },
}));

import { apiStatusError, middlewareErrorResponse, nativeErrorHandler } from "../lib/api-error.js";
import { apiPublicErrorMiddleware } from "../lib/public-errors.js";
import { requestContextMiddleware } from "../lib/request-context.js";
import { customerPipelineGuard } from "../middleware/customer-pipeline-guard.js";
import { MAX_REJECTION_REASON_CHARS, sanitizeRejectionReason } from "../lib/rejection-reason.js";

const SECRETS = [
  "GRANTSECRET0123456789abcdefABCDEF0123", // access grant in a URL path
  "pw-secret", // URL userinfo
  "SIGSECRET", "CREDSECRET", "STSSECRET", // signed-URL parameters
  "QTOKSECRET", // ?token=
  "alice@example.com",
  "BEARERSECRET",
  "sk-live-KEYSECRET",
  "dslp_priv_0123456789abcdef",
  "PAIRSECRET",
];
const MESSAGE = [
  "Failed to fetch https://bob:pw-secret@files.example.com/grant/GRANTSECRET0123456789abcdefABCDEF0123/report.pdf",
  "?X-Amz-Signature=SIGSECRET&X-Amz-Credential=CREDSECRET&X-Amz-Security-Token=STSSECRET&token=QTOKSECRET: 503",
  "for alice@example.com (Authorization: Bearer BEARERSECRET, key sk-live-KEYSECRET or dslp_priv_0123456789abcdef, password=PAIRSECRET)",
].join("");

function app() {
  const app = new Hono();
  app.onError(nativeErrorHandler((error, c) => c.json({ error: error.message }, error instanceof HTTPException ? error.status : 500)));
  app.use("*", requestContextMiddleware);
  app.use("*", apiPublicErrorMiddleware);
  app.post("/v1/refuse", c => apiStatusError(c, 400, MESSAGE));
  app.post("/v1/throw-400", () => { throw new HTTPException(400, { message: MESSAGE }); });
  app.post("/v1/throw-500", () => { throw new Error(MESSAGE); });
  app.post("/v1/mcp", c => middlewareErrorResponse(c, 400, "invalid_request", MESSAGE));
  // An error response built and then discarded, before a different one is sent.
  app.post("/v1/replaced-other-status", c => { apiStatusError(c, 400, "STALEREASON one"); return c.json({ error: "gone" }, 404); });
  app.post("/v1/replaced-same-status", c => { apiStatusError(c, 400, "STALEREASON two"); return c.json({ error: "other" }, 400); });
  // A recorded error response already assigned to c.res, then replaced by middleware.
  app.use("/v1/replaced-after-assignment", async (c, next) => { await next(); c.res = c.json({ error: "replacement" }, 400); });
  app.post("/v1/replaced-after-assignment", c => apiStatusError(c, 400, "STALEREASON four"));
  // A handler's recorded error, then a middleware that throws after next(): onError's response is delivered.
  app.use("/v1/throws-after-error", async (_c, next) => { await next(); throw new Error("post-next failure"); });
  app.post("/v1/throws-after-error", c => apiStatusError(c, 400, "STALEREASON five"));
  // The pipeline guard clones every JSON response (error ones too) on its way out.
  app.use("/v1/guarded", customerPipelineGuard);
  app.post("/v1/guarded", c => apiStatusError(c, 400, "guarded reason"));
  app.post("/v1/recorded-twice", c => { apiStatusError(c, 400, "STALEREASON three"); return apiStatusError(c, 400, "delivered reason"); });
  return app;
}

let logged: string[] = [];
beforeEach(() => {
  spans.length = 0;
  posthog.length = 0;
  logged = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(arg => typeof arg === "string" ? arg : JSON.stringify(arg)).join(" ")); });
  }
});
afterEach(() => vi.restoreAllMocks());

function expectNoSecret(label: string, text: string) {
  for (const secret of SECRETS) expect(text, `${label} leaks ${secret}`).not.toContain(secret);
}

async function refuse(path: string) {
  const response = await app().request(path, { method: "POST" });
  const body = await response.text();
  const line = logged.find(text => text.startsWith("[api] ")) ?? "";
  // Every emitted record must exist, or the leak assertions would pass vacuously.
  expect(line).toMatch(/^\[api\] requestId=/);
  expect(spans).toHaveLength(1);
  expect(posthog).toHaveLength(1);
  return { status: response.status, body, line, span: spans.at(-1) ?? {}, posthog: posthog.at(-1) ?? {} };
}

describe("refusal telemetry never carries credentials", () => {
  it.each(["/v1/refuse", "/v1/throw-400", "/v1/mcp"])("%s: 4xx reason is sanitized in the span and stdout line, absent from PostHog and the response", async (path) => {
    const result = await refuse(path);
    expect(result.status).toBe(400);
    for (const [label, text] of [["response", result.body], ["stdout line", result.line], ["span attributes", JSON.stringify(result.span)], ["posthog attributes", JSON.stringify(result.posthog)]] as const) {
      expectNoSecret(label, text);
    }
    // Still useful: the code, a stable id, and the reason with the URL reduced to its origin.
    expect(result.span["docslurp.error.code"]).toBe("invalid_request");
    expect(result.span["docslurp.error.reason_id"]).toMatch(/^[0-9a-f]{12}$/);
    expect(result.span["docslurp.error.reason"]).toContain("https://files.example.com");
    expect(String(result.span["docslurp.error.reason"]).length).toBeLessThanOrEqual(MAX_REJECTION_REASON_CHARS);
    expect(result.line).toContain("error_reason=");
    // PostHog gets the closed code only.
    expect(result.posthog["docslurp.error.code"]).toBe("invalid_request");
    expect(JSON.stringify(result.posthog)).not.toMatch(/docslurp\.error\.reason|files\.example\.com/);
  });

  it.each(["/v1/replaced-other-status", "/v1/replaced-same-status", "/v1/replaced-after-assignment"])("%s: a discarded error response's reason is never reported", async (path) => {
    const result = await refuse(path);
    expect(result.span["docslurp.error.code"]).toBeUndefined();
    expect(result.span["docslurp.error.reason"]).toBeUndefined();
    expect(result.posthog["docslurp.error.code"]).toBeUndefined();
    for (const text of [result.line, JSON.stringify(result.span), JSON.stringify(result.posthog), result.body]) expect(text).not.toContain("STALEREASON");
  });

  it("reports the thrown error, not the handler's earlier refusal, when a middleware throws after next()", async () => {
    const result = await refuse("/v1/throws-after-error");
    expect(result.status).toBe(500);
    expect(result.span["docslurp.error.code"]).toBe("internal");
    expect(result.span["docslurp.error.reason"]).toBeUndefined();
    for (const text of [result.line, JSON.stringify(result.span), JSON.stringify(result.posthog), result.body]) expect(text).not.toContain("STALEREASON");
  });

  it("keeps the reason through middleware that clones the same response", async () => {
    const result = await refuse("/v1/guarded");
    expect(result.span["docslurp.error.reason"]).toBe("guarded reason");
    expect(result.posthog["docslurp.error.code"]).toBe("invalid_request");
  });

  it("reports the reason of the error response actually delivered", async () => {
    const result = await refuse("/v1/recorded-twice");
    expect(result.span["docslurp.error.reason"]).toBe("delivered reason");
    expect(result.line).not.toContain("STALEREASON");
  });

  it("keeps a 5xx's raw text off the span and stdout line (code and id only)", async () => {
    const result = await refuse("/v1/throw-500");
    expect(result.status).toBe(500);
    expect(result.span["docslurp.error.reason"]).toBeUndefined();
    expect(result.span["docslurp.error.reason_id"]).toMatch(/^[0-9a-f]{12}$/);
    expect(result.line).not.toContain("error_reason=");
    for (const [label, text] of [["response", result.body], ["stdout line", result.line], ["span attributes", JSON.stringify(result.span)]] as const) {
      expectNoSecret(label, text);
    }
  });

  it("keeps resource ids for correlation and catches compound credential names and parenthesised paths", () => {
    const id = "0f5c3a5e-3b7e-4c43-9a59-2d3c0e1b9a10";
    const sanitized = sanitizeRejectionReason(`document ${id}: client_secret=CS1SECRET aws_secret_access_key=AK2SECRET fetching https://h.example.com/a(b)/GRANT3SECRET`);
    expect(sanitized).toContain(id);
    expect(sanitized).toContain("https://h.example.com");
    expect(sanitized).not.toMatch(/CS1SECRET|AK2SECRET|GRANT3SECRET/);
  });

  it("redacts before it truncates", () => {
    const sanitized = sanitizeRejectionReason(`${"x ".repeat(140)}password=PAIRSECRET and https://h.example.com/${"a".repeat(40)}`);
    expect(sanitized.length).toBeLessThanOrEqual(MAX_REJECTION_REASON_CHARS);
    expect(sanitized).not.toMatch(/PAIR|aaaaaaaa/);
  });

  it("gives the same refusal one reason id whatever ids or sizes it names", async () => {
    const ids = new Set<unknown>();
    for (const id of ["0f5c3a5e-3b7e-4c43-9a59-2d3c0e1b9a10", "8d0a2f6c-91b1-4b8e-a5d2-6a3f7c1e0b42"]) {
      const route = new Hono();
      route.use("*", requestContextMiddleware);
      route.post("/v1/x", c => apiStatusError(c, 404, `Upload session ${id} not found after 12 tries`));
      await route.request("/v1/x", { method: "POST" });
      ids.add(spans.at(-1)?.["docslurp.error.reason_id"]);
    }
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^[0-9a-f]{12}$/);
  });
});

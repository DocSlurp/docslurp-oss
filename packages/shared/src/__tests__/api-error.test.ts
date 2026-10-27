import { describe, expect, it } from "vitest";

import {
  API_ERROR_CODES,
  API_ERROR_PUBLIC_MESSAGES,
  apiError,
  apiErrorCodeForStatus,
  apiErrorEnvelopeSchema,
  isApiErrorCode,
  publicApiErrorDetails,
  publicApiErrorLinks,
  publicApiErrorMessage,
  publicApiErrorEnvelope,
} from "../api-error.js";
import { safeErrorResponse } from "../error-response.js";
import { PUBLIC_ERROR_MESSAGES } from "../public-errors.js";

describe("apiError", () => {
  it("builds the envelope body without details by default", () => {
    expect(apiError("forbidden", "Forbidden")).toEqual({ error: { code: "forbidden", message: "Forbidden" } });
  });
  it("carries details when given", () => {
    expect(apiError("invalid_request", "Invalid", { issues: [{ path: ["q"] }] }).error.details).toEqual({ issues: [{ path: ["q"] }] });
  });
});

describe("closed code vocabulary", () => {
  it("has unique snake_case codes and reviewed copy for each", () => {
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
    for (const code of API_ERROR_CODES) {
      expect(code).toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(API_ERROR_PUBLIC_MESSAGES[code]).toBeTruthy();
    }
    expect(isApiErrorCode("chat_disabled")).toBe(true);
    expect(isApiErrorCode("CHAT_DISABLED")).toBe(false);
    expect(isApiErrorCode(7)).toBe(false);
  });
  it.each([[400, "invalid_request"], [401, "unauthorized"], [402, "payment_required"], [403, "forbidden"], [404, "not_found"],
    [409, "conflict"], [413, "payload_too_large"], [429, "rate_limited"], [418, "invalid_request"], [503, "unavailable"], [500, "internal"]] as const)(
    "maps status %i to %s", (status, code) => expect(apiErrorCodeForStatus(status)).toBe(code));
});

describe("apiErrorEnvelopeSchema", () => {
  it("accepts a complete envelope and rejects unknown codes or a missing requestId", () => {
    expect(apiErrorEnvelopeSchema.safeParse({ error: { code: "not_found", message: "x", requestId: "r1" } }).success).toBe(true);
    expect(apiErrorEnvelopeSchema.safeParse({ error: { code: "teapot", message: "x", requestId: "r1" } }).success).toBe(false);
    expect(apiErrorEnvelopeSchema.safeParse({ error: { code: "not_found", message: "x" } }).success).toBe(false);
    expect(apiErrorEnvelopeSchema.safeParse({ error: "legacy string" }).success).toBe(false);
  });
});

describe("publicApiErrorEnvelope", () => {
  it("ignores legacy, OpenAI-compatible and non-error bodies", () => {
    expect(publicApiErrorEnvelope({ error: "legacy" }, 400)).toBeNull();
    expect(publicApiErrorEnvelope({ error: { type: "permission_error", code: "chat_disabled", message: "m", param: null } }, 403)).toBeNull();
    expect(publicApiErrorEnvelope({ message: "x" }, 400)).toBeNull();
    expect(publicApiErrorEnvelope(null, 400)).toBeNull();
  });
  it("replaces unknown codes by status and route-authored text by reviewed copy", () => {
    expect(publicApiErrorEnvelope({ error: { code: "TOTALLY_NEW", message: "sk-secret leaked" } }, 404, "r1"))
      .toEqual({ error: { code: "not_found", message: PUBLIC_ERROR_MESSAGES.missing, requestId: "r1" } });
  });
});

describe("safeErrorResponse with the native envelope", () => {
  const issues = [{ path: ["filters", 0, "q"], message: "Expected string, received secret-token", code: "invalid_type" }];
  it("stamps requestId inside error, keeps field paths and drops other details", async () => {
    const res = await safeErrorResponse(Response.json(apiError("invalid_request", "Invalid search input secret-token", { issues, sql: "select secret" }), { status: 400, headers: { "retry-after": "3" } }), "req-9");
    const body = await res.json();
    expect(body).toEqual({ error: { code: "invalid_request", message: PUBLIC_ERROR_MESSAGES.invalid, requestId: "req-9",
      details: { issues: [{ path: "filters.0.q", message: PUBLIC_ERROR_MESSAGES.invalid, code: "invalid_value" }] } } });
    expect(apiErrorEnvelopeSchema.safeParse(body).success).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/secret/);
    expect(res.headers.get("retry-after")).toBe("3");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
  it("keeps machine codes with reviewed messages", async () => {
    const res = await safeErrorResponse(Response.json(apiError("chat_disabled", "anything"), { status: 403 }), "req-1");
    expect(await res.json()).toEqual({ error: { code: "chat_disabled", message: PUBLIC_ERROR_MESSAGES.chatDisabled, requestId: "req-1" } });
  });
  it("leaves OpenAI-compatible errors in their own shape", async () => {
    const res = await safeErrorResponse(Response.json({ error: { message: "m", type: "permission_error", code: "chat_disabled", param: null } }, { status: 403 }), "req-2");
    expect(await res.json()).toMatchObject({ error: { type: "invalid_request_error", code: null, param: null }, requestId: "req-2" });
  });
});

describe("publicApiErrorDetails", () => {
  it("forwards field paths and server-authored limit metadata, nothing else", () => {
    expect(publicApiErrorDetails({
      issues: [{ path: ["a", 1], message: "echoes secret input" }],
      retryAfterSeconds: 30, limitCents: 500, spentCents: 512.4, maxBytes: 1024, category: "search", policy: "key-spend-1d",
      directUpload: { createSession: "/v1/uploads/direct/sessions", maxFileBytes: 5, secret: "x" },
      sql: "select secret", stack: "private",
    })).toEqual({
      issues: [{ path: "a.1", message: PUBLIC_ERROR_MESSAGES.invalid, code: "invalid_value" }],
      retryAfterSeconds: 30, limitCents: 500, spentCents: 512.4, maxBytes: 1024, category: "search", policy: "key-spend-1d",
      directUpload: { createSession: "/v1/uploads/direct/sessions", maxFileBytes: 5 },
    });
  });
  it("drops labels that are not plain identifiers and non-finite numbers", () => {
    expect(publicApiErrorDetails({ policy: "a b; drop table", category: { nested: true }, retryAfterSeconds: "3", maxBytes: Number.NaN, directUpload: { createSession: "http://evil", maxFileBytes: 1 } })).toBeUndefined();
    expect(publicApiErrorDetails(null)).toBeUndefined();
    expect(publicApiErrorDetails([1])).toBeUndefined();
  });
});

describe("safeErrorResponse for the native API", () => {
  it("rewrites a legacy handler body into the envelope, keeping a closed code, field paths and headers", async () => {
    const legacy = Response.json({ error: "Tenant acme: document 42 missing", code: "workspace_not_found", issues: [{ path: ["q"], message: "secret" }] },
      { status: 404, headers: { "retry-after": "5", "x-docslurp-spend": "kept" } });
    const res = await safeErrorResponse(legacy, "req-n", undefined, true);
    expect(await res.json()).toEqual({ error: { code: "workspace_not_found", message: API_ERROR_PUBLIC_MESSAGES.workspace_not_found, requestId: "req-n",
      details: { issues: [{ path: "q", message: PUBLIC_ERROR_MESSAGES.invalid, code: "invalid_value" }] } } });
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("x-docslurp-spend")).toBe("kept");
  });
  it("falls back to the status code for unknown codes, plain text and nested legacy details", async () => {
    const unknown = await safeErrorResponse(Response.json({ error: "x", code: "TOTALLY_NEW" }, { status: 409 }), "r", undefined, true);
    expect((await unknown.json()).error.code).toBe("conflict");
    const text = await safeErrorResponse(new Response("upstream 10.0.0.1", { status: 429 }), "r", undefined, true);
    expect(await text.json()).toEqual({ error: { code: "rate_limited", message: PUBLIC_ERROR_MESSAGES.rateLimit, requestId: "r" } });
    const nested = await safeErrorResponse(Response.json({ success: false, error: { issues: [{ path: ["name"] }] } }, { status: 400 }), "r", undefined, true);
    expect(await nested.json()).toMatchObject({ error: { code: "invalid_request", details: { issues: [{ path: "name" }] } } });
  });
  it("leaves the legacy shape alone when not native", async () => {
    const res = await safeErrorResponse(Response.json({ error: "x", code: "workspace_not_found" }, { status: 404 }), "r");
    expect(await res.json()).toMatchObject({ code: "workspace_not_found", requestId: "r" });
  });
});

describe("limit links", () => {
  const links = {
    buyCredits: "https://docslurp.io/app/billing#buy-credits",
    autoTopUp: "https://docslurp.io/app/billing#auto-top-up",
    billing: "https://docslurp.io/app/billing",
    docs: "https://docslurp.io/docs/http#rate-limits-and-headers",
  };

  it("keeps only known keys with absolute http(s) URLs and never an upgrade link", () => {
    expect(publicApiErrorLinks({ ...links, upgrade: "https://docslurp.io/pricing", evil: "https://x", apiKeys: "javascript:alert(1)" })).toEqual(links);
    expect(publicApiErrorLinks({ billing: "https://a b" })).toBeUndefined();
    // Plan labels (account, plan) are never public detail fields.
    expect(publicApiErrorDetails({ links, account: "starter", plan: "free", note: "dropped" })).toEqual({ links });
  });

  it("never tells a rate-limited caller to buy credits; points credit errors at buying credits and auto top-up", () => {
    expect(publicApiErrorMessage("rate_limited", { account: "account", links })).not.toContain("buy credits");
    expect(publicApiErrorMessage("rate_limited", { account: "starter", links })).not.toContain("buy credits");
    expect(publicApiErrorMessage("credit_exhausted", { links })).toBe(
      "Your organization is out of credits. Buy credits at https://docslurp.io/app/billing#buy-credits, or turn on auto top-up at https://docslurp.io/app/billing#auto-top-up.",
    );
    expect(publicApiErrorMessage("credit_exhausted", { links: { buyCredits: links.buyCredits } })).toBe(
      "Your organization is out of credits. Buy credits at https://docslurp.io/app/billing#buy-credits.",
    );
    for (const code of ["rate_limited", "credit_exhausted", "org_budget_paused"] as const) {
      expect(publicApiErrorMessage(code)).toBe(API_ERROR_PUBLIC_MESSAGES[code]);
    }
  });
});

describe("domain error codes", () => {
  it("every code a route can surface has reviewed public copy", async () => {
    const { API_ERROR_CODES, API_ERROR_PUBLIC_MESSAGES } = await import("../api-error.js");
    for (const code of API_ERROR_CODES) expect(API_ERROR_PUBLIC_MESSAGES[code], code).toMatch(/\S/);
    for (const code of ["workspace_scope_forbidden", "no_stages_to_run", "index_in_progress", "workspace_forbidden"]) {
      expect(API_ERROR_CODES).toContain(code);
    }
  });
});

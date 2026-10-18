import { describe, expect, it } from "vitest";

import {
  API_ERROR_CODES,
  API_ERROR_PUBLIC_MESSAGES,
  apiError,
  apiErrorCodeForStatus,
  apiErrorEnvelopeSchema,
  isApiErrorCode,
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

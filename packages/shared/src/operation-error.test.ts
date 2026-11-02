import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";

import { isRouteLevelProviderFailure, operationErrorAttributes, operationErrorSummary, spanSafeErrorAttributes } from "./operation-error.js";

const providerError = (statusCode: number, message: string, isRetryable = false) =>
  new APICallError({ message, url: "https://openrouter.ai/api/v1/chat/completions", requestBodyValues: {}, statusCode, isRetryable });

describe("operationErrorAttributes", () => {
  it("reports the provider's routing refusal with its status", () => {
    const attributes = operationErrorAttributes(providerError(404, "No allowed providers are available for the selected model."));
    expect(attributes).toMatchObject({
      "exception.type": "AI_APICallError",
      "http.response.status_code": 404,
      "docslurp.error.retryable": false,
      "exception.message": "No allowed providers are available for the selected model.",
    });
    expect(operationErrorSummary(attributes)).toBe("(HTTP 404, not retryable)");
  });

  it("withholds messages for statuses that can echo or describe the request", () => {
    for (const status of [400, 403, 409, 413, 422]) {
      const attributes = operationErrorAttributes(providerError(status, "Invalid input near: CONFIDENTIAL PAGE TEXT"));
      expect(attributes["http.response.status_code"]).toBe(status);
      expect(attributes["exception.message"]).toBeUndefined();
    }
  });

  it("describes exhausted retries by the last attempt", () => {
    const last = providerError(429, "Rate limit exceeded", true);
    const error = new RetryError({ message: "Failed after 3 attempts. Last error: Rate limit exceeded", reason: "maxRetriesExceeded", errors: [last, last, last] });
    const attributes = operationErrorAttributes(error);
    expect(attributes).toMatchObject({ "exception.type": "AI_APICallError", "docslurp.error.wrapper": "AI_RetryError",
      "http.response.status_code": 429, "docslurp.error.retryable": true, "docslurp.error.attempts": 3 });
    expect(operationErrorSummary(attributes)).toBe("(HTTP 429, retryable, 3 attempts)");
  });

  it("redacts credentials and keeps unknown errors' messages out", () => {
    expect(operationErrorAttributes(providerError(401, "Invalid key sk-or-v1-abcdef123456"))["exception.message"]).toBe("Invalid key [redacted]");
    expect(operationErrorAttributes(new SyntaxError("Unexpected token in JSON: secret page text"))).toEqual({ "exception.type": "SyntaxError" });
  });

  it("keeps only a short prefix of gateway errors", () => {
    const message = operationErrorAttributes(providerError(503, `Upstream unavailable ${"x".repeat(400)}`, true))["exception.message"];
    expect(String(message)).toHaveLength(200);
  });

  it("reads the provider error through our own wrappers' cause chain", () => {
    const wrapped = new Error("graph window failed", { cause: new Error("provider call failed", { cause: providerError(404, "No allowed providers are available.") }) });
    expect(operationErrorAttributes(wrapped)).toMatchObject({ "exception.type": "AI_APICallError", "docslurp.error.wrapper": "Error", "http.response.status_code": 404 });
  });

  it("keeps the message off spans, which export to Langfuse", () => {
    const attributes = operationErrorAttributes(providerError(404, "No allowed providers are available."));
    expect(spanSafeErrorAttributes(attributes)).toEqual({ "exception.type": "AI_APICallError", "http.response.status_code": 404, "docslurp.error.retryable": false });
  });

  it("treats only refusals no later request can pass as route-level", () => {
    const route = (status: number) => isRouteLevelProviderFailure(operationErrorAttributes(providerError(status, "x")));
    expect([401, 402, 404].map(route)).toEqual([true, true, true]);
    expect([400, 403, 408, 413, 422, 429, 500].map(route)).toEqual([false, false, false, false, false, false, false]);
    const refused = Object.assign(new Error("China-based providers are turned off"), { name: "ProviderRegionRefusedError" });
    expect(isRouteLevelProviderFailure(operationErrorAttributes(refused))).toBe(true);
  });
});

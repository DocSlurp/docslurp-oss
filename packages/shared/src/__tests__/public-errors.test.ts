import { describe, it, expect } from "vitest";
import { friendlyErrorMessage, publicDiagnostics, publicErrorForStatus, PUBLIC_ERROR_MESSAGES } from "../public-errors.js";

describe("public error policy", () => {
  it.each([
    "OpenRouter 402 insufficient credits: balance=$0",
    "Postgres ECONNREFUSED postgres://user:secret@internal:5432/db",
    "<html>Gateway stack trace</html>",
    "Please try again: sk-secret-token",
  ])("never trusts arbitrary exception text: %s", message => {
    expect(friendlyErrorMessage(new Error(message))).toBe(PUBLIC_ERROR_MESSAGES.unexpected);
    expect(friendlyErrorMessage(message, "Couldn’t upload this file. Try again.")).toBe("Couldn’t upload this file. Try again.");
  });
  it("keeps safe guidance, including neutral credit-limit copy", () => {
    expect(publicErrorForStatus(402)).toBe(PUBLIC_ERROR_MESSAGES.unavailable);
    expect(friendlyErrorMessage(PUBLIC_ERROR_MESSAGES.rateLimit)).toBe(PUBLIC_ERROR_MESSAGES.rateLimit);
  });
  it("sanitizes nested stored diagnostics without mutating originals or losing measurements", () => {
    const raw = { error: "provider key rejected", pages: 4, errors: 2, nested: { failureReason: "SQL failed", stack: "secret stack", latencyMs: 20 } };
    expect(publicDiagnostics(raw)).toEqual({ error: PUBLIC_ERROR_MESSAGES.processing, pages: 4, errors: 2, nested: { failureReason: PUBLIC_ERROR_MESSAGES.processing, latencyMs: 20 } });
    expect(raw.error).toBe("provider key rejected");
  });
});

it("sanitizes string arrays inside error and warning fields", () => {
  expect(publicDiagnostics({ warnings: ["provider credits exhausted"], nested: { errors: ["SQL failed"] } })).toEqual({
    warnings: ["Diagnostic details withheld."], nested: { errors: [PUBLIC_ERROR_MESSAGES.processing] },
  });
});


it("does not label successful routing diagnostics as processing failures", () => {
  const raw = {
    status: "completed",
    error: null,
    stats: {
      adaptiveTuning: { reasons: ["private adaptive tuning decision"], docConcurrency: 4 },
      decisionChain: [{ reason: "private provider routing decision", confidence: 0.9 }],
      message: "postgres://user:secret@internal/db",
    },
  };
  expect(publicDiagnostics(raw)).toEqual({
    status: "completed",
    error: null,
    stats: {
      adaptiveTuning: { reasons: ["Diagnostic details withheld."], docConcurrency: 4 },
      decisionChain: [{ reason: "Diagnostic details withheld.", confidence: 0.9 }],
      message: "Diagnostic details withheld.",
    },
  });
  expect(raw.stats.message).toContain("secret");
});


it("preserves only the approved blocked-chat copy through browser sanitization", () => {
  expect(friendlyErrorMessage(PUBLIC_ERROR_MESSAGES.chatToolFailed)).toBe(PUBLIC_ERROR_MESSAGES.chatToolFailed);
  expect(friendlyErrorMessage(PUBLIC_ERROR_MESSAGES.chatDeadline)).toBe(PUBLIC_ERROR_MESSAGES.chatDeadline);
  expect(friendlyErrorMessage("A required tool failed: private upstream response and secret")).toBe(PUBLIC_ERROR_MESSAGES.unexpected);
});

it("keeps internal extractor routing and engine details operator-only", () => {
  expect(publicDiagnostics({
    strategy: "kreuzberg-solo",
    extractor: "kreuzberg",
    extractionMs: 120,
    nativePdf: { engine: "loaded", engineVersion: "0.13.0+abc", shadow: { status: "ran", agreement: 0.98 } },
    extractorOrder: ["kreuzberg", "native-pdf"],
    extractorAttempts: { attempted: ["kreuzberg"], unavailable: [] },
    secondaryExtractor: null,
    retryStrategy: "default",
  })).toEqual({ strategy: "kreuzberg-solo", extractor: "kreuzberg", extractionMs: 120 });
});

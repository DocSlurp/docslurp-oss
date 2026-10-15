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
    warnings: [PUBLIC_ERROR_MESSAGES.processing], nested: { errors: [PUBLIC_ERROR_MESSAGES.processing] },
  });
});

import { describe, expect, it } from "vitest";
import { publicDocumentFailure } from "./document-failure.js";

describe("public failure contract", () => {
  it("retains closed typed evidence and withholds unknown retry advice", () => {
    expect(publicDocumentFailure({ code: "source_rejected", retryable: false })).toEqual({ code: "source_rejected", retryable: false });
    expect(publicDocumentFailure({ code: "processing_failed", retryable: null })).toEqual({ code: "processing_failed", retryable: null });
  });
  it("rejects diagnostic injection, malformed records and contradictory policies", () => {
    for (const value of [null, "retryable timeout /secret", { code: "source_rejected", retryable: true }, { code: "processing_failed", retryable: true }, { code: "source_rejected", retryable: false, stderr: "/secret" }, { code: "provider-secret", retryable: false }]) expect(publicDocumentFailure(value)).toBeNull();
  });
});

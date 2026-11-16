import { PdfPageCountError } from "../lib/pdf-page-count.js";
import { describe, expect, it } from "vitest";
import { trustedDocumentFailure } from "../lib/trusted-document-failure.js";
import { OcrRefusedError, OcrInfrastructureError, OcrDeterministicFailure } from "../ocr/mode.js";

describe("trusted failure evidence", () => {
  it("uses actual typed evidence", () => {
    expect(trustedDocumentFailure(new PdfPageCountError("/secret encrypted", "encrypted"))).toEqual({ code: "source_encrypted", retryable: false });
    expect(trustedDocumentFailure(new OcrRefusedError("private", "off"))).toEqual({ code: "capability_unavailable", retryable: false });
    expect(trustedDocumentFailure(new OcrInfrastructureError("private"))).toEqual({ code: "infrastructure_unavailable", retryable: true });
    expect(trustedDocumentFailure(new OcrDeterministicFailure("private", "invalid-input"))).toEqual({ code: "source_rejected", retryable: false });
  });
  it("never derives retry advice from input prose or lookalike properties", () => {
    for (const error of [new Error("encrypted PDF retryable timeout"), { name: "OcrInfrastructureError", retryable: true }, "ECONNRESET"]) expect(trustedDocumentFailure(error)).toEqual({ code: "processing_failed", retryable: null });
  });
});

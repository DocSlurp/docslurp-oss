import { describe, expect, it } from "vitest";
import { classifyIngestFailure, ingestReportFailuresSchema, INGEST_REPORT_FAILURE_DETAIL_MAX, sanitizeFailureDetail } from "../ingest-report.js";
import { DOCUMENT_FAILURE_MARKERS, PUBLIC_ERROR_MESSAGES } from "../public-errors.js";

const OCR_CRASH = "no extractor produced output: ocr=Error: OCR runtime unavailable for DOCSLURP_OCR_MODE=local: Error opening data file /opt/docslurp/ocr-models/pp-ocrv6-rec-small.onnx, poppler-text=Error: pdftotext failed";

describe("classifyIngestFailure", () => {
  it.each([
    [OCR_CRASH, "ocr_unavailable"],
    ["OCR runtime unavailable for DOCSLURP_OCR_MODE=local", "ocr_unavailable"],
    // A stage error stored by the retired local OCR engine before the cutover.
    ["no extractor produced output: kreuzberg=Error: Error opening data file /app/tessdata/eng.traineddata", "ocr_unavailable"],
    ["DOCSLURP_OCR_MODE=vm needs a sandboxed OCR provider plugin (DOCSLURP_EXTRACTOR_PLUGINS); refusing local fallback", "ocr_unavailable"],
    ["no extractor produced output: kreuzberg=Error: boom, poppler-text=Error: nothing", "extractor_failed"],
    ["Unsupported file format: application/x-foo", "unsupported_format"],
    ["PDF is password protected", "unreadable_file"],
    ["no extractor produced output: poppler-text=Error: pdftotext: unreadable cross-reference table", "unreadable_file"],
    ["Activity timed out after 600s", "timeout"],
    ["OpenRouter 429 rate limit", "provider_failed"],
    ["Privacy mode blocks hosted vision", "policy_blocked"],
    ["something nobody anticipated", "unknown"],
    [null, "unknown"],
  ])("classifies %j as %s", (error, reason) => {
    expect(classifyIngestFailure(error).reason).toBe(reason);
  });

  it("lets the document status decide cancelled and PII-blocked files", () => {
    expect(classifyIngestFailure(null, "cancelled").reason).toBe("cancelled");
    expect(classifyIngestFailure("anything", "pii_blocked").reason).toBe("policy_blocked");
  });

  it("keeps reviewed copy for uploader-actionable markers", () => {
    const result = classifyIngestFailure(DOCUMENT_FAILURE_MARKERS.silentVideo);
    expect(result.message).toBe(PUBLIC_ERROR_MESSAGES.silentVideo);
  });

  it("never echoes the raw error in the user-facing message and flags unrecoverable causes", () => {
    const result = classifyIngestFailure(OCR_CRASH);
    expect(result.message).not.toMatch(/ocr-models|DOCSLURP_OCR_MODE|\/opt|onnx/);
    expect(result.retryable).toBe(false);
    expect(classifyIngestFailure("Activity timed out").retryable).toBe(true);
  });
});

describe("sanitizeFailureDetail", () => {
  it("drops filesystem paths but keeps the diagnosis", () => {
    const detail = sanitizeFailureDetail(OCR_CRASH)!;
    expect(detail).toContain("Error opening data file <path>");
    expect(detail).not.toMatch(/\/opt|ocr-models|\.onnx/);
  });

  it.each([
    ["connect failed postgres://user:hunter2@db.internal:5432/app", "hunter2"],
    ["request to https://api.example.com/v1?key=abc123 failed", "abc123"],
    ["auth failed: Authorization: Bearer abcdefghijklmnop", "abcdefghijklmnop"],
    ["api_key=sk-live_abcdefghijklmnop rejected", "sk-live"],
    ["notify admin@example.com about C:\\Users\\me\\file.pdf", "admin@example.com"],
    ["token AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd leaked", "AbCdEfGhIjKlMnOp"],
  ])("redacts secrets and locations in %j", (input, leaked) => {
    expect(sanitizeFailureDetail(input)).not.toContain(leaked);
  });

  it("keeps ordinary MIME types and drops stack frames", () => {
    expect(sanitizeFailureDetail("Cannot parse text/plain\n    at parse (/srv/app/parse.js:10:2)")).toBe("Cannot parse text/plain");
  });

  it("caps length and returns null for empty input", () => {
    expect(sanitizeFailureDetail("x ".repeat(400))!.length).toBeLessThanOrEqual(INGEST_REPORT_FAILURE_DETAIL_MAX);
    expect(sanitizeFailureDetail("")).toBeNull();
    expect(sanitizeFailureDetail(null)).toBeNull();
  });
});

it("parses stored reports without failures as none", () => {
  expect(ingestReportFailuresSchema.default({ total: 0, byReason: [], examples: [] }).parse(undefined)).toEqual({ total: 0, byReason: [], examples: [] });
});

describe("missing or unavailable converters classify as extractor failures, not unknown", () => {
  it.each([
    "doppler-md unavailable: pdftomarkdown is not installed (DOCSLURP_PDF_MODE=local needs Doppler)",
    "pdftoppm unavailable for selected-page rasterization",
    "Error: spawn pandoc ENOENT",
    "pdftomarkdown: command not found",
    "python3 exited with code 127",
  ])("%j", (error) => {
    expect(classifyIngestFailure(error).reason).toBe("extractor_failed");
  });

  it("keeps OCR and unreadable-file causes ahead of it", () => {
    expect(classifyIngestFailure("OCR runtime unavailable for DOCSLURP_OCR_MODE=vm").reason).toBe("ocr_unavailable");
    expect(classifyIngestFailure("encrypted PDF: extractor unavailable").reason).toBe("unreadable_file");
  });
});

import { describe, expect, it } from "vitest";
import { classifyIngestFailure, ingestReportFailuresSchema, publicFailureDetail } from "../ingest-report.js";
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

describe("publicFailureDetail: reviewed phrases only, never the stored error's text", () => {
  it.each([
    // JSON bodies, quoted keys, query strings, headers, connection strings, paths and provider text.
    ['provider said {"password":"hunter2","token":"short-secret"}', ["hunter2", "short-secret", "password\":"]],
    ["request https://api.example.com/v1?key=abc123&secret=s3cr3t failed", ["abc123", "s3cr3t", "api.example.com"]],
    ["upstream 401: Authorization: Bearer abcdefghijklmnop; X-Api-Key: k-12345; Cookie: session=xyz", ["abcdefghijklmnop", "k-12345", "session=xyz"]],
    ["connect failed postgres://user:hunter2@db.internal:5432/app", ["hunter2", "db.internal"]],
    ["api_key='sk-live_abcd' rejected for admin@example.com at /srv/app/x.js", ["sk-live", "admin@example.com", "/srv/app"]],
  ])("shows nothing of %j", (input, leaked) => {
    const detail = publicFailureDetail(input);
    for (const secret of leaked) expect(detail ?? "").not.toContain(secret);
    expect(detail).toBeNull();
  });

  it("maps known causes to fixed phrases, even when the stored text also carries secrets", () => {
    expect(publicFailureDetail('PDF is encrypted {"password":"hunter2"}')).toBe("The file is password-protected or encrypted.");
    expect(publicFailureDetail("Activity timed out after 600s token=abc")).toBe("Processing took longer than its time limit.");
    expect(publicFailureDetail("storage object raw/x is 9 bytes, exceeding max 4 bytes")).toBe("The file exceeds a processing size limit.");
    expect(publicFailureDetail(OCR_CRASH)).toBeNull();
    expect(publicFailureDetail("")).toBeNull();
    expect(publicFailureDetail(null)).toBeNull();
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

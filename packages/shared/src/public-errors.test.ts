import { describe, expect, it } from "vitest";
import { DOCUMENT_FAILURE_MARKERS, PUBLIC_ERROR_MESSAGES, QUARANTINE_PUBLIC_REASONS, publicDocumentError, quarantineFailureText, quarantinePublicReason, quarantineReasonOf } from "./public-errors.js";

describe("publicDocumentError", () => {
  it("maps a known worker failure to reviewed copy, including inside a Run summary", () => {
    expect(publicDocumentError(DOCUMENT_FAILURE_MARKERS.silentVideo)).toBe(PUBLIC_ERROR_MESSAGES.silentVideo);
    expect(publicDocumentError(`All 1 document failed (extract-markdown: ${DOCUMENT_FAILURE_MARKERS.silentVideo})`))
      .toBe(PUBLIC_ERROR_MESSAGES.silentVideo);
  });

  it("names the cause when an image can be read by neither OCR nor vision, without echoing the diagnostic", () => {
    const stored = `${DOCUMENT_FAILURE_MARKERS.imageNeedsVision} (kreuzberg=Error: Error opening data file /home/runner/work/tessdata/eng.traineddata)`;
    expect(publicDocumentError(stored)).toBe(PUBLIC_ERROR_MESSAGES.imageNeedsVision);
    expect(PUBLIC_ERROR_MESSAGES.imageNeedsVision).toMatch(/OCR or vision/);
    expect(PUBLIC_ERROR_MESSAGES.imageNeedsVision).not.toMatch(/kreuzberg|tessdata|\/home/i);
  });

  it("never echoes unknown failure text", () => {
    expect(publicDocumentError("ffprobe (127): /secret/path missing")).toBe(PUBLIC_ERROR_MESSAGES.processing);
    expect(publicDocumentError(null)).toBeNull();
    expect(publicDocumentError("")).toBeNull();
  });
});

describe("quarantine refusals (council #339 correctness M2)", () => {
  it("maps every worker reason code to a public reason, unknown codes to a scan failure", () => {
    expect(quarantinePublicReason("malware-detected")).toBe("quarantine-malware");
    for (const code of ["malware-scan-encrypted-content", "malware-scan-pdf-decrypt-failed", "archive-encrypted-entry", "archive-nested-encrypted-entry", "archive-nested-encrypted-pdf"]) expect(quarantinePublicReason(code)).toBe("quarantine-encrypted");
    for (const code of ["mime-mismatch", "archive-embedded-container", "quarantine-inspection-inconsistent"]) expect(quarantinePublicReason(code)).toBe("quarantine-file-type");
    for (const code of ["malware-scan-limit-exceeded", "archive-entry-count-limit", "archive-depth-limit", "archive-expanded-bytes-limit", "archive-entry-size-limit", "archive-expansion-ratio-limit", "archive-nested-entry-size-limit", "archive-nested-entry-count-limit", "archive-nested-expanded-bytes-limit", "archive-nested-object-count-limit", "archive-nested-depth-limit"]) {
      expect(quarantinePublicReason(code), code).toBe("quarantine-scan-limit");
    }
    for (const code of ["archive-nested-zip64", "archive-nested-unsupported-format", "archive-nested-embedded-container", "archive-nested-ole-shared-sectors", "archive-hidden-entry", "archive-unsafe-path", "archive-inspection-failed", "archive-compression-unsupported"]) expect(quarantinePublicReason(code), code).toBe("quarantine-archive");
    for (const code of ["malware-scan-error", "malware-scan-unavailable", "something-new"]) expect(quarantinePublicReason(code)).toBe("quarantine-scan-failed");
  });

  it("reads the worker's stage error, picks the most actionable reason and never echoes the text", () => {
    const stored = quarantineFailureText(["archive-nested-zip64", "malware-detected", "BAD CODE; rm -rf"], ["a nested archive uses ZIP64", "malware detected"]);
    expect(stored.startsWith("quarantined [archive-nested-zip64,malware-detected]: ")).toBe(true);
    expect(quarantineReasonOf(stored)).toBe("quarantine-malware");
    expect(publicDocumentError(`All 1 document failed (quarantine: ${stored})`)).toBe(QUARANTINE_PUBLIC_REASONS["quarantine-malware"]);
    expect(publicDocumentError("quarantined [malware-scan-pdf-decrypt-failed]: encrypted PDF could not be decrypted")).toBe(QUARANTINE_PUBLIC_REASONS["quarantine-encrypted"]);
    expect(quarantineReasonOf("worker quarantined: 2 command teardown(s) could not be verified")).toBeNull();
    expect(publicDocumentError("quarantined: legacy text")).toBe(PUBLIC_ERROR_MESSAGES.processing);
  });
});

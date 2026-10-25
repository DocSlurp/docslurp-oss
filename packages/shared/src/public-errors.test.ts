import { describe, expect, it } from "vitest";
import { DOCUMENT_FAILURE_MARKERS, PUBLIC_ERROR_MESSAGES, publicDocumentError } from "./public-errors.js";

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

import { describe, expect, it } from "vitest";

import { sanitizeUploadFilename } from "../lib/filenames.js";

describe("sanitizeUploadFilename", () => {
  it("strips path segments and leading dashes from upload filenames", () => {
    expect(sanitizeUploadFilename("../-help.pdf")).toBe("help.pdf");
    expect(sanitizeUploadFilename("..\\--output.docx")).toBe("output.docx");
  });

  it("uses the fallback when sanitization removes the whole basename", () => {
    expect(sanitizeUploadFilename("---", "upload.bin")).toBe("upload.bin");
  });

  it("never returns a dot-only path segment", () => {
    expect(sanitizeUploadFilename("..")).toBe("upload.bin");
    expect(sanitizeUploadFilename(".")).toBe("upload.bin");
    expect(sanitizeUploadFilename("...", "document.pdf")).toBe("document.pdf");
    expect(sanitizeUploadFilename("folder/..")).toBe("upload.bin");
    expect(sanitizeUploadFilename(".hidden")).toBe(".hidden");
  });
});

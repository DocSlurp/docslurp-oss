import { describe, expect, it } from "vitest";

import {
  trustedTempDownloadPattern,
  trustedTempFileExtensionForDocument,
} from "../lib/temp-file-names.js";

describe("trusted temp file names", () => {
  it("derives temp file extensions from trusted MIME metadata", () => {
    expect(
      trustedTempFileExtensionForDocument({
        mimeType: "application/pdf; charset=binary",
      }),
    ).toBe(".pdf");
    expect(
      trustedTempFileExtensionForDocument({
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
    ).toBe(".docx");
  });

  it("does not copy untrusted filename extensions into temp paths", () => {
    const pattern = trustedTempDownloadPattern("docslurp-source-", {
      mimeType: "application/pdf",
    });

    expect(pattern).toBe("docslurp-source-*.pdf");
    expect(pattern).not.toContain(".sh");
    expect(pattern).not.toContain("..");
  });

  it("omits the extension when MIME metadata is unknown", () => {
    expect(
      trustedTempDownloadPattern("docslurp-source-", {
        mimeType: "application/x-msdownload",
      }),
    ).toBe("docslurp-source-*");
  });
});

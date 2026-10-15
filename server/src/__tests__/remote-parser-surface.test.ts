import { beforeEach, describe, expect, it, vi } from "vitest";

const envState = {
  remoteIngestComplexFormatsEnabled: false
};

vi.mock("../config.js", () => ({
  env: envState
}));

const {
  assertRemoteIngestParserSurface,
  isComplexRemoteIngestFormat
} = await import("../services/remote-parser-surface.js");

describe("remote parser surface policy", () => {
  beforeEach(() => {
    envState.remoteIngestComplexFormatsEnabled = false;
  });

  it("treats office and html-like formats as complex remote inputs", () => {
    expect(isComplexRemoteIngestFormat("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "report.docx")).toBe(true);
    expect(isComplexRemoteIngestFormat("text/html", "page.html")).toBe(true);
    expect(isComplexRemoteIngestFormat("application/pdf", "paper.pdf")).toBe(false);
  });

  it("blocks complex remote formats when the opt-in flag is disabled", () => {
    expect(() => assertRemoteIngestParserSurface({
      kind: "url",
      filename: "report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    })).toThrow(/REMOTE_INGEST_COMPLEX_FORMATS_ENABLED=true/);
  });

  it("allows complex remote formats when the opt-in flag is enabled", () => {
    envState.remoteIngestComplexFormatsEnabled = true;

    expect(() => assertRemoteIngestParserSurface({
      kind: "connector",
      filename: "report.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    })).not.toThrow();
  });
});

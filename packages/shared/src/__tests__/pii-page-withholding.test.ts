import { describe, expect, it } from "vitest";

import { pagedTextSegments, pageImageSlotPage, pageOfTextOffset, piiPageWithholding, piiWithholdsPage, piiWithholdsPageImageSlot } from "../pii.js";

describe("page-scoped PII withholding", () => {
  it("recognizes page-image slots of this document only", () => {
    expect(pageImageSlotPage("d1", "d1:page-4")).toBe(4);
    expect(pageImageSlotPage("d1", "d1:raster-v3-reader-120dpi-page-12")).toBe(12);
    expect(pageImageSlotPage("d1", "d1:raster-v2-reader-page-2")).toBe(2);
    expect(pageImageSlotPage("d1", "d2:page-4")).toBeNull();
    expect(pageImageSlotPage("d1", "d1:markdown")).toBeNull();
    expect(pageImageSlotPage("d1", "d1:page-0")).toBeNull();
    expect(pageImageSlotPage("d1", "d1:page-4-extra")).toBeNull();
  });

  it("withholds only recorded pages for a page-scoped redaction", () => {
    const metadata = { pii: { redacted: true, withheldArtifactUris: ["s3://b/source"], pageScoped: true, withheldPages: [2] } };
    expect(piiPageWithholding(metadata)).toMatchObject({ all: false, pageScoped: true });
    expect(piiWithholdsPage(metadata, 2)).toBe(true);
    expect(piiWithholdsPage(metadata, 1)).toBe(false);
    expect(piiWithholdsPageImageSlot(metadata, "d1", "d1:page-2")).toBe(true);
    expect(piiWithholdsPageImageSlot(metadata, "d1", "d1:page-3")).toBe(false);
    expect(piiWithholdsPageImageSlot(metadata, "d1", "d1:markdown")).toBe(false);
  });

  it("fails closed for blocks, legacy or malformed records", () => {
    for (const pii of [
      { blocked: true },
      { redacted: true, withheldArtifactUris: ["s3://b/source"] },
      { redacted: true, withheldArtifactUris: [], pageScoped: true, withheldPages: [0] },
      { redacted: true, pageScoped: true, withheldPages: "2" },
      { withheldArtifactUris: "corrupt" },
      // Any blocked value but false withholds everything (the SQL check agrees).
      { blocked: "true", redacted: true, pageScoped: true, withheldPages: [2] },
      { blocked: 1, redacted: true, pageScoped: true, withheldPages: [2] },
      // A redaction that names no page withholds every page.
      { redacted: true, withheldArtifactUris: ["s3://b/source"], pageScoped: true, withheldPages: [] },
      // pageScoped must be the boolean true.
      { redacted: true, withheldArtifactUris: ["s3://b/source"], pageScoped: "true", withheldPages: [2] },
    ]) expect(piiWithholdsPage({ pii }, 1)).toBe(true);
  });

  it("withholds nothing for flag_for_review or a clean document", () => {
    expect(piiWithholdsPage({ pii: { reviewRequired: true, withheldArtifactUris: [] } }, 1)).toBe(false);
    expect(piiWithholdsPage({}, 1)).toBe(false);
    expect(piiWithholdsPage(null, 1)).toBe(false);
  });

  it("places offsets in page-separated text", () => {
    const text = "one\ftwo\fthree";
    expect(pageOfTextOffset(text, 0, 3)).toBe(1);
    expect(pageOfTextOffset(text, text.indexOf("two"), 3)).toBe(2);
    expect(pageOfTextOffset(text, text.indexOf("three"), 3)).toBe(3);
    expect(pageOfTextOffset("no breaks", 2, 1)).toBe(1);
    expect(pageOfTextOffset("no breaks", 2, 5)).toBeNull();
  });

  it("refuses page-separated text whose breaks do not line up with the pages", () => {
    // Unknown page count, a dropped break (two segments for three pages), an extra leading break.
    expect(pageOfTextOffset("one\ftwo", 5, null)).toBeNull();
    expect(pageOfTextOffset("no breaks", 2, null)).toBeNull();
    expect(pageOfTextOffset("one\ftwo", 5, 3)).toBeNull();
    expect(pageOfTextOffset("\fone\ftwo\fthree", 6, 3)).toBeNull();
    // One trailing empty segment (a closing break) is allowed.
    expect(pagedTextSegments("one\ftwo\fthree\f", 3)).toEqual(["one", "two", "three"]);
    expect(pagedTextSegments("one\ftwo", 3)).toBeNull();
    expect(pageOfTextOffset("one\ftwo", -1, 2)).toBeNull();
  });
});

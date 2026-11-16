import { expect, it, vi } from "vitest";

it("imports shared project schemas and validates pipelines without a Node process global", async () => {
  vi.resetModules();
  vi.stubGlobal("process", undefined);
  try {
    const shared = await import("../index.js");
    expect(shared.projectTemplates.length).toBeGreaterThan(0);
    expect(shared.pipelineFeaturesSchema.safeParse({}).success).toBe(true);
    expect(shared.hostPdfExtractorsUnderSandbox({ order: { pdf: ["vm-pdf"] } })).toEqual([]);
    // Explicit server policy still rejects host parsing, including when used in a browser test.
    expect(shared.hostPdfExtractorsUnderSandbox({ order: { pdf: ["poppler-text"] } }, { DOCSLURP_PROFILE: "service" })).toHaveLength(1);
    expect(() => shared.sandboxedPdfConfigured({ DOCSLURP_PDF_MODE: "typo" })).toThrow();
  } finally {
    vi.unstubAllGlobals();
  }
});

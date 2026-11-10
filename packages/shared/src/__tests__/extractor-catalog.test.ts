import { describe, expect, it } from "vitest";
import { builtInDocumentExtractorDescriptors, publicDocumentExtractorDescriptors, resolvePdfMode, sandboxedPdfConfigured } from "../extractors.js";

describe("public extractor catalog", () => {
  it("lists host PDF extractors only in customer-owned local mode, and vm-pdf alone in a VM deployment", () => {
    const ids = (options: Parameters<typeof publicDocumentExtractorDescriptors>[0]) => publicDocumentExtractorDescriptors(options).map((e) => e.id);
    const host = ["doppler-md", "native-pdf", "poppler-text"];
    expect(ids({ nativePdfInstalled: true }).filter((id) => host.includes(id) || id === "vm-pdf")).toEqual([]);
    expect(ids({ nativePdfInstalled: true, localPdf: true })).toEqual(expect.arrayContaining(host));
    expect(ids({ nativePdfInstalled: false, localPdf: true })).not.toContain("native-pdf");
    const vm = ids({ nativePdfInstalled: true, vmPdfInstalled: true, localPdf: true });
    expect(vm).toContain("vm-pdf");
    expect(vm.filter((id) => host.includes(id))).toEqual([]);
    expect(builtInDocumentExtractorDescriptors.some((e) => e.id === "native-pdf")).toBe(true);
  });

  it("resolves the PDF mode: vm wherever a VM is selected, local only when asked, else off", () => {
    expect(resolvePdfMode({})).toBe("off");
    expect(resolvePdfMode({ DOCSLURP_PDF_MODE: "local" })).toBe("local");
    expect(resolvePdfMode({ DOCSLURP_PDF_MODE: "vm" })).toBe("vm");
    expect(resolvePdfMode({ DOCSLURP_PDF_MODE: "local", DOCSLURP_SERVICE_PROFILE: "service" })).toBe("vm");
    expect(sandboxedPdfConfigured({ DOCSLURP_SERVICE_PROFILE: " Service " })).toBe(true);
    expect(sandboxedPdfConfigured({ DOCSLURP_SERVICE_PROFILE: "self-hosted" })).toBe(false);
    expect(() => resolvePdfMode({ DOCSLURP_PDF_MODE: "true" })).toThrow();
  });
});

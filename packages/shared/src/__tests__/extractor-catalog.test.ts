import { describe, expect, it } from "vitest";
import { builtInDocumentExtractorDescriptors, dopplerHostPdfEnabled, publicDocumentExtractorDescriptors, sandboxedPdfConfigured } from "../extractors.js";

describe("public extractor catalog", () => {
  it("hides native-pdf unless the engine is installed", () => {
    expect(builtInDocumentExtractorDescriptors.some((e) => e.id === "native-pdf")).toBe(true);
    expect(publicDocumentExtractorDescriptors({ nativePdfInstalled: false }).some((e) => e.id === "native-pdf")).toBe(false);
    expect(publicDocumentExtractorDescriptors({ nativePdfInstalled: true }).some((e) => e.id === "native-pdf")).toBe(true);
    // native-pdf, vm-pdf and doppler-md are each hidden until the deployment has (or opts in to) them.
    expect(publicDocumentExtractorDescriptors({ nativePdfInstalled: false }).length).toBe(builtInDocumentExtractorDescriptors.length - 3);
    expect(publicDocumentExtractorDescriptors({ nativePdfInstalled: false }).some(e => e.id === "vm-pdf")).toBe(false);
    expect(publicDocumentExtractorDescriptors({ nativePdfInstalled: false, vmPdfInstalled: true }).some(e => e.id === "vm-pdf")).toBe(true);
  });

  it("lists doppler-md only where the operator opts in to Doppler host parsing, never beside vm-pdf", () => {
    const has = (options: Parameters<typeof publicDocumentExtractorDescriptors>[0]) => publicDocumentExtractorDescriptors(options).some((e) => e.id === "doppler-md");
    expect(has({ nativePdfInstalled: false })).toBe(false);
    expect(has({ nativePdfInstalled: false, dopplerHostPdf: true })).toBe(true);
    expect(has({ nativePdfInstalled: false, dopplerHostPdf: true, vmPdfInstalled: true })).toBe(false);
  });

  it("treats the service profile as a sandboxed PDF deployment and parses the Doppler opt-in strictly", () => {
    expect(sandboxedPdfConfigured({ DOCSLURP_SERVICE_PROFILE: "service" })).toBe(true);
    expect(sandboxedPdfConfigured({ DOCSLURP_SERVICE_PROFILE: " Service " })).toBe(true);
    expect(sandboxedPdfConfigured({ DOCSLURP_SERVICE_PROFILE: "self-hosted" })).toBe(false);
    expect(sandboxedPdfConfigured({})).toBe(false);
    expect(dopplerHostPdfEnabled({})).toBe(false);
    expect(dopplerHostPdfEnabled({ DOCSLURP_DOPPLER_HOST_PDF: "0" })).toBe(false);
    expect(dopplerHostPdfEnabled({ DOCSLURP_DOPPLER_HOST_PDF: "1" })).toBe(true);
    expect(() => dopplerHostPdfEnabled({ DOCSLURP_DOPPLER_HOST_PDF: "true" })).toThrow();
  });
});

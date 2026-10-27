import { describe, expect, it } from "vitest";
import { builtInDocumentExtractorDescriptors, publicDocumentExtractorDescriptors } from "../extractors.js";

describe("public extractor catalog", () => {
  it("hides native-pdf unless the engine is installed", () => {
    expect(builtInDocumentExtractorDescriptors.some((e) => e.id === "native-pdf")).toBe(true);
    expect(publicDocumentExtractorDescriptors({ nativePdfInstalled: false }).some((e) => e.id === "native-pdf")).toBe(false);
    expect(publicDocumentExtractorDescriptors({ nativePdfInstalled: true }).some((e) => e.id === "native-pdf")).toBe(true);
    expect(publicDocumentExtractorDescriptors({ nativePdfInstalled: false }).length).toBe(builtInDocumentExtractorDescriptors.length - 2);
    expect(publicDocumentExtractorDescriptors({ nativePdfInstalled: false }).some(e => e.id === "doppler")).toBe(false);
    expect(publicDocumentExtractorDescriptors({ nativePdfInstalled: false, dopplerInstalled: true }).some(e => e.id === "doppler")).toBe(true);
  });
});

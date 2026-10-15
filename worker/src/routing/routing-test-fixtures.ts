import {
  PAGE_FEATURES_SCHEMA_VERSION,
  PAGE_INPUT_SCHEMA_VERSION,
  buildDecisionModelCatalog,
  type DecisionModel,
  type PageInput,
  type TextFacts,
} from "@docslurp/shared";

export function catalogModel(id: string): DecisionModel {
  const model = buildDecisionModelCatalog({ env: { PERPLEXITYAI_API_KEY: true, OPENROUTER_API_KEY: true, LIQUID_API_KEY: true } }).models.find((m) => m.id === id);
  if (!model) throw new Error(`decision model ${id} not in catalog`);
  return model;
}

export function makePage(pageNumber: number, overrides: { facts?: Partial<TextFacts>; images?: number; thumbnail?: string } = {}): PageInput {
  const imageCount = overrides.images ?? 0;
  return {
    schemaVersion: PAGE_INPUT_SCHEMA_VERSION,
    features: {
      schemaVersion: PAGE_FEATURES_SCHEMA_VERSION,
      pageNumber,
      documentFormat: "pdf",
      pageCount: 40,
      native: {
        charCount: 2400, wordCount: 412, textCoverage: 0.5, fontCount: 3, unmappedGlyphRatio: 0,
        mathGlyphRatio: 0, tableRuleScore: 0, garbled: false, plausibility: 1,
      },
      raster: {
        imageCoverage: 0, largestImageCoverage: 0, fullPageImage: false, vectorDrawingCount: 0,
        uncoveredVectorRatio: 0, smallestFontPt: 9,
      },
      geometry: { widthPt: 612, heightPt: 792, rotation: 0 },
      heuristic: { route: "straightforward-text", extractorHint: null, specializedKinds: [], ocrAuthorized: null, textDensityScore: 0.5 },
      decisions: null,
      provenance: { probe: "pymupdf-probe", probeMs: 3 },
    },
    textFacts: { wordCount: 412, imageCount, imageCoverage: imageCount ? 0.4 : 0, textLayerStatus: "ok", ...overrides.facts },
    images: Array.from({ length: imageCount }, (_, index) => ({
      index,
      bbox: { x: 10, y: 10, width: 200, height: 100 },
      coverage: 0.4 / imageCount,
    })),
    thumbnail: overrides.thumbnail ? { uri: overrides.thumbnail, widthPx: 384, heightPx: 384 } : undefined,
  };
}

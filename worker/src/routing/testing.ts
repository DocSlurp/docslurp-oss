import { fileURLToPath } from "node:url";

import {
  PAGE_FEATURES_SCHEMA_VERSION,
  PAGE_INPUT_SCHEMA_VERSION,
  buildRoutingTargetCatalog,
  type AdaptivePageRoute,
  type PageInput,
  type RoutingTarget,
} from "@docslurp/shared";
import { loadPolicyPackFromFile } from "./policy.js";

// Test helpers shared by the routing tests (not exported from the barrel).

export interface PageSpec {
  pageNumber?: number;
  words?: number;
  route?: AdaptivePageRoute;
  hint?: string | null;
  textLayer?: "ok" | "suspect" | "absent" | "unknown" | "ocr-layer";
  /** OCR-layer agreement (TL1); only meaningful with textLayer "ocr-layer". */
  ocrAgreement?: number | null;
  images?: Array<{ coverage: number }>;
  math?: number;
  tableRule?: number;
  fullPageImage?: boolean;
  vectors?: number;
}

export function makePage(s: PageSpec = {}): PageInput {
  const words = s.words ?? 400;
  const images = (s.images ?? []).map((im, index) => ({
    index,
    coverage: im.coverage,
    bbox: { x: 0, y: 0, width: 100 * im.coverage, height: 100 },
  }));
  return {
    schemaVersion: PAGE_INPUT_SCHEMA_VERSION,
    features: {
      schemaVersion: PAGE_FEATURES_SCHEMA_VERSION,
      pageNumber: s.pageNumber ?? 1,
      documentFormat: "pdf",
      pageCount: 10,
      native: {
        charCount: words * 6,
        wordCount: words,
        textCoverage: 0.6,
        fontCount: 3,
        unmappedGlyphRatio: 0,
        mathGlyphRatio: s.math ?? 0,
        tableRuleScore: s.tableRule ?? 0,
        garbled: false,
        plausibility: words > 0 ? 0.97 : 0,
      },
      raster: {
        imageCoverage: Math.min(1, images.reduce((a, i) => a + i.coverage, 0)),
        largestImageCoverage: Math.max(0, ...images.map((i) => i.coverage)),
        fullPageImage: s.fullPageImage ?? false,
        vectorDrawingCount: s.vectors ?? 0,
        uncoveredVectorRatio: 0,
        smallestFontPt: 10,
      },
      geometry: { widthPt: 612, heightPt: 792, rotation: 0 },
      heuristic: {
        route: s.route ?? "straightforward-text",
        extractorHint: s.hint === undefined ? "cheap-text" : s.hint,
        specializedKinds: [],
        ocrAuthorized: null,
        textDensityScore: 0.5,
      },
      decisions: null,
      provenance: { probe: "pymupdf-probe", probeMs: 1 },
    },
    textFacts: {
      wordCount: words,
      imageCount: images.length,
      imageCoverage: images.length ? images.reduce((a, i) => a + i.coverage, 0) : 0,
      textLayerStatus: s.textLayer ?? (words > 0 ? "ok" : "absent"),
      ...(s.ocrAgreement !== undefined ? { ocrLayerAgreement: s.ocrAgreement } : {}),
    },
    images,
  };
}

export function testCatalog(): RoutingTarget[] {
  const prices = {
    asOf: "2026-10-12",
    models: {
      "google/gemini-2.5-flash-lite": { input: 0.1, output: 0.4, vision: true },
      "google/gemini-3.1-flash-lite": { input: 0.25, output: 1.5, vision: true },
      "google/gemini-3.5-flash-lite": { input: 0.2, output: 1.2, vision: true },
      "z-ai/glm-5.3-flash": { input: 0.2, output: 1.1, vision: true },
      "google/gemini-3.5-flash": { input: 1.5, output: 9, vision: true },
      "openai/gpt-6-luna": { input: 1.25, output: 10, vision: true },
    },
  };
  return buildRoutingTargetCatalog({
    prices,
    env: { OPENROUTER_API_KEY: true, LIGHTONOCR_3_ENDPOINT_URL: true },
    privateEndpoints: [{ modelId: "lightonocr-3", hourlyUsd: 0.45, pagesPerMinuteObserved: 160 }],
    checkedAt: "2026-10-12",
  }).targets;
}

/** Hand-set prior pack (v0): a stable test fixture, not shipped (the runtime loads the fitted pack). */
export const TEST_PRIOR_PACK_PATH = fileURLToPath(new URL("./testdata/page-router-dm-v0-prior.json", import.meta.url));
export const testPack = () => loadPolicyPackFromFile(TEST_PRIOR_PACK_PATH);
export const BIG_BUDGET = { limitUsd: 100, marginFloor: 0 } as const;

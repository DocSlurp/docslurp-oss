import { describe, expect, it } from "vitest";
import { documentCostStats } from "../lib/document-cost-stats.js";
import type { PageLayoutFacts } from "../lib/page-layout-facts.js";

describe("settings-independent structural cost observations", () => {
  it("keeps missing and skipped evidence unknown", () => {
    const stats = documentCostStats(undefined, 3);
    expect(stats.routes.unknown).toBe(3);
    expect(stats.images.unknownPages).toBe(3);
    expect(stats.tables.unknownPages).toBe(3);
    expect(stats.charts.count).toBeNull();
    expect(stats.scanCopy).toBeNull();
  });
  it("retains image sizes, classes and repeated placements without feature settings", () => {
    const page: PageLayoutFacts = { words: 100, tables: null, grids: null, tableCoverage: null,
      textLayer: "invisible", images: [{ widthPx: 1000, heightPx: 1000, coverage: 0.8, repeated: true,
        bbox: null, ppi: [null, null], wordsInside: null, bytesPerPixel: null, bitsPerComponent: null,
        colorSpace: "other", encoding: "other" }] };
    const stats = documentCostStats(new Map([[1, page]]), 2);
    expect(stats.routes.table).toBe(0);
    expect(stats.routes.unknown).toBe(2);
    expect(stats.textLayers.invisible).toBe(1);
    expect(stats.images.placements).toBe(1);
    expect(stats.images.repeatedPlacements).toBe(1);
    expect(stats.images.megapixels).toEqual([0, 0, 0, 1, 0]);
    expect(stats.images.bytesUnknown).toBe(1);
  });
});

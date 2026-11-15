import { expect, it } from "vitest";
import { parsePageCostEvidence } from "../lib/page-cost-evidence.js";
import { documentCostStats } from "../lib/document-cost-stats.js";

it("refuses malicious and oversized observations without inventing zeros", () => {
  const p = parsePageCostEvidence({ vectorPaths: Infinity, vectorClusters: -1,
    imageObjects: Array(65).fill(1), chartCandidates: "3", copyClasses: { copy: 1, decode: -1, render: 0 } });
  expect(p.vectorPaths).toBeNull();
  expect(p.vectorClusters).toBeNull();
  expect(p.imageObjects).toBeNull();
  expect(p.chartCandidates).toBeNull();
  expect(p.copyClasses).toBeNull();
  expect(documentCostStats(undefined, Infinity).pages).toBe(0);
});
it("distinguishes nominations, confirmation, partial dedup and lexical evidence", () => {
  const evidence = new Map([[1, { vectorPaths: 5, chartCandidates: 2, imageObjects: [3, 3], lexicalText: false }],
    [2, { imageObjects: [3, 4], lexicalText: true }]]);
  const stats = documentCostStats(undefined, 3, evidence);
  expect(stats.routes['ocr-read']).toBe(1);
  expect(stats.routes.table).toBe(1);
  expect(stats.observations.chartCandidates).toEqual({ count: 2, unknownPages: 2 });
  expect(stats.observations.confirmedCharts).toEqual({ count: 0, unknownPages: 3 });
  expect(stats.observations.identities).toEqual({ uniqueObjects: 2, extraPlacements: 2, unknownPages: 1 });
  expect(stats.observations.lexicalText).toEqual({ presentPages: 1, absentPages: 1, unknownPages: 1 });
});

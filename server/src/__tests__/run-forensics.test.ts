import { describe, expect, it } from "vitest";

import { durationForStage, parseArtifactSlot, summarizeHeatmapPages } from "../services/run-forensics.js";

describe("parseArtifactSlot", () => {
  it("extracts document scoped artifact metadata", () => {
    expect(parseArtifactSlot("doc-1:markdown-manifest")).toEqual({
      documentId: "doc-1",
      name: "markdown-manifest",
      category: "markdown",
      stage: "markdown-manifest"
    });
  });

  it("handles run scoped artifact slots", () => {
    expect(parseArtifactSlot("summary")).toEqual({
      documentId: null,
      name: "summary",
      category: "other",
      stage: null
    });
  });
});

describe("summarizeHeatmapPages", () => {
  it("calculates average plausibility, low-plausibility pages, and dominant strategy", () => {
    expect(
      summarizeHeatmapPages([
        { pageNumber: 1, plausibilityScore: 0.9, strategy: "consensus", charCount: 1000, tokenEstimate: 250 },
        { pageNumber: 2, plausibilityScore: 0.4, strategy: "consensus", charCount: 900, tokenEstimate: 220 },
        { pageNumber: 3, plausibilityScore: 0.2, strategy: "vision", charCount: 700, tokenEstimate: 180 }
      ])
    ).toEqual({
      averagePlausibilityScore: 0.5,
      lowPlausibilityPages: 2,
      strategy: "consensus"
    });
  });

  it("returns empty metrics for missing pages", () => {
    expect(summarizeHeatmapPages([])).toEqual({
      averagePlausibilityScore: null,
      lowPlausibilityPages: 0,
      strategy: null
    });
  });
});

describe("durationForStage", () => {
  it("prefers explicit duration in stage stats", () => {
    expect(
      durationForStage({
        runId: "run-1",
        documentId: null,
        stage: "normalize",
        status: "completed",
        attempts: 1,
        artifactUri: null,
        stats: { durationMs: 4800 },
        error: null,
        startedAt: "2026-03-07T10:00:00.000Z",
        completedAt: "2026-03-07T10:00:05.000Z",
        updatedAt: "2026-03-07T10:00:05.000Z"
      })
    ).toBe(4800);
  });

  it("falls back to timestamps when no duration stat exists", () => {
    expect(
      durationForStage({
        runId: "run-1",
        documentId: "doc-1",
        stage: "extract-markdown",
        status: "completed",
        attempts: 2,
        artifactUri: null,
        stats: {},
        error: null,
        startedAt: "2026-03-07T10:00:00.000Z",
        completedAt: "2026-03-07T10:00:03.500Z",
        updatedAt: "2026-03-07T10:00:03.500Z"
      })
    ).toBe(3500);
  });
});

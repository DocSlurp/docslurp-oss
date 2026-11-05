import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildRoutingEvalReport,
  parseRoutingEvalManifest,
  scoreRoutingEvalFixture,
  type RoutingEvalObservation,
} from "../benchmarks/document-routing-eval.js";

const fixtureRoot = path.resolve(process.cwd(), "testdata/pdf-fixtures");
const manifestPath = path.join(fixtureRoot, "document-routing-eval-v1.json");

describe("document routing eval", () => {
  it("keeps a valid, provenance-safe manifest of tracked static assets", () => {
    const manifest = parseRoutingEvalManifest(
      JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
    );

    expect(manifest.fixtures.length).toBeGreaterThan(0);
    expect(manifest.fixtures.flatMap((fixture) => fixture.tags)).toEqual(
      expect.arrayContaining(["handwriting", "scanned", "forms", "tables", "born-digital"]),
    );
    for (const fixture of manifest.fixtures) {
      expect(existsSync(path.resolve(fixtureRoot, fixture.path))).toBe(true);
    }
  });

  it("scores exact page-level routing and OCR decisions", () => {
    const manifest = parseRoutingEvalManifest(
      JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
    );
    const fixture = manifest.fixtures[0]!;
    const observation: RoutingEvalObservation = {
      fixtureId: fixture.id,
      latencyMs: 24,
      suggestedPlaybook: "review-grade",
      visionPolicy: "aggressive",
      pages: [
        {
          pageNumber: 1,
          route: "handwriting-or-degraded",
          extractorHint: "vision-rescue",
          ocrAuthorized: true,
        },
      ],
    };

    expect(scoreRoutingEvalFixture(fixture, observation)).toMatchObject({
      passed: true,
      qualityScore: 1,
    });
  });

  it("fails quality when a scan is incorrectly sent to cheap text", () => {
    const manifest = parseRoutingEvalManifest(
      JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
    );
    const fixture = manifest.fixtures[0]!;
    const result = scoreRoutingEvalFixture(fixture, {
      fixtureId: fixture.id,
      latencyMs: 12,
      suggestedPlaybook: "fast",
      visionPolicy: "skip",
      pages: [
        {
          pageNumber: 1,
          route: "straightforward-text",
          extractorHint: "cheap-text",
          ocrAuthorized: false,
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metric: "page.1.route", passed: false }),
        expect.objectContaining({ metric: "page.1.ocrAuthorized", passed: false }),
      ]),
    );
  });

  it("gates quality, fixture pass rate, latency, hosted calls, and estimated cost", () => {
    const manifest = parseRoutingEvalManifest(
      JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
    );
    const fixture = manifest.fixtures[0]!;
    const unmarked = { ...manifest, fixtures: [{ ...fixture, expectedFailure: undefined }] };
    const passingResult = scoreRoutingEvalFixture(unmarked.fixtures[0]!, {
      fixtureId: fixture.id,
      latencyMs: 30,
      suggestedPlaybook: "review-grade",
      visionPolicy: "aggressive",
      pages: [
        {
          pageNumber: 1,
          route: "handwriting-or-degraded",
          extractorHint: "vision-rescue",
          ocrAuthorized: true,
        },
      ],
    });
    const report = buildRoutingEvalReport({
      manifest: unmarked,
      results: [passingResult],
      generatedAt: "2026-08-17T00:00:00.000Z",
    });

    expect(report).toMatchObject({
      passed: true,
      fixturePassRate: 1,
      qualityScore: 1,
      hostedAiCalls: 0,
      estimatedCostUsd: 0,
    });
    expect(report.gateChecks.map((check) => check.metric)).toEqual([
      "qualityScore",
      "fixturePassRate",
      "p95LatencyMs",
      "hostedAiCalls",
      "estimatedCostUsd",
      "expectedFailuresStillFail",
    ]);
  });

  const scan = (fixtureId: string) => ({
    fixtureId,
    latencyMs: 10,
    suggestedPlaybook: "review-grade",
    visionPolicy: "aggressive" as const,
    pages: [{ pageNumber: 1, route: "handwriting-or-degraded" as const, extractorHint: "vision-rescue" as const, ocrAuthorized: true }],
  });
  const fixtureWith = (id: string, expectedFailure?: { reason: string }) => ({
    id,
    path: `${id}.pdf`,
    tags: ["scanned"],
    ...(expectedFailure ? { expectedFailure } : {}),
    expected: scan(id),
  });
  const manifestOf = (fixtures: ReturnType<typeof fixtureWith>[]) => parseRoutingEvalManifest({
    schemaVersion: "document-routing-eval@v1",
    description: "test",
    gates: { minimumQualityScore: 1, minimumFixturePassRate: 1, maximumP95LatencyMs: 5000, maximumHostedAiCalls: 0, maximumEstimatedCostUsd: 0 },
    fixtures,
  });
  const reason = { reason: "evidence for this case is not produced by any shipped extractor" };

  it("holds an expected failure out of the gate but still reports it over all fixtures", () => {
    const manifest = manifestOf([fixtureWith("ok"), fixtureWith("gap", reason)]);
    const results = [
      scoreRoutingEvalFixture(manifest.fixtures[0]!, scan("ok")),
      scoreRoutingEvalFixture(manifest.fixtures[1]!, { ...scan("gap"), suggestedPlaybook: "fast" }),
    ];
    const report = buildRoutingEvalReport({ manifest, results });
    expect(report).toMatchObject({ passed: true, fixtureCount: 1, fixturePassRate: 1, allFixtures: { fixtureCount: 2, fixturePassRate: 0.5 } });
    expect(report.expectedFailures).toEqual([expect.objectContaining({ fixtureId: "gap" })]);
  });

  it("fails the gate when an expected failure starts passing (strict)", () => {
    const manifest = manifestOf([fixtureWith("ok"), fixtureWith("gap", reason)]);
    const report = buildRoutingEvalReport({
      manifest,
      results: manifest.fixtures.map((fixture) => scoreRoutingEvalFixture(fixture, scan(fixture.id))),
    });
    expect(report.passed).toBe(false);
    expect(report.gateChecks.find((check) => check.metric === "expectedFailuresStillFail")).toMatchObject({ passed: false, actual: ["gap"] });
  });

  it("refuses an expected failure without a reason", () => {
    expect(() => manifestOf([fixtureWith("gap", { reason: "" })])).toThrow("without a reason");
  });

  it("fails the gate when a gated fixture regresses", () => {
    const manifest = manifestOf([fixtureWith("ok"), fixtureWith("gap", reason)]);
    const report = buildRoutingEvalReport({
      manifest,
      results: [
        scoreRoutingEvalFixture(manifest.fixtures[0]!, { ...scan("ok"), visionPolicy: "skip" }),
        scoreRoutingEvalFixture(manifest.fixtures[1]!, { ...scan("gap"), visionPolicy: "skip" }),
      ],
    });
    expect(report.passed).toBe(false);
  });
});

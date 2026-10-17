import { describe, expect, it } from "vitest";

import {
  defaultGraphConfig,
  estimateGraphBuild,
  graphConfigFingerprint,
  graphWindowsForDocument,
  updateWorkspaceGraphSchema,
} from "../index.js";

const pricing = { costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 };

describe("graph config fingerprint", () => {
  it.each(["g1-30b2cf43", "g2-30b2cf43"])("marks graphs with old edge or chunk identities stale (%s)", (previousFingerprint) => {
    expect(graphConfigFingerprint({ domain: null, entityTypes: [], depth: "standard" }, "example-model"))
      .not.toBe(previousFingerprint);
  });

  it("ignores entity type order and domain whitespace but not depth or model", () => {
    const base = graphConfigFingerprint({ domain: "Contracts", entityTypes: ["party", "clause"], depth: "standard" }, "m");
    expect(graphConfigFingerprint({ domain: " Contracts ", entityTypes: ["clause", "party"], depth: "standard" }, "m")).toBe(base);
    expect(graphConfigFingerprint({ domain: "Contracts", entityTypes: ["party", "clause"], depth: "deep" }, "m")).not.toBe(base);
    expect(graphConfigFingerprint({ domain: "Contracts", entityTypes: ["party", "clause"], depth: "standard" }, "other")).not.toBe(base);
  });

  it("treats an empty vocabulary as the generic set", () => {
    expect(graphConfigFingerprint(defaultGraphConfig, "m")).toBe(
      graphConfigFingerprint({ ...defaultGraphConfig, entityTypes: ["product", "person", "organization", "concept", "date", "location"] }, "m"),
    );
  });
});

describe("estimateGraphBuild", () => {
  it("caps windows per document by depth", () => {
    expect(graphWindowsForDocument(0, "deep")).toBe(0);
    expect(graphWindowsForDocument(500_000, "lean")).toBe(1);
    expect(graphWindowsForDocument(500_000, "standard")).toBe(4);
    expect(graphWindowsForDocument(20_000, "deep")).toBe(2);
  });

  it("prices deeper extraction higher and scales time with worker concurrency", () => {
    const documentChars = [40_000, 120_000, 8_000];
    const estimate = (depth: "lean" | "standard" | "deep", concurrency = 1) =>
      estimateGraphBuild({ documentChars, config: { ...defaultGraphConfig, depth }, pricing, concurrency });
    expect(estimate("lean").costCents).toBeLessThan(estimate("standard").costCents);
    expect(estimate("standard").costCents).toBeLessThan(estimate("deep").costCents);
    expect(estimate("standard", 4).seconds).toBeCloseTo(estimate("standard").seconds / 4, -1);
    expect(estimate("standard")).toMatchObject({ documents: 3, windows: 9, basis: "default" });
    expect(estimate("standard").costCentsHigh).toBe(estimate("standard").costCents * 2);
  });

  it("uses observed per-window figures once there are enough samples", () => {
    const observed = estimateGraphBuild({
      documentChars: [10_000, 10_000],
      config: defaultGraphConfig,
      pricing,
      concurrency: 1,
      calibration: { sampleWindows: 40, inputTokensPerWindow: 1000, outputTokensPerWindow: 100, secondsPerWindow: 2 },
    });
    expect(observed.basis).toBe("observed");
    expect(observed.inputTokens - observed.communitySummaries * 380).toBe(2000);
    expect(observed.outputTokens - observed.communitySummaries * 120).toBe(200);
  });
});

describe("updateWorkspaceGraphSchema", () => {
  it("normalizes entity types and rejects unknown keys", () => {
    expect(updateWorkspaceGraphSchema.parse({ entityTypes: ["Payment Term"] })).toEqual({ entityTypes: ["payment_term"] });
    expect(updateWorkspaceGraphSchema.safeParse({ graphRag: true }).success).toBe(false);
  });
});

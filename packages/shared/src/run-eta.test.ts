import { describe, expect, it } from "vitest";
import { activitySummarySchema, combineRunEtas, estimateRunEta, etaBucket, historicalPagesPerMinute, uploadSessionProgressSchema } from "./run-eta.js";

const now = Date.parse("2026-11-18T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

describe("etaBucket", () => {
  it.each([
    [0, "<1m"], [59.9, "<1m"], [60, "1-5m"], [299, "1-5m"], [300, "5-15m"], [899, "5-15m"], [900, "15-60m"],
    [3599, "15-60m"], [3600, "1-3h"], [10_799, "1-3h"], [10_800, ">3h"], [1e9, ">3h"],
  ])("%s seconds is %s", (seconds, bucket) => {
    expect(etaBucket(seconds)).toBe(bucket);
  });

  it("treats a non-finite or negative remaining time as under a minute", () => {
    expect(etaBucket(Number.NaN)).toBe("<1m");
    expect(etaBucket(-5)).toBe("<1m");
  });
});

describe("estimateRunEta", () => {
  it("uses a processing run's own rate since its worker started", () => {
    // 100 pages in 10 minutes = 10 pages/min; 400 left = 40 minutes.
    const eta = estimateRunEta({ status: "processing", pagesTotal: 500, pagesProcessed: 100, startedAt: minutesAgo(10), now });
    expect(eta).toEqual({ seconds: 2400, bucket: "15-60m", basis: "observed", estimate: false, pagesPerMinute: 10 });
  });

  it("uses project history for a queued run and flags it as an estimate", () => {
    // 600 pages in 60 minutes = 10 pages/min; 50 pages = 5 minutes.
    const eta = estimateRunEta({ status: "queued", pagesTotal: 50, pagesProcessed: 0, startedAt: null, history: { pages: 600, runtimeMs: 3_600_000 }, now });
    expect(eta).toEqual({ seconds: 300, bucket: "5-15m", basis: "historical", estimate: true, pagesPerMinute: 10 });
  });

  it("falls back to history for a run that has not worked long enough to have a rate", () => {
    const eta = estimateRunEta({ status: "processing", pagesTotal: 20, pagesProcessed: 0, startedAt: minutesAgo(0.05), history: { pages: 100, runtimeMs: 60_000 }, now });
    expect(eta?.basis).toBe("historical");
    expect(eta?.estimate).toBe(true);
  });

  it("returns null with no basis rather than guessing", () => {
    expect(estimateRunEta({ status: "queued", pagesTotal: 50, pagesProcessed: 0, startedAt: null, now })).toBeNull();
    expect(estimateRunEta({ status: "queued", pagesTotal: 50, pagesProcessed: 0, startedAt: null, history: { pages: 3, runtimeMs: 1000 }, now })).toBeNull();
    expect(estimateRunEta({ status: "processing", pagesTotal: 50, pagesProcessed: 0, startedAt: minutesAgo(5), history: { pages: 100, runtimeMs: 0 }, now })).toBeNull();
  });

  it("returns null while the page count is unknown", () => {
    expect(estimateRunEta({ status: "processing", pagesTotal: 0, pagesProcessed: 0, startedAt: minutesAgo(5), history: { pages: 100, runtimeMs: 60_000 }, now })).toBeNull();
  });

  it("returns null for blocked and finished runs", () => {
    for (const status of ["blocked", "completed", "failed"]) {
      expect(estimateRunEta({ status, pagesTotal: 10, pagesProcessed: 5, startedAt: minutesAgo(5), history: { pages: 100, runtimeMs: 60_000 }, now })).toBeNull();
    }
  });

  it("reports under a minute for a run whose pages are all done but which has not finished", () => {
    expect(estimateRunEta({ status: "processing", pagesTotal: 10, pagesProcessed: 12, startedAt: minutesAgo(1), now })).toMatchObject({ seconds: 0, bucket: "<1m" });
  });

  it("ignores a start time in the future", () => {
    expect(estimateRunEta({ status: "processing", pagesTotal: 10, pagesProcessed: 5, startedAt: new Date(now + 60_000), now })).toBeNull();
  });
});

describe("historicalPagesPerMinute", () => {
  it("needs enough completed pages and a positive runtime", () => {
    expect(historicalPagesPerMinute(null)).toBeNull();
    expect(historicalPagesPerMinute({ pages: 9, runtimeMs: 60_000 })).toBeNull();
    expect(historicalPagesPerMinute({ pages: 120, runtimeMs: 120_000 })).toBe(60);
  });
});

describe("combineRunEtas", () => {
  const observed = { seconds: 120, bucket: "1-5m" as const, basis: "observed" as const, estimate: false, pagesPerMinute: 5 };
  const historical = { seconds: 1000, bucket: "15-60m" as const, basis: "historical" as const, estimate: true, pagesPerMinute: 2 };

  it("takes the longest run and is an estimate when any input is", () => {
    expect(combineRunEtas([observed])).toEqual({ seconds: 120, bucket: "1-5m", estimate: false });
    expect(combineRunEtas([observed, historical])).toEqual({ seconds: 1000, bucket: "15-60m", estimate: true });
  });

  it("is null with no runs or when any run has no basis", () => {
    expect(combineRunEtas([])).toBeNull();
    expect(combineRunEtas([observed, null])).toBeNull();
  });
});

describe("contracts", () => {
  it("parses a summary and an upload progress block", () => {
    const counts = { runs: 1, documents: 2, pages: 3 };
    expect(activitySummarySchema.parse({
      queued: counts, inProgress: { ...counts, pagesProcessed: 1, pagesTotal: 4 }, recentlyCompleted: counts, recentWindowMinutes: 15,
      pagesPerMinute: null, eta: null, truncated: false, generatedAt: new Date(now).toISOString(),
    }).truncated).toBe(false);
    expect(uploadSessionProgressSchema.parse({ files: { total: 2, completed: 1 }, bytes: { total: 10, completed: 5 }, run: null }).run).toBeNull();
  });
});

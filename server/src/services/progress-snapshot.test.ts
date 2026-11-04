import { describe, expect, it } from "vitest";
import type { WorkspaceRunProgressSnapshot } from "@docslurp/shared";
import { redactOperatorEvent, redactOperatorKeys, redactOperatorRunFields } from "./progress-snapshot.js";

function snapshot(): WorkspaceRunProgressSnapshot {
  return {
    run: { id: "run-1" },
    stages: [],
    recentEvents: [],
    temporal: null,
    artifacts: {},
    stats: { cpuUserMs: 5, peakRssBytes: 9, rssDeltaBytes: 1, workerClass: "perf-8x", region: "iad", inputTokens: 10, costCents: 3, pageProgress: { d: { extract: 2 } } },
    progress: {
      stageRollups: [{ stage: "extract", cpuMs: 40, peakRssBytes: 1000, durationMs: 90 }],
      usageTotals: { costCents: 3, workerClasses: ["perf-8x"], regions: ["iad"] },
      resourceTotals: { elapsedMs: 100, cpuUserMs: 5, cpuSystemMs: 6, cpuTotalMs: 11, rssDeltaBytes: 1, peakRssBytes: 9 },
    },
  } as unknown as WorkspaceRunProgressSnapshot;
}

describe("redactOperatorRunFields", () => {
  it("removes worker CPU, RAM, worker classes and regions but keeps customer-facing numbers", () => {
    const input = snapshot();
    const out = redactOperatorRunFields(input);
    expect(out.stats).toEqual({ inputTokens: 10, costCents: 3, pageProgress: { d: { extract: 2 } } });
    expect(out.progress!.resourceTotals).toEqual({ elapsedMs: 100, cpuUserMs: 0, cpuSystemMs: 0, cpuTotalMs: 0, rssDeltaBytes: 0, peakRssBytes: 0 });
    expect(out.progress!.usageTotals).toMatchObject({ costCents: 3, workerClasses: [], regions: [] });
    expect(out.progress!.stageRollups[0]).toMatchObject({ cpuMs: 0, peakRssBytes: 0, durationMs: 90 });
    expect(JSON.stringify(out)).not.toMatch(/perf-8x|iad/);
    // The input is not mutated, so an operator's cached copy stays whole.
    expect(input.stats.cpuUserMs).toBe(5);
  });
});


describe("operator diagnostics nested in events and stage stats", () => {
  const heartbeat = {
    id: "e1", userId: "u", runId: "run-1", documentId: null, stage: "extract", type: "heartbeat", status: null, message: null,
    progress: { completedDocumentStages: 3 }, stats: { rssMb: 812, cpuMs: 4100, pages: 12 },
    payload: { kind: "heartbeat", stageName: "extract", metrics: { inputTokens: 5, outputTokens: 7, costCents: 2, rssBytes: 123456789, peakRssBytes: 234567890, cpuUserMs: 910, cpuSystemMs: 80 } },
    createdAt: "2026-11-04T00:00:00Z",
  };
  const withEvents = () => ({
    ...snapshot(),
    recentEvents: [heartbeat],
    stages: [{ stageName: "extract", status: "completed", stats: { pages: 12, cpuSeconds: 3.2, rssBytes: 5, workerClass: "perf-8x", regionBoxes: 4, nested: { peakRssMb: 9, region: "iad", kept: 1 } } }],
    run: { id: "run-1", stats: { documents: 2, workerId: "machine-91", cpuTotalMs: 12 } },
  } as unknown as WorkspaceRunProgressSnapshot);

  it("removes resource and machine keys from heartbeat events, stage stats and run stats at any depth", () => {
    const out = redactOperatorRunFields(withEvents());
    // Rollups and totals keep their (zeroed) schema fields; everything free-form is checked by key and value.
    const text = JSON.stringify({ run: out.run, stages: out.stages, recentEvents: out.recentEvents, stats: out.stats });
    for (const secret of ["rssBytes", "peakRssBytes", "cpuUserMs", "cpuSystemMs", "rssMb", "cpuMs", "cpuSeconds", "workerClass", "workerId", "perf-8x", "machine-91", "iad", "123456789", "234567890"]) {
      expect(text, secret).not.toContain(secret);
    }
    expect(out.recentEvents[0]).toMatchObject({ stats: { pages: 12 }, payload: { metrics: { inputTokens: 5, outputTokens: 7, costCents: 2 } }, progress: { completedDocumentStages: 3 } });
    expect(out.stages[0]!.stats).toEqual({ pages: 12, regionBoxes: 4, nested: { kept: 1 } });
    expect(out.run.stats).toEqual({ documents: 2 });
  });

  it("keeps customer-facing region data such as layout boxes", () => {
    expect(redactOperatorKeys({ regionBoxes: [1], regionId: "r", regionCoordinateSpace: "page", regions: ["iad"], region: "iad" })).toEqual({ regionBoxes: [1], regionId: "r", regionCoordinateSpace: "page" });
  });

  it("does not mutate its input, so an operator's copy stays whole", () => {
    const input = withEvents();
    redactOperatorRunFields(input);
    expect(JSON.stringify(input)).toContain("rssBytes");
  });

  it("redacts a single event for the raw event routes", () => {
    const out = redactOperatorEvent(heartbeat as never);
    expect(JSON.stringify(out)).not.toMatch(/rss|cpu/i);
    expect(out.payload).toMatchObject({ kind: "heartbeat", metrics: { costCents: 2 } });
  });

  it("fails closed on structures deeper than it will walk", () => {
    let deep: Record<string, unknown> = { rssBytes: 1 };
    for (let i = 0; i < 30; i++) deep = { child: deep };
    expect(JSON.stringify(redactOperatorKeys(deep))).not.toContain("rssBytes");
  });
});

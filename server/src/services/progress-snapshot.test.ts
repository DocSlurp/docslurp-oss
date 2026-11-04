import { describe, expect, it } from "vitest";
import type { WorkspaceRunProgressSnapshot } from "@docslurp/shared";
import { redactOperatorRunFields } from "./progress-snapshot.js";

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

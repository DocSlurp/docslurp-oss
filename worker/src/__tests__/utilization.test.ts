import { describe, expect, it } from "vitest";

import { UtilizationMeter, parseProcStat } from "../temporal/utilization.js";

describe("worker utilization", () => {
  it("parses the aggregate CPU line of /proc/stat", () => {
    expect(parseProcStat("cpu  100 0 50 800 10 5 5 30 0 0\ncpu0 1 2 3 4\n")).toEqual({ busy: 160, steal: 30, total: 1000 });
    expect(parseProcStat("intr 1 2\n")).toBeNull();
  });

  it("integrates busy slots over time and reports window averages", () => {
    let now = 0;
    let busy = 0;
    let cpu = { busy: 0, steal: 0, total: 0 };
    const meter = new UtilizationMeter(8, () => busy, () => now, () => cpu);
    busy = 8; now = 10_000; meter.sample();   // 10 s fully busy
    busy = 2; now = 20_000; meter.sample();   // 10 s at 2/8
    cpu = { busy: 600, steal: 100, total: 1_000 };
    const snapshot = meter.snapshot();
    expect(snapshot.slotUtilization).toBeCloseTo((80 + 20) / 160);
    expect(snapshot).toMatchObject({ slots: 8, busySlots: 2, cpuBusy: 0.6, cpuSteal: 0.1 });

    const lines = meter.metricLines().join("\n");
    expect(lines).toContain("docslurp_worker_activity_slot_seconds_total 100.000");
    expect(lines).toContain("docslurp_worker_activity_capacity_seconds_total 160.000");
    expect(lines).toContain("docslurp_worker_cpu_steal_seconds_total 1.00");
  });

  it("reports resource-tuned workers running above their nominal slots", () => {
    let now = 0;
    const meter = new UtilizationMeter(4, () => 6, () => now, () => null);
    now = 1_000;
    expect(meter.snapshot()).toMatchObject({ busySlots: 6, slotUtilization: 1.5, cpuBusy: null });
  });
});

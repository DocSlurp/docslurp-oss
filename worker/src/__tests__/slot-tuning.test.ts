import { describe, expect, it } from "vitest";

import { activitySlotOptions, maxActivitySlots, resolveActivitySlotTuning } from "../temporal/slot-tuning.js";

describe("activity slot tuning", () => {
  it("defaults to resource-based slots around the nominal count", () => {
    const tuning = resolveActivitySlotTuning({}, 8);
    expect(tuning).toMatchObject({ mode: "resource", nominalSlots: 8, minimumSlots: 4, maximumSlots: 16, rampThrottleMs: 50 });
    const options = activitySlotOptions(tuning, 8);
    expect("tuner" in options && options.tuner).toMatchObject({
      workflowTaskSlotSupplier: { type: "fixed-size", numSlots: 8 },
      activityTaskSlotSupplier: { type: "resource-based", minimumSlots: 4, maximumSlots: 16, rampThrottle: 50,
        tunerOptions: { targetCpuUsage: 0.85, targetMemoryUsage: 0.8 } },
    });
    expect(maxActivitySlots(tuning)).toBe(16);
  });

  it("keeps the default ramp throttle far below short-activity durations", () => {
    // 5 s throttled 200 ms activities to 16-53/min on 2 slots (316/min fixed); 50 ms matched fixed.
    expect(resolveActivitySlotTuning({}, 2).rampThrottleMs).toBeLessThanOrEqual(100);
    expect(resolveActivitySlotTuning({ WORKER_SLOT_RAMP_MS: "0" }, 2).rampThrottleMs).toBe(0);
    expect(resolveActivitySlotTuning({ WORKER_SLOT_RAMP_MS: "5000" }, 2).rampThrottleMs).toBe(5_000);
  });

  it("falls back to fixed slots and clamps bad input", () => {
    const fixed = resolveActivitySlotTuning({ WORKER_SLOT_TUNER: "fixed" }, 8);
    expect(activitySlotOptions(fixed)).toEqual({ maxConcurrentActivityTaskExecutions: 8 });
    expect(maxActivitySlots(fixed)).toBe(8);
    const odd = resolveActivitySlotTuning({ WORKER_MIN_ACTIVITY_SLOTS: "10", WORKER_MAX_ACTIVITY_SLOTS: "3", WORKER_TARGET_CPU: "7" }, 8);
    expect(odd.maximumSlots).toBeGreaterThanOrEqual(odd.minimumSlots);
    expect(odd.targetCpuUsage).toBe(0.85);
  });
});

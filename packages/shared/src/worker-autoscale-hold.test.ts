import { describe, expect, it } from "vitest";

import { TargetHold, resolveWorkerScalerConfig, scaleDownHoldMs } from "./worker-autoscale.js";

describe("scale-down hold", () => {
  it("is off unless a positive number of seconds is configured, capped at an hour", () => {
    expect(scaleDownHoldMs({})).toBe(0);
    expect(scaleDownHoldMs({ DOCSLURP_WORKER_SCALE_DOWN_HOLD_SECONDS: "0" })).toBe(0);
    expect(scaleDownHoldMs({ DOCSLURP_WORKER_SCALE_DOWN_HOLD_SECONDS: "-5" })).toBe(0);
    expect(scaleDownHoldMs({ DOCSLURP_WORKER_SCALE_DOWN_HOLD_SECONDS: "abc" })).toBe(0);
    expect(scaleDownHoldMs({ DOCSLURP_WORKER_SCALE_DOWN_HOLD_SECONDS: "300" })).toBe(300_000);
    expect(scaleDownHoldMs({ DOCSLURP_WORKER_SCALE_DOWN_HOLD_SECONDS: "99999" })).toBe(3_600_000);
    expect(resolveWorkerScalerConfig({ DOCSLURP_WORKER_SCALE_DOWN_HOLD_SECONDS: "120" }).scaleDownHoldMs).toBe(120_000);
  });

  it("passes scale-up through at once and delays scale-down until higher targets age out", () => {
    const hold = new TargetHold(300_000);
    expect(hold.apply(1, 0)).toBe(1);
    expect(hold.apply(5, 10_000)).toBe(5);
    expect(hold.apply(2, 20_000)).toBe(5);
    expect(hold.apply(0, 309_999)).toBe(5);
    expect(hold.apply(0, 310_000)).toBe(2);
    expect(hold.apply(0, 320_000)).toBe(0);
  });

  it("is a pass-through when disabled", () => {
    const hold = new TargetHold(0);
    expect(hold.apply(5, 0)).toBe(5);
    expect(hold.apply(0, 1)).toBe(0);
  });
});

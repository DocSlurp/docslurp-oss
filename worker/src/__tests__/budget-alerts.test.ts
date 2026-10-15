import { describe, expect, it } from "vitest";

import { resolveBudgetAlertLevel } from "../db/store.js";

describe("resolveBudgetAlertLevel", () => {
  it("returns 0 below the configured threshold", () => {
    expect(resolveBudgetAlertLevel(799, 1_000, 80)).toBe(0);
  });

  it("returns the warning threshold once spend crosses it", () => {
    expect(resolveBudgetAlertLevel(800, 1_000, 80)).toBe(80);
  });

  it("returns 100 once spend reaches the cap", () => {
    expect(resolveBudgetAlertLevel(1_000, 1_000, 80)).toBe(100);
  });
});

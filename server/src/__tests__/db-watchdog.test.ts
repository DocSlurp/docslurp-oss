import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: () => Promise.resolve([]) }));
const { DbWatchdogState, resolveDbWatchdogOptions } = await import("../services/db-watchdog.js");

describe("database watchdog", () => {
  it("exits only after the database has failed continuously for the window", () => {
    const state = new DbWatchdogState(60_000);
    expect(state.record(false, 0).exit).toBe(false);
    expect(state.record(false, 45_000).exit).toBe(false);
    expect(state.record(true, 50_000)).toEqual({ exit: false, failingForMs: 0 });
    expect(state.record(false, 55_000).exit).toBe(false);
    expect(state.record(false, 114_000).exit).toBe(false);
    expect(state.record(false, 115_000)).toEqual({ exit: true, failingForMs: 60_000 });
  });

  it("can be disabled", () => {
    expect(new DbWatchdogState(0).record(false, 10_000_000).exit).toBe(false);
    expect(resolveDbWatchdogOptions({ DB_WATCHDOG_EXIT_AFTER_MS: "0" }).exitAfterMs).toBe(0);
    expect(resolveDbWatchdogOptions({})).toEqual({ intervalMs: 15_000, timeoutMs: 5_000, exitAfterMs: 60_000 });
  });
});

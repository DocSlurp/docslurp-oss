import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: () => Promise.resolve([]) }));
const { DbWatchdogState, checkDatabaseHealth, resolveDbWatchdogOptions } = await import("../services/db-watchdog.js");
const { PoolActivity } = await import("../lib/pool-activity.js");

type Deps = Parameters<typeof checkDatabaseHealth>[2];

const options = { intervalMs: 15_000, timeoutMs: 5_000, exitAfterMs: 60_000, poolStallMs: 60_000 };

function deps(overrides: Partial<Deps> & { clock?: { now: number } } = {}): Deps & { warnings: string[] } {
  const warnings: string[] = [];
  const clock = overrides.clock ?? { now: 0 };
  return {
    probe: async () => ({ ok: true, latencyMs: 3 }),
    pool: () => ({ inFlight: 0, completed: 0, stalledForMs: 0 }),
    activeBackends: async () => 0,
    now: () => clock.now,
    log: { warn: (message) => warnings.push(message), error: (message) => warnings.push(message) },
    ...overrides,
    warnings,
  };
}

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
    expect(resolveDbWatchdogOptions({})).toEqual({ intervalMs: 15_000, timeoutMs: 5_000, exitAfterMs: 60_000, poolStallMs: 60_000 });
    expect(resolveDbWatchdogOptions({ DB_WATCHDOG_POOL_STALL_MS: "0" }).poolStallMs).toBe(0);
  });

  it("exits when the dedicated probe fails for the whole window", async () => {
    const clock = { now: 0 };
    const state = new DbWatchdogState(options.exitAfterMs);
    const d = deps({ clock, probe: async () => ({ ok: false, latencyMs: 5_000, detail: "timed out after 5000ms" }) });
    for (; clock.now < 60_000; clock.now += 15_000) expect((await checkDatabaseHealth(options, state, d)).exit).toBe(false);
    expect(await checkDatabaseHealth(options, state, d)).toMatchObject({ exit: true, reason: "database_unreachable" });
  });

  it("never exits on a saturated pool that keeps completing queries", async () => {
    const clock = { now: 0 };
    const state = new DbWatchdogState(options.exitAfterMs);
    // 300 queries queued for minutes, but completions keep the stall clock near zero.
    const d = deps({ clock, pool: () => ({ inFlight: 300, completed: clock.now / 10, stalledForMs: 40 }) });
    for (; clock.now < 600_000; clock.now += 15_000) expect((await checkDatabaseHealth(options, state, d)).exit).toBe(false);
    expect(d.warnings).toEqual([]);
  });

  it("exits on a wedged pool only when Postgres runs none of its queries", async () => {
    const state = new DbWatchdogState(options.exitAfterMs);
    const wedged = () => ({ inFlight: 4, completed: 10, stalledForMs: 61_000 });

    const busy = deps({ pool: wedged, activeBackends: async () => 3 });
    expect((await checkDatabaseHealth(options, state, busy)).exit).toBe(false);
    expect(busy.warnings[0]).toMatch(/reports 3 active pool queries; not restarting/);

    const unknown = deps({ pool: wedged, activeBackends: async () => { throw new Error("timeout"); } });
    expect((await checkDatabaseHealth(options, state, unknown)).exit).toBe(false);
    expect(unknown.warnings[0]).toMatch(/reports unknown active pool queries/);

    const dead = deps({ pool: wedged, activeBackends: async () => 0 });
    expect(await checkDatabaseHealth(options, state, dead)).toMatchObject({ exit: true, reason: "pool_stalled" });

    const disabled = deps({ pool: wedged, activeBackends: async () => 0 });
    expect((await checkDatabaseHealth({ ...options, poolStallMs: 0 }, state, disabled)).exit).toBe(false);
  });
});

describe("pool activity", () => {
  it("measures stalls from the last completion, or from when demand arrived at an idle pool", () => {
    const clock = { now: 1_000 };
    const activity = new PoolActivity(() => clock.now);
    clock.now = 50_000;
    const first = activity.start();
    expect(activity.snapshot()).toEqual({ inFlight: 1, completed: 0, stalledForMs: 0 });
    clock.now = 52_000;
    const second = activity.start();
    expect(activity.snapshot().stalledForMs).toBe(2_000);
    first();
    first();
    expect(activity.snapshot()).toEqual({ inFlight: 1, completed: 1, stalledForMs: 0 });
    clock.now = 70_000;
    expect(activity.snapshot().stalledForMs).toBe(18_000);
    second();
    expect(activity.snapshot()).toEqual({ inFlight: 0, completed: 2, stalledForMs: 0 });
  });
});

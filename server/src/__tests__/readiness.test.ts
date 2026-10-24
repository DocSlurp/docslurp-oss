import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: vi.fn() }));
vi.mock("../lib/temporal.js", () => ({
  describeTemporalNamespace: vi.fn(),
  describeTaskQueuePollers: vi.fn(),
  workerTaskQueues: vi.fn(() => []),
}));
vi.mock("../lib/storage.js", () => ({ headStorageBucket: vi.fn() }));

const { evaluateReadiness, migrationReadiness } = await import("../services/readiness.js");
type Probes = Parameters<typeof evaluateReadiness>[0] & object;

const ok = async () => ({ ok: true as const });
const healthy: Probes = { database: ok, pool: ok, migrations: ok, storage: ok, temporal: ok };

describe("readiness", () => {
  it("is ready and serving when every dependency answers", async () => {
    const report = await evaluateReadiness(healthy, { timeoutMs: 100 });
    expect(report.ok).toBe(true);
    expect(report.serving).toBe(true);
    expect(report.checks.map((check) => check.name)).toEqual(["database", "pool", "migrations", "storage", "temporal"]);
  });

  it("stops serving when a critical dependency fails, with the reason", async () => {
    const report = await evaluateReadiness({ ...healthy, database: async () => { throw new Error("connection refused"); } }, { timeoutMs: 100 });
    expect(report.ok).toBe(false);
    expect(report.serving).toBe(false);
    expect(report.checks.find((check) => check.name === "database")).toMatchObject({ ok: false, critical: true, detail: "connection refused" });
  });

  it("keeps serving through a Temporal outage but is not ok for the deploy gate", async () => {
    const report = await evaluateReadiness({ ...healthy, temporal: async () => ({ ok: false, detail: "UNAVAILABLE" }) }, { timeoutMs: 100 });
    expect(report.serving).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("times out each probe on its own instead of hanging the check", async () => {
    let aborted = false;
    const hung = (signal: AbortSignal) => new Promise<never>(() => { signal.addEventListener("abort", () => { aborted = true; }); });
    const started = Date.now();
    const report = await evaluateReadiness({ ...healthy, storage: hung }, { timeoutMs: 30 });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(aborted).toBe(true);
    expect(report.checks.find((check) => check.name === "storage")).toMatchObject({ ok: false, detail: "timed out after 30ms" });
    expect(report.serving).toBe(false);
  });

  it("fails migrations only when the code expects unapplied migrations", () => {
    const journal = [{ tag: "0000_init", when: 100 }, { tag: "0001_next", when: 200 }];
    expect(migrationReadiness({ journal, latestAppliedWhen: 200 }).ok).toBe(true);
    expect(migrationReadiness({ journal, latestAppliedWhen: 100 })).toMatchObject({ ok: false, detail: expect.stringContaining("1 migration(s) not applied") });
    // A rolled-back image runs against a newer (expanded) schema: still ready.
    expect(migrationReadiness({ journal, latestAppliedWhen: 300 })).toMatchObject({ ok: true, detail: expect.stringContaining("ahead") });
    expect(migrationReadiness({ journal: null, latestAppliedWhen: null }).ok).toBe(true);
  });
});

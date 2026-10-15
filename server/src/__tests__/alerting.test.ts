import { describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: vi.fn() }));
vi.mock("../lib/temporal.js", () => ({ describeTaskQueuePollers: vi.fn(), workerTaskQueues: vi.fn(() => []) }));

const {
  DEFAULT_ALERT_THRESHOLDS,
  WorkerIdentityHistory,
  evaluateAlertRules,
  resolveAlertThresholds,
  workerMachineKey,
} = await import("../services/alerts/alert-rules.js");
const { AlertTracker } = await import("../services/alerts/alert-tracker.js");
const { formatAlertLogLine, formatAlertPayload, deliverAlert, resolveAlertDeliveryConfig } = await import("../services/alerts/alert-delivery.js");
const { AlertEvaluator } = await import("../services/alerts/alert-evaluator.js");
const { HttpResponseStats } = await import("../lib/http-response-stats.js");

type Observation = Parameters<typeof evaluateAlertRules>[0];
type Check = ReturnType<typeof evaluateAlertRules>[number];

const NOW = 1_800_000_000_000;
const journal = [
  { tag: "0000_init", when: 100 },
  { tag: "0001_next", when: 200 },
];

function healthy(overrides: Partial<Observation> = {}): Observation {
  return {
    now: NOW,
    database: {
      ok: true,
      queue: { queueDepth: 0, processingRuns: 0, staleLeases: 0, oldestQueuedRunAgeSeconds: null },
      migrations: { appliedCount: 2, latestAppliedWhen: 200, journal },
    },
    temporal: { ok: true, queues: [{ name: "docslurp-pipeline", type: "activity", pollers: [{ identity: "docslurp-worker-m1-10", lastAccessMs: NOW - 1_000 }] }] },
    http: { total: 100, errors5xx: 0, windowMs: 300_000 },
    ...overrides,
  };
}

function byId(checks: Check[], id: string): Check {
  const found = checks.find((check) => check.id === id);
  if (!found) throw new Error(`missing check ${id}`);
  return found;
}

function firing(checks: Check[]): string[] {
  return checks.filter((check) => check.state === "firing").map((check) => check.id).sort();
}

describe("alert rules", () => {
  it("reports every check ok for a healthy observation", () => {
    const checks = evaluateAlertRules(healthy(), DEFAULT_ALERT_THRESHOLDS, new WorkerIdentityHistory());
    expect(firing(checks)).toEqual([]);
    expect(checks.map((check) => check.id).sort()).toEqual([
      "database-unreachable",
      "http-5xx-rate",
      "migrations-not-at-head",
      "queued-run-age",
      "stale-leases",
      "temporal-unreachable",
      "worker-crash-loop",
      "worker-pollers-missing",
    ]);
  });

  it("fires on queue age, stale leases and missing pollers with pending work", () => {
    const checks = evaluateAlertRules(healthy({
      database: {
        ok: true,
        queue: { queueDepth: 3, processingRuns: 1, staleLeases: 2, oldestQueuedRunAgeSeconds: 1_200 },
        migrations: { appliedCount: 2, latestAppliedWhen: 200, journal },
      },
      temporal: { ok: true, queues: [{ name: "docslurp-pipeline", type: "activity", pollers: [{ identity: "old", lastAccessMs: NOW - 600_000 }] }] },
    }), DEFAULT_ALERT_THRESHOLDS);
    expect(firing(checks)).toEqual(["queued-run-age", "stale-leases", "worker-pollers-missing"]);
  });

  it("does not page for missing pollers while the queue is idle", () => {
    const checks = evaluateAlertRules(healthy({
      temporal: { ok: true, queues: [{ name: "docslurp-pipeline", type: "activity", pollers: [] }] },
    }), DEFAULT_ALERT_THRESHOLDS);
    expect(byId(checks, "worker-pollers-missing").state).toBe("ok");
  });

  it("detects pending migrations and a schema ahead of the code", () => {
    const pending = evaluateAlertRules(healthy({
      database: { ok: true, queue: { queueDepth: 0, processingRuns: 0, staleLeases: 0, oldestQueuedRunAgeSeconds: null }, migrations: { appliedCount: 1, latestAppliedWhen: 100, journal } },
    }), DEFAULT_ALERT_THRESHOLDS);
    const check = byId(pending, "migrations-not-at-head");
    expect(check.state).toBe("firing");
    expect(check.state === "firing" && check.details.pending).toBe("0001_next");

    const ahead = byId(evaluateAlertRules(healthy({
      database: { ok: true, queue: { queueDepth: 0, processingRuns: 0, staleLeases: 0, oldestQueuedRunAgeSeconds: null }, migrations: { appliedCount: 3, latestAppliedWhen: 300, journal } },
    }), DEFAULT_ALERT_THRESHOLDS), "migrations-not-at-head");
    expect(ahead.state === "firing" && ahead.details.schemaAheadOfCode).toBe(true);
  });

  it("marks dependent checks unknown when Temporal or the database is down", () => {
    const temporalDown = evaluateAlertRules(healthy({ temporal: { ok: false, error: "connect ECONNREFUSED" } }), DEFAULT_ALERT_THRESHOLDS, new WorkerIdentityHistory());
    expect(byId(temporalDown, "temporal-unreachable").state).toBe("firing");
    expect(byId(temporalDown, "worker-pollers-missing").state).toBe("unknown");
    expect(byId(temporalDown, "worker-crash-loop").state).toBe("unknown");

    const dbDown = evaluateAlertRules(healthy({ database: { ok: false, error: "timeout" }, temporal: null }), DEFAULT_ALERT_THRESHOLDS);
    expect(firing(dbDown)).toEqual(["database-unreachable"]);
    expect(byId(dbDown, "queued-run-age").state).toBe("unknown");
  });

  it("only evaluates local checks on a non-leader instance", () => {
    const checks = evaluateAlertRules(healthy({ database: { ok: true, queue: null, migrations: null }, temporal: null }), DEFAULT_ALERT_THRESHOLDS);
    expect(checks.map((check) => check.id).sort()).toEqual(["database-unreachable", "http-5xx-rate"]);
  });

  it("judges the 5xx rate only above the minimum request count", () => {
    expect(byId(evaluateAlertRules(healthy({ http: { total: 10, errors5xx: 10, windowMs: 300_000 } }), DEFAULT_ALERT_THRESHOLDS), "http-5xx-rate").state).toBe("ok");
    expect(byId(evaluateAlertRules(healthy({ http: { total: 100, errors5xx: 5, windowMs: 300_000 } }), DEFAULT_ALERT_THRESHOLDS), "http-5xx-rate").state).toBe("firing");
    expect(byId(evaluateAlertRules(healthy({ http: { total: 100, errors5xx: 4, windowMs: 300_000 } }), DEFAULT_ALERT_THRESHOLDS), "http-5xx-rate").state).toBe("ok");
  });

  it("detects crash loops per machine but not autoscaled new machines", () => {
    expect(workerMachineKey("docslurp-worker-abc123-4567")).toBe("docslurp-worker-abc123");
    const history = new WorkerIdentityHistory();
    const window = DEFAULT_ALERT_THRESHOLDS.workerRestartWindowMs;
    // Ten distinct machines, one process each: a scale-up, not a crash loop.
    history.observe(Array.from({ length: 10 }, (_, i) => `docslurp-worker-m${i}-1`), NOW, window);
    expect(history.processesPerMachine()[0]?.processes).toBe(1);

    const temporalWith = (identity: string) => ({ ok: true as const, queues: [{ name: "q", type: "activity" as const, pollers: [{ identity, lastAccessMs: NOW }] }] });
    for (const [offset, pid] of [[0, 11], [60_000, 12], [120_000, 13]] as const) {
      const checks = evaluateAlertRules({ ...healthy(), now: NOW + offset, temporal: temporalWith(`docslurp-worker-m0-${pid}`) }, DEFAULT_ALERT_THRESHOLDS, history);
      if (pid === 13) expect(byId(checks, "worker-crash-loop").state).toBe("firing");
    }
    // Once the window passes, old identities age out and the alert clears.
    const later = evaluateAlertRules({ ...healthy(), now: NOW + window + 200_000, temporal: temporalWith("docslurp-worker-m0-13") }, DEFAULT_ALERT_THRESHOLDS, history);
    expect(byId(later, "worker-crash-loop").state).toBe("ok");
  });

  it("reads thresholds from env with sane fallbacks", () => {
    const thresholds = resolveAlertThresholds({ ALERT_QUEUED_RUN_AGE_SECONDS: "60", ALERT_HTTP_5XX_RATE: "abc", ALERT_STALE_LEASES: "0" });
    expect(thresholds.queuedRunAgeSeconds).toBe(60);
    expect(thresholds.http5xxRate).toBe(DEFAULT_ALERT_THRESHOLDS.http5xxRate);
    expect(thresholds.staleLeases).toBe(DEFAULT_ALERT_THRESHOLDS.staleLeases);
  });
});

describe("alert tracker", () => {
  const fire: Check = { id: "stale-leases", state: "firing", severity: "warning", summary: "2 stale", details: { staleLeases: 2 } };
  const ok: Check = { id: "stale-leases", state: "ok", severity: "warning", summary: "0 stale", details: { staleLeases: 0 } };
  const unknown: Check = { id: "stale-leases", state: "unknown", reason: "db down" };

  it("waits for consecutive evaluations, dedupes, repeats after cooldown and resolves once", () => {
    const tracker = new AlertTracker({ pendingEvaluations: 2, repeatIntervalMs: 3_600_000 });
    expect(tracker.update([fire], 0)).toEqual([]);
    const [first] = tracker.update([fire], 60_000);
    expect(first).toMatchObject({ status: "firing", repeat: false, startedAt: 0 });
    expect(tracker.update([fire], 120_000)).toEqual([]);
    expect(tracker.update([unknown], 180_000)).toEqual([]);
    expect(tracker.activeAlerts()).toEqual(["stale-leases"]);
    const [repeat] = tracker.update([fire], 3_660_000);
    expect(repeat).toMatchObject({ status: "firing", repeat: true });
    const [resolved] = tracker.update([ok], 3_720_000);
    expect(resolved).toMatchObject({ status: "resolved", startedAt: 0, severity: "warning" });
    expect(tracker.update([ok], 3_780_000)).toEqual([]);
    expect(tracker.activeAlerts()).toEqual([]);
  });

  it("drops a one-tick blip without notifying", () => {
    const tracker = new AlertTracker({ pendingEvaluations: 2, repeatIntervalMs: 0 });
    expect(tracker.update([fire], 0)).toEqual([]);
    expect(tracker.update([ok], 60_000)).toEqual([]);
    expect(tracker.update([fire], 120_000)).toEqual([]);
  });
});

describe("alert delivery", () => {
  const notification = {
    status: "firing" as const,
    id: "queued-run-age" as const,
    severity: "critical" as const,
    summary: "Oldest queued run has waited 1200s",
    details: { oldestQueuedRunAgeSeconds: 1200, pending: null },
    startedAt: NOW,
    at: NOW + 120_000,
    repeat: false,
  };

  it("formats Slack text, plain JSON and an [alert] log line", () => {
    const slack = formatAlertPayload(notification, { format: "slack", environment: "docslurp-app", instance: "i1" });
    expect(slack.text).toContain("[FIRING] queued-run-age");
    expect(slack.text).toContain("oldestQueuedRunAgeSeconds");
    expect(slack.text).not.toContain("pending");
    const json = formatAlertPayload(notification, { format: "json", environment: "docslurp-app", instance: "i1" });
    expect(json).toMatchObject({ source: "docslurp", status: "firing", alert: "queued-run-age", severity: "critical" });
    expect(formatAlertLogLine(notification, { environment: "prod", instance: "i1" })).toMatch(
      /^\[alert\] status=firing id=queued-run-age severity=critical env=prod instance=i1 summary="Oldest/,
    );
  });

  it("posts to the webhook only when configured and never throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("ok"));
    await deliverAlert(notification, resolveAlertDeliveryConfig({}), fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).not.toHaveBeenCalled();

    const config = resolveAlertDeliveryConfig({ ALERT_WEBHOOK_URL: "https://hooks.example.test/x", ALERT_WEBHOOK_FORMAT: "json" });
    await deliverAlert(notification, config, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const body = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body.alert).toBe("queued-run-age");

    const failing = vi.fn(async () => { throw new Error("network down"); });
    await expect(deliverAlert(notification, config, failing as unknown as typeof fetch)).resolves.toBeUndefined();
    expect(error.mock.calls.some(([line]) => String(line).includes("webhook delivery failed"))).toBe(true);
    error.mockRestore();
  });
});

describe("alert evaluator", () => {
  function evaluator(overrides: Partial<ConstructorParameters<typeof AlertEvaluator>[1]> = {}) {
    let now = NOW;
    const delivered: Array<{ status: string; id: string }> = [];
    const deps = {
      tryLease: vi.fn(async () => true),
      readQueue: vi.fn(async () => ({ queueDepth: 2, processingRuns: 0, staleLeases: 0, oldestQueuedRunAgeSeconds: 5_000 })),
      readMigrations: vi.fn(async () => ({ appliedCount: 2, latestAppliedWhen: 200, journal })),
      readTemporal: vi.fn(async () => ({ ok: true as const, queues: [{ name: "q", type: "activity" as const, pollers: [{ identity: "docslurp-worker-m1-1", lastAccessMs: now }] }] })),
      readHttp: vi.fn(() => ({ total: 0, errors5xx: 0 })),
      deliver: vi.fn(async (notification: { status: string; id: string }) => { delivered.push({ status: notification.status, id: notification.id }); }),
      now: () => now,
      ...overrides,
    };
    const instance = new AlertEvaluator({
      intervalMs: 60_000,
      thresholds: DEFAULT_ALERT_THRESHOLDS,
      pendingEvaluations: 2,
      repeatIntervalMs: 3_600_000,
      delivery: resolveAlertDeliveryConfig({}),
      instance: "test",
    }, deps);
    return { instance, deps, delivered, advance: (ms: number) => { now += ms; } };
  }

  it("notifies once after consecutive failures and resolves when the queue drains", async () => {
    const { instance, deps, delivered, advance } = evaluator();
    await instance.tick();
    advance(60_000);
    await instance.tick();
    advance(60_000);
    await instance.tick();
    expect(delivered).toEqual([{ status: "firing", id: "queued-run-age" }]);
    vi.mocked(deps.readQueue).mockResolvedValue({ queueDepth: 0, processingRuns: 0, staleLeases: 0, oldestQueuedRunAgeSeconds: null });
    advance(60_000);
    await instance.tick();
    expect(delivered).toEqual([{ status: "firing", id: "queued-run-age" }, { status: "resolved", id: "queued-run-age" }]);
  });

  it("skips fleet checks when another instance holds the lease", async () => {
    const { instance, deps, delivered, advance } = evaluator({ tryLease: vi.fn(async () => false) });
    await instance.tick();
    advance(60_000);
    await instance.tick();
    expect(deps.readQueue).not.toHaveBeenCalled();
    expect(deps.readTemporal).not.toHaveBeenCalled();
    expect(delivered).toEqual([]);
    expect(instance.isLeader()).toBe(false);
  });

  it("reports database-unreachable when the lease query fails", async () => {
    const { instance, delivered, advance } = evaluator({ tryLease: vi.fn(async () => { throw new Error("ECONNRESET"); }) });
    await instance.tick();
    advance(60_000);
    await instance.tick();
    expect(delivered).toEqual([{ status: "firing", id: "database-unreachable" }]);
  });
});

describe("http response stats", () => {
  it("counts 5xx responses in a sliding window", () => {
    const stats = new HttpResponseStats();
    stats.record(200, NOW - 10 * 60_000);
    stats.record(500, NOW - 10 * 60_000);
    stats.record(200, NOW - 60_000);
    stats.record(503, NOW - 30_000);
    stats.record(404, NOW);
    expect(stats.window(5 * 60_000, NOW)).toEqual({ total: 3, errors5xx: 1 });
    expect(stats.totals).toMatchObject({ "2xx": 2, "4xx": 1, "5xx": 2 });
  });
});

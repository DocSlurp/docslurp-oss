import { describe, expect, it, vi } from "vitest";

import {
  FatalWorkerError,
  classifyWorkerFailure,
  installWorkerProcessGuards,
  logWorkerFatal,
  restartDelayMs,
  runWorkerGroup,
  superviseTemporalWorkers,
  type SupervisedSession,
} from "../temporal/worker-supervisor.js";

function fakeSession(run: () => Promise<void>): SupervisedSession & { closed: number; shutdowns: number } {
  const session = {
    closed: 0,
    shutdowns: 0,
    run,
    shutdown() { session.shutdowns += 1; },
    async close() { session.closed += 1; },
  };
  return session;
}

const noSleep = async () => undefined;
const quiet = () => undefined;

describe("classifyWorkerFailure", () => {
  it.each([
    ["Temporal connection loss", new Error("transport error: tcp connect error: Connection refused (os error 111)")],
    ["poller error", new Error("Poller failed: status: Unavailable, message: \"error reading from server\"")],
    ["deadline", new Error("Failed to connect before the deadline")],
    ["database blip", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })],
    ["unexpected run() return", new Error("Temporal worker run() returned without a shutdown request")],
  ])("retries %s", (_name, error) => {
    expect(classifyWorkerFailure(error).fatal).toBe(false);
  });

  it.each([
    ["auth", new Error("status: Unauthenticated, message: \"Request unauthorized\""), "auth"],
    ["permission", new Error("PERMISSION_DENIED: namespace access"), "auth"],
    ["namespace", new Error("Namespace docslurp not found"), "auth"],
    ["tls", new Error("invalid peer certificate: UnknownIssuer"), "auth"],
    ["config", new TypeError("maxConcurrentActivityTaskPolls must be positive"), "config"],
    ["schema", Object.assign(new Error('relation "worker_capabilities" does not exist'), { code: "42P01" }), "schema-behind"],
    ["native panic", new Error("Core panicked: thread 'tokio-runtime' panicked at"), "native-crash"],
    ["explicit", new FatalWorkerError("startup", "sandbox unavailable"), "startup"],
  ])("treats %s as fatal", (_name, error, reason) => {
    expect(classifyWorkerFailure(error)).toEqual({ fatal: true, reason });
  });

  it("finds a fatal cause behind a connection wrapper", () => {
    const wrapped = new Error("Temporal worker could not connect", { cause: new Error("Unauthenticated") });
    expect(classifyWorkerFailure(wrapped)).toEqual({ fatal: true, reason: "auth" });
  });
});

describe("restartDelayMs", () => {
  const backoff = { baseMs: 1_000, maxMs: 30_000, stableAfterMs: 60_000 };
  it("grows exponentially with jitter and caps", () => {
    expect(restartDelayMs(1, backoff, () => 0)).toBe(500);
    expect(restartDelayMs(1, backoff, () => 1)).toBe(1_000);
    expect(restartDelayMs(3, backoff, () => 1)).toBe(4_000);
    expect(restartDelayMs(20, backoff, () => 1)).toBe(30_000);
    expect(restartDelayMs(20, backoff, () => 0)).toBe(15_000);
  });
});

describe("superviseTemporalWorkers", () => {
  it("recreates the connection and workers after a poller failure, then keeps running", async () => {
    const controller = new AbortController();
    const sessions: ReturnType<typeof fakeSession>[] = [];
    const delays: number[] = [];
    const create = vi.fn(async () => {
      const n = sessions.length;
      const session = fakeSession(async () => {
        if (n === 0) throw new Error("Poller failed: status: Unavailable");
        if (n === 1) throw new Error("tcp connect error: Connection refused");
        controller.abort(); // third session runs until a stop is requested
        return;
      });
      sessions.push(session);
      return session;
    });
    await superviseTemporalWorkers({
      createSession: create,
      signal: controller.signal,
      sleep: async (ms) => { delays.push(ms); },
      random: () => 1,
      log: quiet,
    });
    expect(create).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1_000, 2_000]);
    expect(sessions.every((s) => s.closed >= 1)).toBe(true);
  });

  it("keeps retrying when creating the session (connect) fails", async () => {
    const controller = new AbortController();
    let attempts = 0;
    await superviseTemporalWorkers({
      createSession: async () => {
        attempts += 1;
        if (attempts < 4) throw new Error("Temporal worker could not connect: Connection refused");
        return fakeSession(async () => controller.abort());
      },
      signal: controller.signal,
      sleep: noSleep,
      log: quiet,
    });
    expect(attempts).toBe(4);
  });

  it("restarts when run() resolves without a stop request", async () => {
    const controller = new AbortController();
    let runs = 0;
    await superviseTemporalWorkers({
      createSession: async () => fakeSession(async () => { runs += 1; if (runs === 2) controller.abort(); }),
      signal: controller.signal,
      sleep: noSleep,
      log: quiet,
    });
    expect(runs).toBe(2);
  });

  it("resets the backoff after a stable session", async () => {
    const controller = new AbortController();
    let clock = 0;
    const delays: number[] = [];
    let n = 0;
    await superviseTemporalWorkers({
      createSession: async () => fakeSession(async () => {
        n += 1;
        clock += n === 3 ? 120_000 : 10; // the third session was stable
        if (n === 5) { controller.abort(); return; }
        throw new Error("Poller failed");
      }),
      signal: controller.signal,
      sleep: async (ms) => { delays.push(ms); },
      random: () => 1,
      now: () => clock,
      log: quiet,
    });
    expect(delays).toEqual([1_000, 2_000, 1_000, 2_000]);
  });

  it("shuts the running session down on a stop request and resolves", async () => {
    const controller = new AbortController();
    let release!: () => void;
    const session = fakeSession(() => new Promise<void>((resolve) => { release = resolve; }));
    session.shutdown = () => { session.shutdowns += 1; release(); };
    const done = superviseTemporalWorkers({ createSession: async () => session, signal: controller.signal, sleep: noSleep, log: quiet });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(new Error("SIGTERM"));
    await done;
    expect(session.shutdowns).toBe(1);
    expect(session.closed).toBe(1);
  });

  it("does not restart during a requested stop even if the drain errors", async () => {
    const controller = new AbortController();
    const create = vi.fn(async () => fakeSession(async () => { controller.abort(); throw new Error("grace period exceeded"); }));
    await superviseTemporalWorkers({ createSession: create, signal: controller.signal, sleep: noSleep, log: quiet });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("throws on fatal failures without retrying and still closes the session", async () => {
    const controller = new AbortController();
    const session = fakeSession(async () => { throw new Error("status: Unauthenticated"); });
    const create = vi.fn(async () => session);
    await expect(superviseTemporalWorkers({ createSession: create, signal: controller.signal, sleep: noSleep, log: quiet }))
      .rejects.toMatchObject({ name: "FatalWorkerError", reason: "auth" });
    expect(create).toHaveBeenCalledTimes(1);
    expect(session.closed).toBeGreaterThanOrEqual(1);
  });

  it("treats a fatal error while connecting as fatal", async () => {
    const controller = new AbortController();
    await expect(superviseTemporalWorkers({
      createSession: async () => { throw new Error("Namespace docslurp not found"); },
      signal: controller.signal, sleep: noSleep, log: quiet,
    })).rejects.toMatchObject({ reason: "auth" });
  });
});

describe("runWorkerGroup", () => {
  it("stops siblings when one worker fails, waits for them, and rethrows the first error", async () => {
    const order: string[] = [];
    let releaseB!: () => void;
    const a = { run: async () => { throw new Error("poller A failed"); }, shutdown: () => order.push("shutdown-a") };
    const b = {
      run: () => new Promise<void>((resolve) => { releaseB = () => { order.push("b-drained"); resolve(); }; }),
      shutdown: () => { order.push("shutdown-b"); releaseB(); },
    };
    await expect(runWorkerGroup([a, b])).rejects.toThrow("poller A failed");
    expect(order).toContain("shutdown-b");
    expect(order).toContain("b-drained");
  });
});

describe("process guards and fatal logging", () => {
  function harness() {
    const handlers = new Map<string, (arg: never) => void>();
    const log = vi.fn();
    const exit = vi.fn();
    installWorkerProcessGuards({
      target: { on: (event, listener) => { handlers.set(event, listener); } },
      log, exit, report: vi.fn(),
    });
    return { handlers, log, exit };
  }

  it("logs an unhandled rejection and keeps running", () => {
    const { handlers, exit } = harness();
    handlers.get("unhandledRejection")!(new Error("stray") as never);
    expect(exit).not.toHaveBeenCalled();
  });

  it("survives a transient network uncaught exception", () => {
    const { handlers, exit } = harness();
    handlers.get("uncaughtException")!(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) as never);
    expect(exit).not.toHaveBeenCalled();
  });

  it("exits non-zero with a [worker-fatal] line on any other uncaught exception", () => {
    const { handlers, exit, log } = harness();
    handlers.get("uncaughtException")!(new Error("invariant broken") as never);
    expect(exit).toHaveBeenCalledWith(1);
    expect(log.mock.calls.some(([line]) => String(line).startsWith("[worker-fatal] reason="))).toBe(true);
  });

  it("logs [worker-fatal] with the reason", () => {
    const log = vi.fn();
    logWorkerFatal(new FatalWorkerError("config", "bad env"), { phase: "main" }, log);
    expect(log.mock.calls[0]![0]).toMatch(/^\[worker-fatal\] reason=config phase=main exiting=1/);
  });
});

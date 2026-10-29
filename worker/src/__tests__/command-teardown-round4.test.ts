import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { ApplicationFailure } from "@temporalio/common";
import { MockActivityEnvironment } from "@temporalio/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HungWorkError } from "../lib/hung-work.js";
import { markWorkerShuttingDown, resetWorkerShutdownForTests } from "../lib/worker-lifecycle.js";
import { Semaphore } from "../pipeline/pdf-asset-cache.js";
import { createSandboxActivityInterceptor } from "../sandbox/activity-interceptor.js";
import { spawnOwned, sweepStaleSandboxScratch } from "../sandbox/scratch-sweep.js";
import {
  afterTeardown,
  CommandTeardownError,
  probePidNamespace,
  recordUnverifiedTeardown,
  resetUnverifiedTeardownsForTests,
  spawnContained,
  superviseChild,
  unverifiedTeardownCount,
  type Containment,
} from "../sandbox/teardown.js";
import {
  assertTeardownBreakerClosed,
  onTeardownBreakerOpen,
  teardownBreakerState,
  WorkerQuarantinedError,
} from "../sandbox/teardown-breaker.js";
import { SandboxPolicyError, type SandboxSession } from "../sandbox/types.js";
import { evaluateWorkerHealth } from "../temporal/health-server.js";
import {
  classifyActivityError,
  COMMAND_TEARDOWN_UNVERIFIED,
  teardownFailure,
  WORKER_INTERRUPTED,
} from "../temporal/failure-classification.js";
import { CommandRunner } from "../tools/runner.js";

// Real processes throughout: these reproduce the #234 round-4 council findings.
const linux = process.platform === "linux";
const pidNamespace = linux && probePidNamespace().ok;

const roots: string[] = [];
const strays: number[] = [];

function scratch(prefix: string): string {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function within<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | { error: unknown } | "unsettled"> {
  return Promise.race([
    promise.then((value) => ({ value }), (error: unknown) => ({ error })),
    new Promise<"unsettled">((resolve) => setTimeout(() => resolve("unsettled"), ms)),
  ]);
}

beforeEach(() => {
  resetUnverifiedTeardownsForTests();
});

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  resetUnverifiedTeardownsForTests();
  resetWorkerShutdownForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

let markers = 0;

function uniqueSleep(): string {
  markers += 1;
  return `30.${process.pid}4${markers}`;
}

/** Host pids of live `sleep <duration>` processes. */
function sleeperPids(duration: string): number[] {
  const found: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      if (cmdline === `sleep\0${duration}\0` || cmdline === `/bin/sleep\0${duration}\0`) found.push(Number(entry));
    } catch {}
  }
  return found;
}

async function sleeperStarted(duration: string): Promise<number> {
  let pids: number[] = [];
  await waitFor(() => (pids = sleeperPids(duration)).length > 0);
  strays.push(...pids);
  return pids[0]!;
}

function quickTeardown(): void {
  vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED", "true");
  vi.stubEnv("WORKER_COMMAND_ABORT_GRACE_MS", "200");
  vi.stubEnv("WORKER_COMMAND_LAUNCHER_GRACE_MS", "200");
  vi.stubEnv("WORKER_COMMAND_TEARDOWN_VERIFY_MS", "500");
}

/** A provider that claims PID isolation but hands back a child the runner must refuse. */
function refusedSession(start: () => ReturnType<typeof spawn>, onClose: () => void = () => {}): SandboxSession {
  return {
    providerId: "claims-processes",
    isolation: { filesystem: true, network: "full", processes: true, location: "local" },
    spawn: start,
    close: async () => onClose(),
  };
}

/**
 * A root that double-forks a setsid'd grandchild out of its group (re-parented away from the
 * root, stdio closed), then waits.
 */
function setsidGrandchild(duration: string, marker: string): string[] {
  const grandchild = `sh -c 'echo \\$\\$ > ${marker}; exec sleep ${duration}' &`;
  return ["-c", `setsid sh -c "${grandchild}" </dev/null >/dev/null 2>&1 & sleep 600`];
}

/** Block (synchronously, as a provider's spawn is) until the grandchild has left the group. */
function escaped(child: ReturnType<typeof spawn>, marker: string): ReturnType<typeof spawn> {
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5_000;
  while (!(existsSync(marker) && readFileSync(marker, "utf8").trim())) {
    if (Date.now() > deadline) throw new Error("grandchild did not start");
    Atomics.wait(wait, 0, 0, 20);
  }
  strays.push(Number(readFileSync(marker, "utf8").trim()));
  return child;
}

describe.skipIf(!linux)("a refused child never counts as torn down", () => {
  it("process-group child: ends in CommandTeardownError (cause the refusal), keeps its scratch and poisons the slot", async () => {
    quickTeardown();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const duration = uniqueSleep();
    const marker = path.join(scratch("docslurp-refused-"), "grandchild");
    let cleanedUp = false;
    const runner = new CommandRunner({
      openSession: async () =>
        refusedSession(() => {
          const child = spawnContained("/bin/sh", setsidGrandchild(duration, marker), { env: process.env, containment: "process-group" });
          afterTeardown(child, () => (cleanedUp = true));
          return escaped(child, marker);
        }),
    });
    const slots = new Semaphore(1);
    const run = slots.run(undefined, () => runner.run({ binary: "/bin/sh", args: [], available: true }));
    run.catch(() => {});
    const grandchild = await sleeperStarted(duration);
    const outcome = await within(run, 8_000);
    expect(outcome).not.toBe("unsettled");
    const error = (outcome as { error: Error }).error;
    // Old behavior: the group emptied, so the refusal (SandboxPolicyError) was thrown, the session
    // released and the scratch removed while the setsid'd grandchild kept running.
    expect(error).toBeInstanceOf(CommandTeardownError);
    expect(error.cause).toBeInstanceOf(SandboxPolicyError);
    expect(alive(grandchild)).toBe(true);
    expect(cleanedUp).toBe(false);
    expect(slots.poisoned).toBe(1);
    expect(unverifiedTeardownCount()).toBe(1);
  }, 20_000);

  it("uncontained child: ends in CommandTeardownError after the root exits, not in the refusal", async () => {
    quickTeardown();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const duration = uniqueSleep();
    const marker = path.join(scratch("docslurp-refused-"), "grandchild");
    const runner = new CommandRunner({
      openSession: async () =>
        refusedSession(() =>
          escaped(spawn("/bin/sh", setsidGrandchild(duration, marker), { stdio: ["ignore", "pipe", "pipe"], detached: true }), marker),
        ),
    });
    const run = runner.run({ binary: "/bin/sh", args: [], available: true });
    run.catch(() => {});
    const grandchild = await sleeperStarted(duration);
    const outcome = await within(run, 8_000);
    expect(outcome).not.toBe("unsettled");
    const error = (outcome as { error: Error }).error;
    // Old behavior: the root's exit after SIGKILL counted as teardown and SandboxPolicyError was thrown.
    expect(error).toBeInstanceOf(CommandTeardownError);
    expect(error.message).toMatch(/uncontained/);
    expect(error.cause).toBeInstanceOf(SandboxPolicyError);
    expect(alive(grandchild)).toBe(true);
    expect(unverifiedTeardownCount()).toBe(1);
  }, 20_000);
});

function containedSession(onClose: () => void = () => {}): SandboxSession {
  const containment: Containment = pidNamespace ? "pid-namespace" : "process-group";
  return {
    providerId: "none",
    isolation: { filesystem: false, network: "none", processes: pidNamespace, location: "local" },
    spawn: (command) => spawnContained(command.binary, command.args, { env: command.env, containment, init: true }),
    close: async () => onClose(),
  };
}

describe.skipIf(!linux)("runToWritable with a destination that never calls back", () => {
  it("settles with the timeout once the command is stopped, and releases the session", async () => {
    quickTeardown();
    vi.spyOn(console, "error").mockImplementation(() => {});
    let closed = false;
    const runner = new CommandRunner({ openSession: async () => containedSession(() => (closed = true)) });
    // Accepts the first chunk and never acknowledges it: a stalled upload.
    const stalled = new Writable({ highWaterMark: 1024, write() {} });
    const run = runner.runToWritable(
      { binary: "/bin/sh", args: ["-c", "head -c 262144 /dev/zero; sleep 600"], available: true, timeoutMs: 800 },
      stalled,
    );
    run.catch(() => {});
    const outcome = await within(run, 10_000);
    // Old behavior (cefe9f4e): the command was torn down, but Promise.allSettled waited on the
    // pipeline forever, so the call never settled and the session was never released.
    expect(outcome).not.toBe("unsettled");
    expect((outcome as { error: unknown }).error).toBeInstanceOf(HungWorkError);
    expect(closed).toBe(true);
  }, 20_000);

  it("settles with the command's failure when it exits non-zero while the destination is stalled", async () => {
    quickTeardown();
    const runner = new CommandRunner({ openSession: async () => containedSession() });
    const stalled = new Writable({ highWaterMark: 1024, write() {} });
    const run = runner.runToWritable(
      { binary: "/bin/sh", args: ["-c", "head -c 262144 /dev/zero & sleep 0.3; exit 3"], available: true, timeoutMs: 20_000 },
      stalled,
    );
    run.catch(() => {});
    const outcome = await within(run, 10_000);
    expect(outcome).not.toBe("unsettled");
    // The root's non-zero exit cancels the stalled output; the command's own failure is reported.
    expect(String((outcome as { error: unknown }).error)).toMatch(/\/bin\/sh \(3\)/);
  }, 20_000);
});

describe.skipIf(!linux)("stdio bound counts only while our side waits on the writer", () => {
  it("a slow destination after the command exited resolves normally", async () => {
    vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED", "true");
    vi.stubEnv("WORKER_COMMAND_TEARDOWN_VERIFY_MS", "300");
    const runner = new CommandRunner({ openSession: async () => containedSession() });
    let received = 0;
    let writes = 0;
    // A multipart upload: one write waits for a slow part long after the command exited.
    const slow = new Writable({
      highWaterMark: 4096,
      write(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        writes += 1;
        if (writes === 1) setTimeout(callback, 1_500);
        else callback();
      },
    });
    // Eight separate 6 KiB chunks: the first waits on the slow part, the rest sit in our buffer
    // behind backpressure while the command exits, so stdio closes only once the part is done.
    const script = "for i in 1 2 3 4 5 6 7 8; do head -c 6144 /dev/zero; sleep 0.02; done";
    const outcome = await within(
      runner.runToWritable({ binary: "/bin/sh", args: ["-c", script], available: true, timeoutMs: 20_000 }, slow),
      10_000,
    );
    // Old behavior: the 300 ms stdio bound ran while our reader was backpressured, and a fully
    // exited command failed with CommandTeardownError.
    expect(outcome).toEqual({ value: { stderr: "" } });
    expect(received).toBe(8 * 6_144);
    expect(unverifiedTeardownCount()).toBe(0);
  }, 20_000);

  it("a silent external holder still trips the bound while we are reading", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const duration = uniqueSleep();
    const child = spawnContained("/bin/sh", ["-c", `setsid sleep ${duration} & exit 0`], { env: process.env, containment: "process-group" });
    child.stdout!.on("data", () => {});
    child.stderr!.on("data", () => {});
    const supervised = superviseChild(child, { label: "held", timings: { graceMs: 100, launcherGraceMs: 100, verifyMs: 300 } });
    await sleeperStarted(duration);
    const outcome = await within(supervised.done, 5_000);
    expect(outcome).not.toBe("unsettled");
    expect((outcome as { error: unknown }).error).toBeInstanceOf(CommandTeardownError);
    expect(unverifiedTeardownCount()).toBe(1);
  }, 10_000);

  it("a trickling external holder cannot hold stdio past the drain cap", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const duration = uniqueSleep();
    // Every chunk restarts the bound; only the absolute cap ends it.
    const child = spawnContained(
      "/bin/sh",
      ["-c", `setsid sh -c 'while :; do echo x; sleep 0.05; done' & setsid sleep ${duration} & exit 0`],
      { env: process.env, containment: "process-group" },
    );
    let chunks = 0;
    child.stdout!.on("data", () => (chunks += 1));
    child.stderr!.on("data", () => {});
    const startedAt = Date.now();
    const supervised = superviseChild(child, {
      label: "trickle",
      timings: { graceMs: 100, launcherGraceMs: 100, verifyMs: 300, drainCapMs: 1_500 },
    });
    await sleeperStarted(duration);
    const outcome = await within(supervised.done, 8_000);
    // The trickler is a `sh` loop: find and kill it through its session's stdout pipe holder.
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        if (readFileSync(`/proc/${entry}/cmdline`, "utf8") === "sh\0-c\0while :; do echo x; sleep 0.05; done\0") strays.push(Number(entry));
      } catch {}
    }
    expect(outcome).not.toBe("unsettled");
    const error = (outcome as { error: Error }).error;
    expect(error).toBeInstanceOf(CommandTeardownError);
    expect(error.message).toMatch(/1500 ms/);
    expect(chunks).toBeGreaterThan(5);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_400);
  }, 15_000);
});

describe("teardown circuit breaker", () => {
  function trip(): void {
    vi.spyOn(console, "error").mockImplementation(() => {});
    recordUnverifiedTeardown(new CommandTeardownError("x teardown could not be verified"), "label=x");
  }

  it("opens at WORKER_UNVERIFIED_TEARDOWN_LIMIT, notifies once, and refuses new work", async () => {
    vi.stubEnv("WORKER_UNVERIFIED_TEARDOWN_LIMIT", "2");
    const opened = vi.fn();
    onTeardownBreakerOpen(opened);
    expect(teardownBreakerState()).toEqual({ open: false, count: 0, limit: 2 });
    trip();
    expect(unverifiedTeardownCount()).toBe(1);
    expect(opened).not.toHaveBeenCalled();
    expect(() => assertTeardownBreakerClosed()).not.toThrow();
    trip();
    trip();
    expect(unverifiedTeardownCount()).toBe(3);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(opened).toHaveBeenCalledWith({ open: true, count: 2, limit: 2 });
    expect(() => assertTeardownBreakerClosed()).toThrow(WorkerQuarantinedError);
  });

  it("defaults to opening on the first unverified teardown", async () => {
    expect(teardownBreakerState().limit).toBe(1);
    trip();
    expect(unverifiedTeardownCount()).toBe(1);
    expect(teardownBreakerState().open).toBe(true);
  });

  it("fails the health check while quarantined", () => {
    const running = { runState: "RUNNING", workflowPollerState: "POLLING", activityPollerState: "POLLING" } as const;
    expect(evaluateWorkerHealth([running], null)).toMatchObject({ ok: true });
    expect(evaluateWorkerHealth([running], "1 command teardown(s) could not be verified")).toMatchObject({
      ok: false,
      state: "quarantined",
    });
  });

  it("classifies a CommandTeardownError (even wrapped, even while shutting down) as final", () => {
    const wrapped = new Error("stage failed", { cause: new CommandTeardownError("pandoc teardown could not be verified") });
    expect(classifyActivityError(wrapped)).toBe("teardown");
    markWorkerShuttingDown("teardown-unverified");
    expect(classifyActivityError(wrapped)).toBe("teardown");
    const failure = teardownFailure(wrapped);
    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure.nonRetryable).toBe(true);
    expect(failure.type).toBe(COMMAND_TEARDOWN_UNVERIFIED);
  });

  it("the activity interceptor refuses new activities on a quarantined worker, retryable elsewhere", async () => {
    const open = vi.fn(async (): Promise<SandboxSession> => ({
      providerId: "fake",
      isolation: { filesystem: false, network: "none", processes: false, location: "local" },
      close: async () => {},
    }));
    const body = vi.fn(async () => "ran");
    const runActivity = async () => {
      const environment = new MockActivityEnvironment({ activityId: "activity-7" });
      const interceptor = createSandboxActivityInterceptor(open)(environment.context).inbound!;
      return await environment.run(async (): Promise<{ value: unknown } | { error: unknown }> => {
        try {
          return { value: await interceptor.execute!({ args: [], headers: {} }, body as never) };
        } catch (error) {
          return { error };
        }
      });
    };
    expect(await runActivity()).toEqual({ value: "ran" });
    trip();
    expect(unverifiedTeardownCount()).toBe(1);
    const refused = await runActivity();
    const error = (refused as { error: ApplicationFailure }).error;
    expect(error).toBeInstanceOf(ApplicationFailure);
    expect(error.type).toBe(WORKER_INTERRUPTED);
    expect(error.nonRetryable).toBe(false);
    expect(body).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(0);
  });
});

describe.skipIf(!linux)("stale sandbox scratch sweep: age and owner the parser cannot forge", () => {
  const backdate = (target: string, ageMs: number) => {
    const at = new Date(Date.now() - ageMs);
    utimesSync(target, at, at);
  };

  it("keeps a backdated instance whose owner file is empty or unparseable", () => {
    const root = scratch("docslurp-sweep-empty-");
    const empty = path.join(root, "run-empty");
    const garbage = path.join(root, "run-garbage");
    for (const dir of [empty, garbage]) mkdirSync(dir);
    writeFileSync(`${empty}.owner`, "");
    writeFileSync(`${garbage}.owner`, "12x\n");
    for (const dir of [empty, garbage]) {
      backdate(dir, 10 * 60 * 60_000);
      backdate(`${dir}.owner`, 10 * 60 * 60_000);
    }
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Old behavior: an empty owner file read as "no owner", and the backdated mtime made it stale.
    expect(sweepStaleSandboxScratch(root)).toEqual([]);
    expect(existsSync(empty) && existsSync(garbage)).toBe(true);
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/owner-unreadable/);
  });

  it("keeps an unowned instance the parser backdated (age is its ctime), and removes it once really old", () => {
    const root = scratch("docslurp-sweep-backdated-");
    const dir = path.join(root, "run-backdated");
    mkdirSync(dir);
    backdate(dir, 10 * 60 * 60_000);
    expect(sweepStaleSandboxScratch(root)).toEqual([]);
    expect(sweepStaleSandboxScratch(root, { now: Date.now() + 4 * 60 * 60_000 })).toEqual([dir]);
  });

  it("keeps an instance with a live owner whose directory mtime was backdated, measuring age from the owner file", () => {
    const root = scratch("docslurp-sweep-ownerage-");
    const dir = path.join(root, "run-ownerage");
    mkdirSync(dir);
    writeFileSync(`${dir}.owner`, "4343\n");
    backdate(dir, 10 * 60 * 60_000);
    // The owner (4343) is gone, but its file was written just now: too young to sweep.
    expect(sweepStaleSandboxScratch(root, { isAlive: () => false })).toEqual([]);
    backdate(`${dir}.owner`, 120_000);
    expect(sweepStaleSandboxScratch(root, { isAlive: () => false })).toEqual([dir]);
  });

  it("writes the owner file by rename, leaving no temp file and never an empty owner", async () => {
    const root = scratch("docslurp-owner-atomic-");
    const dir = path.join(root, "run-atomic");
    mkdirSync(dir);
    const child = spawnOwned(
      dir,
      () => spawnContained("/bin/sh", ["-c", "sleep 0.2"], { env: process.env, containment: "process-group" }),
      () => {
        rmSync(dir, { recursive: true, force: true });
        rmSync(`${dir}.owner`, { force: true });
      },
    );
    expect(readFileSync(`${dir}.owner`, "utf8")).toBe(`${child.pid}\n`);
    expect(readdirSync(root).sort()).toEqual(["run-atomic", "run-atomic.owner"]);
    await superviseChild(child, { label: "owned" }).done;
  });
});

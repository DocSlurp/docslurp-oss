import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HungWorkError } from "../lib/hung-work.js";
import { Semaphore } from "../pipeline/pdf-asset-cache.js";
import bubblewrap from "../sandbox/providers/bubblewrap/index.js";
import none from "../sandbox/providers/none/index.js";
import { spawnOwned, sweepStaleSandboxScratch } from "../sandbox/scratch-sweep.js";
import {
  CommandTeardownError,
  probePidNamespace,
  spawnContained,
  superviseChild,
  type Containment,
  resetUnverifiedTeardownsForTests,
} from "../sandbox/teardown.js";
import { SandboxPolicyError, type SandboxSession } from "../sandbox/types.js";
import { CommandRunner } from "../tools/runner.js";

// Real processes throughout: these reproduce the #234 third re-review findings.
const linux = process.platform === "linux";
const pidNamespace = linux && probePidNamespace().ok;
const bwrap = linux && existsSync("/usr/bin/bwrap");

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

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  // An unverified teardown opens the worker-wide breaker, which refuses every later command.
  resetUnverifiedTeardownsForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

let markers = 0;

function uniqueSleep(): string {
  markers += 1;
  return `30.${process.pid}${markers}`;
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

/**
 * A command whose stdout outlives it, held by a process the supervisor can neither see nor kill:
 * the grandchild double-forks out of the group (re-parented away from the root) before the root
 * is stopped. Only process-group containment can show this without a host service.
 */
function escapedStdout(duration: string): string[] {
  return ["-c", `setsid sh -c 'sleep ${duration} &'; sleep 600`];
}

/** Provider none without a PID namespace, allowed by the explicit unisolated override. */
function unisolatedSession(): SandboxSession {
  return {
    providerId: "none",
    isolation: { filesystem: false, network: "none", processes: false, location: "local" },
    spawn: (command) => spawnContained(command.binary, command.args, { env: command.env, containment: "process-group" }),
    close: async () => {},
  };
}

function quickTeardown(): void {
  vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED", "true");
  vi.stubEnv("WORKER_COMMAND_ABORT_GRACE_MS", "200");
  vi.stubEnv("WORKER_COMMAND_LAUNCHER_GRACE_MS", "200");
  vi.stubEnv("WORKER_COMMAND_TEARDOWN_VERIFY_MS", "500");
}

describe.skipIf(!linux)("an unverified teardown wins over the error that stopped the command", () => {
  it("run(): a wall-clock timeout ends in CommandTeardownError (cause HungWorkError) and poisons the slot", async () => {
    quickTeardown();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const duration = uniqueSleep();
    const runner = new CommandRunner({ openSession: async () => unisolatedSession() });
    const slots = new Semaphore(2);
    const run = slots.run(undefined, () =>
      runner.run({ binary: "/usr/bin/bash", args: escapedStdout(duration), available: true, timeoutMs: 800 }),
    );
    run.catch(() => {});
    await sleeperStarted(duration);
    const outcome = await within(run, 8_000);
    expect(outcome).not.toBe("unsettled");
    const error = (outcome as { error: Error }).error;
    // Old behavior: HungWorkError replaced it and the slot was released (poisoned=0).
    expect(error).toBeInstanceOf(CommandTeardownError);
    expect(error.cause).toBeInstanceOf(HungWorkError);
    expect(slots.poisoned).toBe(1);
    expect(slots.inUse).toBe(1);
  }, 20_000);

  it("run(): an RSS-budget kill ends in CommandTeardownError (cause the budget error) and poisons the slot", async () => {
    quickTeardown();
    vi.stubEnv("WORKER_COMMAND_MAX_RSS_MB", "1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const duration = uniqueSleep();
    const runner = new CommandRunner({ openSession: async () => unisolatedSession() });
    const slots = new Semaphore(1);
    // The escapee is double-forked before the first RSS sample (250 ms) kills the root.
    const run = slots.run(undefined, () =>
      runner.run({ binary: "/usr/bin/bash", args: escapedStdout(duration), available: true, timeoutMs: 20_000 }),
    );
    run.catch(() => {});
    const outcome = await within(run, 8_000);
    sleeperPids(duration).forEach((pid) => strays.push(pid));
    expect(outcome).not.toBe("unsettled");
    const error = (outcome as { error: Error }).error;
    expect(error).toBeInstanceOf(CommandTeardownError);
    expect(String((error.cause as Error)?.message)).toMatch(/RSS budget/);
    expect(slots.poisoned).toBe(1);
  }, 20_000);

  it("runToWritable(): a timeout ends in CommandTeardownError and poisons the slot", async () => {
    quickTeardown();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const duration = uniqueSleep();
    const runner = new CommandRunner({ openSession: async () => unisolatedSession() });
    const slots = new Semaphore(2);
    const sink = new PassThrough();
    sink.resume();
    const run = slots.run(undefined, () =>
      runner.runToWritable({ binary: "/usr/bin/bash", args: escapedStdout(duration), available: true, timeoutMs: 800 }, sink),
    );
    run.catch(() => {});
    await sleeperStarted(duration);
    const outcome = await within(run, 8_000);
    expect(outcome).not.toBe("unsettled");
    const error = (outcome as { error: Error }).error;
    expect(error).toBeInstanceOf(CommandTeardownError);
    expect(error.cause).toBeInstanceOf(HungWorkError);
    expect(slots.poisoned).toBe(1);
  }, 20_000);
});

function containedSession(onClose: () => void): SandboxSession {
  const containment: Containment = pidNamespace ? "pid-namespace" : "process-group";
  return {
    providerId: "none",
    isolation: { filesystem: false, network: "none", processes: pidNamespace, location: "local" },
    spawn: (command) => spawnContained(command.binary, command.args, { env: command.env, containment, init: true }),
    close: async () => onClose(),
  };
}

describe.skipIf(!linux)("runToWritable with a failing destination", () => {
  it("stops the command and releases the session only after its processes are gone", async () => {
    vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED", "true");
    vi.stubEnv("WORKER_COMMAND_ABORT_GRACE_MS", "200");
    const duration = uniqueSleep();
    let liveAtRelease: number[] | null = null;
    const runner = new CommandRunner({
      openSession: async () => containedSession(() => (liveAtRelease = sleeperPids(duration).filter(alive))),
    });
    const full = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }));
      },
    });
    const run = runner.runToWritable(
      {
        binary: "/usr/bin/bash",
        args: ["-c", `trap "" TERM PIPE; sleep ${duration} & sleep 0.3; echo page; wait`],
        available: true,
        timeoutMs: 20_000,
      },
      full,
    );
    run.catch(() => {});
    await sleeperStarted(duration);
    const outcome = await within(run, 8_000);
    expect(outcome).not.toBe("unsettled");
    expect(String((outcome as { error: Error }).error)).toMatch(/ENOSPC/);
    // Old behavior: Promise.all rejected at once, and the session closed while the sleeper ran.
    expect(liveAtRelease).toEqual([]);
    expect(sleeperPids(duration).filter(alive)).toEqual([]);
  }, 20_000);
});

describe.skipIf(!linux)("sandbox scratch owner file", () => {
  function instance(): string {
    const root = scratch("docslurp-owner-");
    const dir = path.join(root, "run-abc123");
    mkdirSync(dir);
    return dir;
  }
  const cleanupOf = (dir: string) => () => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(`${dir}.owner`, { force: true });
  };

  it("keeps supervising a started command when the owner update fails (ENOSPC), and cleans up after teardown", async () => {
    const dir = instance();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    let writes = 0;
    const writer = (file: string, pid: number) => {
      writes += 1;
      if (writes > 1) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      writeFileSync(file, `${pid}\n`);
    };
    const child = spawnOwned(
      dir,
      () => spawnContained("/bin/sh", ["-c", "sleep 0.3"], { env: process.env, containment: "process-group" }),
      cleanupOf(dir),
      writer,
    );
    // Old behavior: the throw deleted the scratch and dropped the running child unsupervised.
    expect(child.pid).toBeDefined();
    expect(readFileSync(`${dir}.owner`, "utf8").trim()).toBe(String(process.pid));
    expect(existsSync(dir)).toBe(true);
    await superviseChild(child, { label: "owned" }).done;
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(`${dir}.owner`)).toBe(false);
    expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toMatch(/status=owner-write-failed/);
  }, 10_000);

  it("starts nothing and removes the scratch when the owner cannot be written before spawn", () => {
    const dir = instance();
    const start = vi.fn(() => spawnContained("/bin/true", [], { env: process.env, containment: "process-group" }));
    expect(() =>
      spawnOwned(dir, start, cleanupOf(dir), () => {
        throw new Error("ENOSPC");
      }),
    ).toThrow(/ENOSPC/);
    expect(start).not.toHaveBeenCalled();
    expect(existsSync(dir)).toBe(false);
  });

  it("records the command's root pid once it started", async () => {
    const dir = instance();
    const child = spawnOwned(
      dir,
      () => spawnContained("/bin/sh", ["-c", "sleep 0.2"], { env: process.env, containment: "process-group" }),
      cleanupOf(dir),
    );
    expect(readFileSync(`${dir}.owner`, "utf8").trim()).toBe(String(child.pid));
    await superviseChild(child, { label: "owned" }).done;
    expect(existsSync(dir)).toBe(false);
  });
});

describe.skipIf(!linux)("supervisor settles only after verification", () => {
  it("does not resolve while group members that closed their stdio are still alive", async () => {
    const duration = uniqueSleep();
    // 100 TERM-ignoring group members with closed stdio, and a root that exits at once: 'close'
    // comes immediately, while verification is still SIGKILLing the group.
    const child = spawnContained(
      "/usr/bin/bash",
      ["-c", `for i in $(seq 100); do (trap "" TERM; exec sleep ${duration}) </dev/null >/dev/null 2>&1 & done; exit 0`],
      { env: process.env, containment: "process-group" },
    );
    const supervised = superviseChild(child, { label: "crowd", timings: { graceMs: 100, launcherGraceMs: 100, verifyMs: 5_000 } });
    const outcome = await within(supervised.done, 8_000);
    const live = sleeperPids(duration).filter(alive);
    strays.push(...live);
    expect(outcome).toHaveProperty("value");
    expect(live).toEqual([]);
  }, 15_000);

  it("waits for verification to see the group empty even after 'close' (root exited, stdio closed)", async () => {
    const child = spawnContained("/bin/sh", ["-c", "exit 0"], { env: process.env, containment: "process-group" });
    const pgid = child.pid!;
    // The group still reports a member for 400 ms after the root exits: a straggler that takes
    // its time to die. 'close' arrives long before that.
    let exitedAt = 0;
    child.once("exit", () => (exitedAt = Date.now()));
    const realKill = process.kill.bind(process);
    vi.spyOn(process, "kill").mockImplementation((pid: number, signal?: string | number) => {
      if (pid === -pgid && exitedAt && Date.now() - exitedAt < 400) return true;
      return realKill(pid, signal);
    });
    let closedAt = 0;
    child.once("close", () => (closedAt = Date.now()));
    const supervised = superviseChild(child, { label: "straggler", timings: { graceMs: 100, launcherGraceMs: 100, verifyMs: 5_000 } });
    await supervised.done;
    const settledAt = Date.now();
    // Old behavior: settled on 'close', while verification still saw a live group member.
    expect(closedAt).toBeGreaterThan(0);
    expect(settledAt - exitedAt).toBeGreaterThanOrEqual(400);
  }, 10_000);
});

const python = linux && spawnSync("python3", ["-c", "import socket; socket.send_fds"]).status === 0;

/**
 * A host service outside the command's namespace: it accepts one UNIX-socket connection, takes the
 * file descriptors passed over it (as a session bus or systemd user manager would for a process it
 * starts) and keeps them open. Resolves with its pid once it listens.
 */
async function startHostService(socketPath: string): Promise<number> {
  const service = spawn(
    "python3",
    [
      "-c",
      "import os, socket, sys, time\n" +
        "s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1]); s.listen(1); print('ready', flush=True)\n" +
        "c, _ = s.accept(); msg, fds, _, _ = socket.recv_fds(c, 16, 4); time.sleep(30)",
      socketPath,
    ],
    { stdio: ["ignore", "pipe", "ignore"], detached: true },
  );
  service.unref();
  strays.push(service.pid!);
  await new Promise<void>((resolve, reject) => {
    service.stdout!.once("data", () => resolve());
    service.once("exit", () => reject(new Error("host service exited")));
  });
  service.stdout!.destroy();
  return service.pid!;
}

/** The command hands its stdout to the host service, then exits. */
function handOffStdout(socketPath: string, after: string): string[] {
  return [
    "-c",
    "import socket, sys\n" +
      "c = socket.socket(socket.AF_UNIX); c.connect(sys.argv[1]); socket.send_fds(c, [b'x'], [1]); c.close()\n" +
      after,
    socketPath,
  ];
}

describe.skipIf(!pidNamespace || !python)("stdio held by a process outside the PID namespace", () => {
  it("ends in CommandTeardownError within the bound and poisons the slot", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const socketPath = path.join(scratch("docslurp-bus-"), "bus");
    await startHostService(socketPath);
    const child = spawnContained("python3", handOffStdout(socketPath, "import time; time.sleep(0.3)"), {
      env: process.env,
      containment: "pid-namespace",
    });
    const supervised = superviseChild(child, { label: "held", timings: { graceMs: 100, launcherGraceMs: 100, verifyMs: 500 } });
    const slots = new Semaphore(1);
    // Old behavior: no stdio bound with a namespace, so this never settled.
    const outcome = await within(slots.run(undefined, () => supervised.done), 5_000);
    expect(outcome).not.toBe("unsettled");
    expect((outcome as { error: unknown }).error).toBeInstanceOf(CommandTeardownError);
    expect(child.stdout?.destroyed).toBe(true);
    expect(slots.poisoned).toBe(1);
  }, 15_000);

  it("lets an abort after the root exited act at once instead of waiting out the bound", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const socketPath = path.join(scratch("docslurp-bus-"), "bus");
    await startHostService(socketPath);
    const child = spawnContained("python3", handOffStdout(socketPath, ""), { env: process.env, containment: "pid-namespace" });
    const controller = new AbortController();
    const supervised = superviseChild(child, {
      label: "held",
      signal: controller.signal,
      timings: { graceMs: 100, launcherGraceMs: 100, verifyMs: 30_000 },
    });
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const abortedAt = Date.now();
    controller.abort();
    const outcome = await within(supervised.done, 5_000);
    expect(outcome).not.toBe("unsettled");
    const error = (outcome as { error: Error }).error;
    expect(error).toBeInstanceOf(CommandTeardownError);
    expect((error.cause as Error).name).toBe("AbortError");
    expect(Date.now() - abortedAt).toBeLessThan(2_000);
  }, 15_000);
});

describe("containment the runner accepts", () => {
  it("refuses a process-group child from a provider other than unisolated none, after stopping it", async () => {
    let child: ReturnType<typeof spawnContained> | undefined;
    let exitedBeforeRelease = false;
    const runner = new CommandRunner({
      openSession: async () => ({
        providerId: "claims-processes",
        isolation: { filesystem: true, network: "full", processes: true, location: "local" },
        spawn: () => (child = spawnContained("/bin/sh", ["-c", "sleep 30"], { env: process.env, containment: "process-group" })),
        close: async () => {
          exitedBeforeRelease = child?.exitCode !== null || child?.signalCode !== null;
        },
      }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runner.run({ binary: "/bin/sh", args: [], available: true })).rejects.toThrow(
      /process-group containment instead of a PID namespace/,
    );
    // Refused for lacking a PID namespace, so its teardown is never proven (round 4): poisoned.
    const error = await runner.run({ binary: "/bin/sh", args: [], available: true }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(CommandTeardownError);
    expect((error as Error).cause).toBeInstanceOf(SandboxPolicyError);
    expect(exitedBeforeRelease).toBe(true);
  }, 15_000);

  it("still refuses process-group on provider none without the unisolated override", async () => {
    const runner = new CommandRunner({
      openSession: async () => ({ ...unisolatedSession(), isolation: { ...unisolatedSession().isolation, processes: true } }),
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const error = await runner.run({ binary: "/bin/sh", args: ["-c", "true"], available: true }).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(CommandTeardownError);
    expect((error as Error).cause).toBeInstanceOf(SandboxPolicyError);
  });
});

describe.skipIf(!pidNamespace)("bubblewrap probe runs the launcher in a PID namespace", () => {
  function fakeLauncher(body: string): void {
    const dir = scratch("docslurp-fake-scripts-");
    writeFileSync(path.join(dir, "parser-sandbox.sh"), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(path.join(dir, "parser-sandbox.sh"), 0o755);
    vi.stubEnv("DOCSLURP_WORKER_SCRIPTS_DIR", dir);
  }
  const config = () => bubblewrap.readConfig({ DOCSLURP_PARSER_SANDBOX_ROOT: scratch("docslurp-probe-root-") });

  it("runs the launcher as its namespace's init, as commands do", async () => {
    // Old behavior: spawnSync ran the launcher bare, as an ordinary host process.
    fakeLauncher('[[ $$ == 1 ]] || { echo "not namespace init" >&2; exit 3; }');
    await expect(bubblewrap.probe(config())).resolves.toMatchObject({ ok: true });
  });

  it("fails the probe with the launcher's error when it cannot start inside the namespace", async () => {
    fakeLauncher('echo "bwrap: No permissions to create new namespace" >&2; exit 1');
    await expect(bubblewrap.probe(config())).resolves.toMatchObject({
      ok: false,
      detail: expect.stringMatching(/No permissions to create new namespace/),
    });
  });

  it.skipIf(!bwrap)("passes on this host with the real launcher", async () => {
    await expect(bubblewrap.probe(config())).resolves.toMatchObject({ ok: true });
  }, 20_000);
});

describe.skipIf(!pidNamespace)("provider none runs a minimal init in front of the parser", () => {
  it("aborts a parser that would ignore SIGTERM as PID 1 without waiting out the grace period", async () => {
    vi.stubEnv("WORKER_COMMAND_ABORT_GRACE_MS", "5000");
    const session = await none.openSession({}, { activityId: "init" });
    const runner = new CommandRunner({ openSession: async () => session });
    const duration = uniqueSleep();
    const controller = new AbortController();
    const run = runner.run({ binary: "/bin/sleep", args: [duration], available: true }, controller.signal);
    run.catch(() => {});
    await sleeperStarted(duration);
    const abortedAt = Date.now();
    controller.abort();
    const outcome = await within(run, 10_000);
    expect(outcome).not.toBe("unsettled");
    expect(((outcome as { error: Error }).error).name).toBe("AbortError");
    // As PID 1, sleep ignored SIGTERM, so the abort waited the full 5 s grace for SIGKILL.
    expect(Date.now() - abortedAt).toBeLessThan(2_000);
  }, 20_000);

  it("keeps the parser's exit status", async () => {
    const session = await none.openSession({}, { activityId: "init" });
    const runner = new CommandRunner({ openSession: async () => session });
    await expect(runner.run({ binary: "/bin/sh", args: ["-c", "echo out; exit 7"], available: true })).rejects.toThrow(/\(7\): out/);
    await expect(runner.run({ binary: "/bin/sh", args: ["-c", "echo ok"], available: true })).resolves.toMatchObject({ stdout: "ok\n" });
  });
});

describe.skipIf(!linux)("stale sandbox scratch sweep edge cases", () => {
  const old = (target: string, ageMs: number) => {
    const at = new Date(Date.now() - ageMs);
    utimesSync(target, at, at);
  };

  it("never follows or removes through symlinked entries", () => {
    const root = scratch("docslurp-sweep-links-");
    const outside = scratch("docslurp-sweep-outside-");
    writeFileSync(path.join(outside, "precious"), "x");
    // A run-* symlink to a directory elsewhere, aged and unowned.
    symlinkSync(outside, path.join(root, "run-link"));
    // A stale instance that contains a symlink pointing outside.
    const stale = path.join(root, "run-stale");
    mkdirSync(stale);
    symlinkSync(outside, path.join(stale, "escape"));
    // Unowned instances age by ctime, which cannot be backdated: sweep from four hours ahead.
    const removed = sweepStaleSandboxScratch(root, { now: Date.now() + 4 * 60 * 60_000 });
    expect(removed).toEqual([stale]);
    expect(existsSync(path.join(root, "run-link"))).toBe(true);
    expect(readFileSync(path.join(outside, "precious"), "utf8")).toBe("x");
  });

  it("keeps an instance while its real owner process lives, and removes it once that process exits", async () => {
    const root = scratch("docslurp-sweep-live-");
    const dir = path.join(root, "run-live");
    mkdirSync(dir);
    const owner = spawn("sleep", ["30"], { stdio: "ignore" });
    strays.push(owner.pid!);
    writeFileSync(`${dir}.owner`, `${owner.pid}\n`);
    old(`${dir}.owner`, 10 * 60 * 60_000);
    expect(sweepStaleSandboxScratch(root)).toEqual([]);
    expect(existsSync(dir)).toBe(true);
    const exited = new Promise((resolve) => owner.once("exit", resolve));
    owner.kill("SIGKILL");
    await exited;
    expect(sweepStaleSandboxScratch(root)).toEqual([dir]);
    expect(existsSync(`${dir}.owner`)).toBe(false);
  });

  it("keeps an instance whose owner is still the worker's placeholder pid", () => {
    const root = scratch("docslurp-sweep-placeholder-");
    const dir = path.join(root, "run-placeholder");
    mkdirSync(dir);
    writeFileSync(`${dir}.owner`, `${process.pid}\n`);
    old(`${dir}.owner`, 10 * 60 * 60_000);
    expect(sweepStaleSandboxScratch(root)).toEqual([]);
  });
});

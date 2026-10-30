import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Semaphore } from "../pipeline/pdf-asset-cache.js";
import bubblewrap from "../sandbox/providers/bubblewrap/index.js";
import { sweepStaleSandboxScratch } from "../sandbox/scratch-sweep.js";
import {
  CommandTeardownError,
  probePidNamespace,
  spawnContained,
  superviseChild,
  resetUnverifiedTeardownsForTests,
} from "../sandbox/teardown.js";
import { SandboxPolicyError, type SandboxSession } from "../sandbox/types.js";
import { CommandRunner } from "../tools/runner.js";

// Real processes throughout: these tests reproduce the #234 re-review findings.
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

/** Settles with the outcome, or with "unsettled" after `ms`, so a hang fails the test instead of timing it out. */
function within<T>(promise: Promise<T>, ms: number): Promise<{ value: T } | { error: unknown } | "unsettled"> {
  return Promise.race([
    promise.then((value) => ({ value }), (error: unknown) => ({ error })),
    new Promise<"unsettled">((resolve) => setTimeout(() => resolve("unsettled"), ms)),
  ]);
}

afterEach(() => {
  // A failing run must not leak its 30 s sleepers into the rest of the suite.
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  // An unverified teardown opens the worker-wide breaker, which refuses every later command.
  resetUnverifiedTeardownsForTests();
  vi.unstubAllEnvs();
});

let markers = 0;

/** A `sleep` duration no other process uses, so the test can find that sleeper's host pid. */
function uniqueSleep(): string {
  markers += 1;
  return `30.${process.pid}${markers}`;
}

/** Host pid of the live `sleep <duration>`, read from the host's /proc (the command sees its own). */
function sleeperPid(duration: string): number | null {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (readFileSync(`/proc/${entry}/cmdline`, "utf8") === `sleep\0${duration}\0`) return Number(entry);
    } catch {}
  }
  return null;
}

function redirect(stdio: "closed" | "inherited"): string {
  return stdio === "closed" ? "</dev/null >/dev/null 2>&1" : "";
}

/**
 * A root that exits at once on SIGTERM (`wait` returns to run the trap) and a grandchild that calls
 * setsid (leaving the process group and, once the root is gone, re-parenting) and ignores SIGTERM.
 */
function escapingTree(duration: string, grandchildStdio: "closed" | "inherited"): string[] {
  const grandchild = `trap "" TERM; exec sleep ${duration}`;
  return ["-c", `trap "exit 0" TERM; setsid bash -c '${grandchild}' ${redirect(grandchildStdio)} & sleep 600 & wait $!`];
}

async function sleeperStarted(duration: string): Promise<number> {
  let pid: number | null = null;
  await waitFor(() => (pid = sleeperPid(duration)) !== null);
  strays.push(pid!);
  return pid!;
}

describe.skipIf(!linux)("verified teardown of an aborted command", () => {
  it.each(["closed", "inherited"] as const)(
    "settles only after a detached, TERM-ignoring grandchild (stdio %s) is gone, within the bound",
    async (stdio) => {
      vi.stubEnv("WORKER_COMMAND_ABORT_GRACE_MS", "300");
      const duration = uniqueSleep();
      const controller = new AbortController();
      const run = new CommandRunner().run(
        { binary: "/usr/bin/bash", args: escapingTree(duration, stdio), available: true },
        controller.signal,
      );
      run.catch(() => {});
      const grandchild = await sleeperStarted(duration);
      expect(alive(grandchild)).toBe(true);

      const abortedAt = Date.now();
      controller.abort();
      // Old behavior: the run settled while the grandchild lived (closed stdio), or never settled (inherited stdio).
      const outcome = await within(run, 8_000);
      expect(outcome).not.toBe("unsettled");
      expect(outcome).toHaveProperty("error");
      expect(((outcome as { error: Error }).error).name).toBe("AbortError");
      expect(alive(grandchild)).toBe(false);
      expect(Date.now() - abortedAt).toBeLessThan(8_000);
    },
    20_000,
  );

  it("settles a timed-out command only after the same verified teardown", async () => {
    vi.stubEnv("WORKER_COMMAND_ABORT_GRACE_MS", "300");
    const duration = uniqueSleep();
    const run = new CommandRunner().run({
      binary: "/usr/bin/bash",
      args: escapingTree(duration, "inherited"),
      available: true,
      timeoutMs: 1_500,
    });
    run.catch(() => {});
    const grandchild = await sleeperStarted(duration);
    const outcome = await within(run, 10_000);
    expect(outcome).not.toBe("unsettled");
    expect(String((outcome as { error: Error }).error)).toMatch(/wall-clock budget/);
    expect(alive(grandchild)).toBe(false);
  }, 20_000);

  it.each(["closed", "inherited"] as const)(
    "kills a lingering descendant (stdio %s) after a normal exit, and settles within the bound",
    async (stdio) => {
      const duration = uniqueSleep();
      // The root exits 0 on its own and leaves a daemon behind. With stdio inherited the old runner
      // never saw 'close', and its timers targeted the dead root: run() never settled.
      const run = new CommandRunner().run({
        binary: "/usr/bin/bash",
        args: ["-c", `setsid bash -c 'trap "" TERM; exec sleep ${duration}' ${redirect(stdio)} & sleep 0.5; echo done`],
        available: true,
        timeoutMs: 3_000,
      });
      run.catch(() => {});
      const pid = await sleeperStarted(duration);
      const outcome = await within(run, 8_000);
      expect(outcome).not.toBe("unsettled");
      expect(outcome).toHaveProperty("value");
      expect((outcome as { value: { stdout: string } }).value.stdout.trim()).toBe("done");
      expect(alive(pid)).toBe(false);
    },
    20_000,
  );
});

describe("process teardown policy", () => {
  function sessionWithout(providerId: string): { session: SandboxSession; spawned: ReturnType<typeof vi.fn> } {
    const spawned = vi.fn(() =>
      spawnContained("/bin/sh", ["-c", "echo ran"], { env: process.env, containment: "process-group" }),
    );
    return {
      spawned,
      session: {
        providerId,
        isolation: { filesystem: true, network: "tcp-only", processes: false, location: "local" },
        spawn: spawned,
        close: async () => {},
      },
    };
  }

  it("refuses untrusted parser work on a provider without PID isolation", async () => {
    const { session, spawned } = sessionWithout("landlock");
    const runner = new CommandRunner({ openSession: async () => session });
    await expect(runner.run({ binary: "/bin/sh", args: ["-c", "echo ran"], available: true })).rejects.toBeInstanceOf(
      SandboxPolicyError,
    );
    expect(spawned).not.toHaveBeenCalled();
  });

  it("refuses it even with the unisolated override, which only covers provider none", async () => {
    vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED", "true");
    const { session, spawned } = sessionWithout("landlock");
    const runner = new CommandRunner({ openSession: async () => session });
    await expect(runner.run({ binary: "/bin/sh", args: ["-c", "echo ran"], available: true })).rejects.toThrow(
      /cannot guarantee that a command's processes die with it/,
    );
    expect(spawned).not.toHaveBeenCalled();
  });

  it("runs provider none without a PID namespace only with the explicit unisolated override", async () => {
    const { session, spawned } = sessionWithout("none");
    const runner = new CommandRunner({ openSession: async () => session });
    await expect(runner.run({ binary: "/bin/sh", args: ["-c", "echo ran"], available: true })).rejects.toBeInstanceOf(
      SandboxPolicyError,
    );
    vi.stubEnv("DOCSLURP_PARSER_SANDBOX_ALLOW_UNISOLATED", "true");
    await expect(runner.run({ binary: "/bin/sh", args: ["-c", "echo ran"], available: true })).resolves.toMatchObject({
      stdout: "ran\n",
    });
    expect(spawned).toHaveBeenCalledTimes(1);
  });

  it("refuses a child the provider did not start contained", async () => {
    const { spawn } = await import("node:child_process");
    const runner = new CommandRunner({
      openSession: async () => ({
        providerId: "careless",
        isolation: { filesystem: true, network: "full", processes: true, location: "local" },
        spawn: () => spawn("/bin/sh", ["-c", "sleep 5"], { stdio: ["ignore", "pipe", "pipe"] }),
        close: async () => {},
      }),
    });
    await expect(runner.run({ binary: "/bin/sh", args: [], available: true })).rejects.toThrow(/without process containment/);
  });
});

describe.skipIf(!linux)("unverifiable teardown", () => {
  it("destroys stdio, settles with CommandTeardownError within the bound, and poisons the slot", async () => {
    // Process-group containment (no PID namespace): a setsid'd grandchild keeps the stdout pipe open
    // after the group empties, so 'close' never comes. It must not hang.
    const duration = uniqueSleep();
    const child = spawnContained("/usr/bin/bash", ["-c", `setsid sleep ${duration} & sleep 0.3`], {
      env: process.env,
      containment: "process-group",
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const supervised = superviseChild(child, {
      label: "escapee",
      timings: { graceMs: 100, launcherGraceMs: 100, verifyMs: 500 },
      context: { run_id: "run-1", document_id: "doc-1" },
    });
    const slots = new Semaphore(2);
    const startedAt = Date.now();
    const outcome = await within(slots.run(undefined, () => supervised.done), 5_000);
    const escapee = sleeperPid(duration);
    if (escapee) strays.push(escapee);
    expect(outcome).not.toBe("unsettled");
    expect((outcome as { error: unknown }).error).toBeInstanceOf(CommandTeardownError);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(child.stdout?.destroyed).toBe(true);
    // The slot stays out of service, visibly.
    expect(slots.inUse).toBe(1);
    expect(slots.poisoned).toBe(1);
    const logged = error.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toMatch(/status=teardown-unverified metric=command_teardown_unverified .*run_id=run-1 document_id=doc-1/);
    expect(logged).toMatch(/status=slot-poisoned/);
  }, 10_000);
});

describe.skipIf(!bwrap || !pidNamespace)("bubblewrap launcher teardown", () => {
  it("removes the sandbox instance directory when teardown escalates to SIGKILL", async () => {
    const sandboxRoot = scratch("docslurp-sandbox-root-");
    // Any process exceeds a 1 MiB budget, so the first sample kills the command at once (no TERM grace).
    vi.stubEnv("WORKER_COMMAND_MAX_RSS_MB", "1");
    const session = await bubblewrap.openSession(bubblewrap.readConfig({ DOCSLURP_PARSER_SANDBOX_ROOT: sandboxRoot }), {
      activityId: "teardown",
    });
    const runner = new CommandRunner({ openSession: async () => session });
    await expect(runner.run({ binary: "/bin/sleep", args: ["30"], available: true })).rejects.toThrow(/RSS budget/);
    // The old kill took the launcher with the parser, so its EXIT trap never removed run-XXXXXX.
    // Only the worker's seccomp filter (sandbox/seccomp.ts) stays in the root, never an instance.
    expect(readdirSync(sandboxRoot).filter((name) => !/^seccomp-.*\.bpf$/.test(name))).toEqual([]);
  }, 20_000);
});

describe.skipIf(!linux)("parser-sandbox.sh wait loop", () => {
  it("terminates when wait returns 127 (its bwrap pid reused by another process)", () => {
    const root = scratch("docslurp-launcher-");
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "bwrap"), "#!/bin/sh\nexit 0\n");
    chmodSync(path.join(bin, "bwrap"), 0o755);
    const result = spawnSync("/usr/bin/bash", [path.resolve("scripts/parser-sandbox.sh"), "/bin/true"], {
      encoding: "utf8",
      timeout: 5_000,
      // The launcher traps TERM, so only SIGKILL stops the old spinning loop.
      killSignal: "SIGKILL",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        DOCSLURP_PARSER_SANDBOX_ROOT: path.join(root, "sandbox"),
        // An exported function standing in for pid reuse: kill -0 always finds "bwrap" alive.
        "BASH_FUNC_kill%%": "() { return 0; }",
      },
    });
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(readdirSync(path.join(root, "sandbox"))).toEqual([]);
  }, 10_000);
});

describe("stale sandbox scratch sweep", () => {
  it("removes instances whose owner exited or that have no owner for too long, and keeps the rest", () => {
    const root = scratch("docslurp-sweep-");
    const now = Date.now();
    // Age is the owner file's mtime (the worker writes it), or the instance's ctime without one.
    // The parser can backdate its own instance (here to 1970); that must not age it.
    const make = (name: string, ownerAgeMs?: number, owner?: number) => {
      const dir = path.join(root, name);
      mkdirSync(path.join(dir, "tmp"), { recursive: true });
      writeFileSync(path.join(dir, "tmp", "parser-output"), "x");
      if (owner !== undefined) {
        writeFileSync(`${dir}.owner`, `${owner}\n`);
        const at = new Date(now - ownerAgeMs!);
        utimesSync(`${dir}.owner`, at, at);
      }
      utimesSync(dir, new Date(0), new Date(0));
      return dir;
    };
    const live = 4242;
    const dead = 4343;
    const isAlive = (pid: number) => pid === live;
    const ownerGone = make("run-ownergone", 120_000, dead);
    const ownerLive = make("run-ownerlive", 10 * 60 * 60_000, live);
    const fresh = make("run-fresh", 5_000, dead);
    const unowned = make("run-unowned");
    const unrelated = make("keep-me");

    expect(sweepStaleSandboxScratch(root, { now, isAlive })).toEqual([ownerGone]);
    expect(existsSync(ownerGone)).toBe(false);
    expect(existsSync(`${ownerGone}.owner`)).toBe(false);
    for (const dir of [ownerLive, fresh, unowned, unrelated]) expect(existsSync(dir)).toBe(true);

    // Three hours on, the unowned instance (by ctime) and the one whose owner exited are due.
    const later = sweepStaleSandboxScratch(root, { now: now + 3 * 60 * 60_000 + 1_000, isAlive });
    expect(later.sort()).toEqual([fresh, unowned].sort());
    for (const dir of [ownerLive, unrelated]) expect(existsSync(dir)).toBe(true);
  });
});

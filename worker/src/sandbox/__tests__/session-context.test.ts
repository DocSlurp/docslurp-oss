import { afterEach, describe, expect, it, vi } from "vitest";

import { PassThrough } from "node:stream";

import { runWithPerfContext } from "../../lib/perf-context.js";
import { ProgressTracker, runWithProgressTracker } from "../../lib/work-progress.js";
import type { UsageEvent } from "../../models.js";
import { CommandRunner } from "../../tools/runner.js";
import { runWithSandboxScope, SandboxSessionScope } from "../session-context.js";
import { spawnContained } from "../teardown.js";
import { SandboxRunError, type SandboxCommand, type SandboxIsolation, type SandboxResult, type SandboxSession } from "../types.js";

const ISOLATION: SandboxIsolation = { filesystem: false, network: "none", processes: true, location: "local" };

function recordingSession(id: string, commands: SandboxCommand[]): SandboxSession {
  return {
    providerId: id,
    isolation: ISOLATION,
    spawn: (command) => {
      commands.push(command);
      return spawnContained(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(id)})`], {
        env: process.env,
        containment: "process-group",
      });
    },
    close: async () => {},
  };
}

describe("SandboxSessionScope", () => {
  it("opens once however often get() is called", async () => {
    const open = vi.fn(async () => recordingSession("a", []));
    const scope = new SandboxSessionScope(open);
    const [first, second] = await Promise.all([scope.get(), scope.get()]);
    expect(first).toBe(second);
    expect(await scope.get()).toBe(first);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("never opens, and closes as a no-op, when nothing asked for a session", async () => {
    const open = vi.fn(async () => recordingSession("a", []));
    await new SandboxSessionScope(open).close();
    expect(open).not.toHaveBeenCalled();
  });

  it("closes an opened session", async () => {
    const close = vi.fn(async () => {});
    const scope = new SandboxSessionScope(async () => ({ ...recordingSession("a", []), close }));
    await scope.get();
    await scope.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("sandbox scope isolation between concurrent activities", () => {
  it("runs each activity's commands only in its own session", async () => {
    const commandsA: SandboxCommand[] = [];
    const commandsB: SandboxCommand[] = [];
    const scopeA = new SandboxSessionScope(async () => recordingSession("A", commandsA));
    const scopeB = new SandboxSessionScope(async () => recordingSession("B", commandsB));
    // One runner shared by both activities, as in the worker. Its own openSession must not be used.
    const runner = new CommandRunner({
      openSession: async () => {
        throw new Error("scoped sessions must win over the runner-level opener");
      },
    });
    const runIn = (scope: SandboxSessionScope, marker: string) =>
      runWithSandboxScope(scope, async () => {
        await new Promise((resolve) => setTimeout(resolve, marker === "a1" ? 20 : 0));
        return runner.run({ binary: process.execPath, args: ["-e", `//${marker}`], available: true });
      });

    const [a1, b1, a2, b2] = await Promise.all([
      runIn(scopeA, "a1"),
      runIn(scopeB, "b1"),
      runIn(scopeA, "a2"),
      runIn(scopeB, "b2"),
    ]);

    expect([a1.stdout, a2.stdout]).toEqual(["A", "A"]);
    expect([b1.stdout, b2.stdout]).toEqual(["B", "B"]);
    expect(commandsA.flatMap((c) => c.args).filter((a) => a.startsWith("//")).sort()).toEqual(["//a1", "//a2"]);
    expect(commandsB.flatMap((c) => c.args).filter((a) => a.startsWith("//")).sort()).toEqual(["//b1", "//b2"]);
  });

  it("opens and closes a per-command session outside any scope", async () => {
    const close = vi.fn(async () => {});
    const openSession = vi.fn(async () => ({ ...recordingSession("solo", []), close }));
    const runner = new CommandRunner({ openSession });
    const result = await runner.run({ binary: process.execPath, args: ["-e", ""], available: true });
    expect(result.stdout).toBe("solo");
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("remote (run-only) sessions", () => {
  const remote = (result: { exitCode: number | null; stdout?: string; stderr?: string }): SandboxSession => ({
    providerId: "remote",
    isolation: { ...ISOLATION, location: "remote" },
    run: async () => ({ stdout: "", stderr: "", ...result }),
    close: async () => {},
  });
  const plan = { binary: "parser", args: ["x"], available: true };

  it("rejects with the provider's stderr on a non-zero exit", async () => {
    const runner = new CommandRunner({ openSession: async () => remote({ exitCode: 2, stderr: "boom" }) });
    await expect(runner.run(plan)).rejects.toThrow("boom");
  });

  it("resolves stdout on success", async () => {
    const runner = new CommandRunner({ openSession: async () => remote({ exitCode: 0, stdout: "x" }) });
    await expect(runner.run(plan)).resolves.toEqual({ stdout: "x", stderr: "" });
  });
});

describe("remote commands in the runner", () => {
  const plan = { binary: "parser", args: ["x"], available: true, timeoutMs: 120_000 };
  const usage: UsageEvent = {
    provider: "modal",
    model: "modal:app",
    metric: "sandbox_compute",
    amount: 1,
    unit: "cent",
    costCents: 0,
    metadata: { costRollup: "included", billable: false },
  };
  const runSession = (run: () => Promise<SandboxResult>): SandboxSession => ({
    providerId: "remote",
    isolation: { ...ISOLATION, location: "remote" },
    run,
    close: async () => {},
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  function inStage<T>(events: UsageEvent[], fn: () => Promise<T>): Promise<T> {
    return runWithPerfContext(
      { runId: "run", scope: "document", stageName: "extract", pushPerformance: () => {}, pushUsage: (event) => events.push(event) },
      fn,
    );
  }

  it("caps remote stdout and stderr like local output", async () => {
    vi.stubEnv("WORKER_COMMAND_MAX_OUTPUT_BYTES", "16");
    const big = "x".repeat(64);
    const stdoutRunner = new CommandRunner({ openSession: async () => runSession(async () => ({ exitCode: 0, stdout: big, stderr: "" })) });
    await expect(stdoutRunner.run(plan)).rejects.toThrow("parser stdout exceeded 16 bytes");
    await expect(stdoutRunner.runToWritable(plan, new PassThrough())).rejects.toThrow("parser stdout exceeded 16 bytes");
    const stderrRunner = new CommandRunner({ openSession: async () => runSession(async () => ({ exitCode: 1, stdout: "", stderr: big })) });
    await expect(stderrRunner.run(plan)).rejects.toThrow("parser stderr exceeded 16 bytes");
  });

  it("reports progress while a remote command is pending, up to its time limit", async () => {
    vi.useFakeTimers();
    let finish!: (result: SandboxResult) => void;
    let started!: () => void;
    const runStarted = new Promise<void>((resolve) => (started = resolve));
    const runner = new CommandRunner({
      openSession: async () =>
        runSession(() => {
          started();
          return new Promise<SandboxResult>((resolve) => (finish = resolve));
        }),
    });
    const tracker = new ProgressTracker();
    const running = runWithProgressTracker(tracker, () => runner.run(plan));
    await runStarted;
    await vi.advanceTimersByTimeAsync(0);
    tracker.note("before");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(tracker.lastLabel).toBe("command:parser");
    expect(tracker.idleMs()).toBe(0);
    // Past the command's own limit the watchdog sees no more progress.
    await vi.advanceTimersByTimeAsync(120_000);
    tracker.note("limit");
    await vi.advanceTimersByTimeAsync(90_000);
    expect(tracker.lastLabel).toBe("limit");
    finish({ exitCode: 0, stdout: "ok", stderr: "" });
    await expect(running).resolves.toEqual({ stdout: "ok", stderr: "" });
  });

  it("records the provider's usage event once, in the stage's scope", async () => {
    const events: UsageEvent[] = [];
    const runner = new CommandRunner({ openSession: async () => runSession(async () => ({ exitCode: 0, stdout: "", stderr: "", usage })) });
    await inStage(events, () => runner.run(plan));
    expect(events).toEqual([{ ...usage, metadata: { ...usage.metadata, scope: "document", stage: "extract" } }]);
  });

  it("records the usage carried by a failed remote run", async () => {
    const events: UsageEvent[] = [];
    const runner = new CommandRunner({
      openSession: async () =>
        runSession(async () => {
          throw new SandboxRunError("modal sandbox command aborted", usage);
        }),
    });
    await expect(inStage(events, () => runner.run(plan))).rejects.toThrow("aborted");
    expect(events.map((event) => event.provider)).toEqual(["modal"]);
  });

  it("records no sandbox provider event for a local session", async () => {
    const events: UsageEvent[] = [];
    const runner = new CommandRunner({ openSession: async () => recordingSession("local", []) });
    await inStage(events, () => runner.run({ binary: process.execPath, args: ["-e", ""], available: true }));
    expect(events.some((event) => event.provider === "modal")).toBe(false);
  });
});

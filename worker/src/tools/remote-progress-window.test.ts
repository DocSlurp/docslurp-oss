import { afterEach, describe, expect, it, vi } from "vitest";

import { ProgressTracker, runWithProgressTracker } from "../lib/work-progress.js";
import type { SandboxResult } from "../sandbox/types.js";
import { CommandRunner } from "./runner.js";

// A remote command the provider queues (another command holds its VM) is healthy and waiting: the runner keeps reporting
// progress for it, and its time-limit window starts at admission, not at launch (recheck Q #4).
describe("remote command progress window", () => {
  afterEach(() => vi.useRealTimers());

  it("reports progress while queued past the time limit, then for the time limit from admission", async () => {
    vi.useFakeTimers();
    const runner = new CommandRunner({ openSession: async () => { throw new Error("unused"); } });
    let admit!: () => void;
    let finish!: (result: SandboxResult) => void;
    const started = new Promise<void>((resolve) => (admit = resolve));
    const remote = new Promise<SandboxResult>((resolve) => (finish = resolve));
    const tracker = new ProgressTracker();
    const settled = runWithProgressTracker(tracker, () =>
      runner.settleRemote({ binary: "/usr/bin/parser", args: [], available: true }, { remote, timeoutMs: 60_000, started }));

    // Queued for three time limits: still progressing, labelled as queued.
    await vi.advanceTimersByTimeAsync(180_000);
    expect(tracker.idleMs()).toBeLessThanOrEqual(30_000);
    expect(tracker.lastLabel).toBe("command-queued:parser");

    // Admitted: progress for the command's own limit, then silence (a hung command trips the watchdog).
    admit();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tracker.lastLabel).toBe("command:parser");
    expect(tracker.idleMs()).toBeLessThanOrEqual(30_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tracker.idleMs()).toBeGreaterThanOrEqual(90_000);

    finish({ stdout: "", stderr: "", exitCode: 0 });
    await expect(settled).resolves.toMatchObject({ exitCode: 0 });
  });
});

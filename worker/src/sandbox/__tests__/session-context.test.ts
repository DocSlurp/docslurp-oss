import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

import { CommandRunner } from "../../tools/runner.js";
import { runWithSandboxScope, SandboxSessionScope } from "../session-context.js";
import type { SandboxCommand, SandboxIsolation, SandboxSession } from "../types.js";

const ISOLATION: SandboxIsolation = { filesystem: false, network: "none", processes: false, location: "local" };

function recordingSession(id: string, commands: SandboxCommand[]): SandboxSession {
  return {
    providerId: id,
    isolation: ISOLATION,
    spawn: (command) => {
      commands.push(command);
      return spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(id)})`], {
        stdio: ["ignore", "pipe", "pipe"],
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

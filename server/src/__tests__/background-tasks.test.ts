import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { createBackgroundTasks, subscriptionTask } from "../services/background-tasks.js";

describe("background tasks", () => {
  it("starts in order and stops exactly what it started", async () => {
    const calls: string[] = [];
    const tasks = createBackgroundTasks([
      { name: "a", start: () => { calls.push("start a"); }, stop: () => { calls.push("stop a"); } },
      // A start that returns its own stop: that one is used, not `stop`.
      { name: "b", start: () => { calls.push("start b"); return () => { calls.push("stop b (returned)"); }; }, stop: () => { calls.push("wrong stop"); } },
      { name: "c", start: () => { calls.push("start c"); } },
    ]);
    tasks.start();
    await tasks.stop();
    expect(calls).toEqual(["start a", "start b", "start c", "stop a", "stop b (returned)"]);
    // Nothing is stopped twice, and nothing that was not started is stopped.
    await tasks.stop();
    expect(calls).toHaveLength(5);
  });

  it("keeps stopping after one stop fails, and logs the failure by task name", async () => {
    const log = vi.fn();
    const stopped = vi.fn();
    const tasks = createBackgroundTasks([
      { name: "broken", start: () => {}, stop: async () => { throw new Error("socket closed"); } },
      { name: "after", start: () => {}, stop: stopped },
    ], log);
    tasks.start();
    await expect(tasks.stop()).resolves.toBeUndefined();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("[broken] stop failed: socket closed");
  });

  it("lets the host register before start, replaces by name, and refuses a late registration", async () => {
    const first = vi.fn();
    const replacement = vi.fn();
    const tasks = createBackgroundTasks([{ name: "built-in", start: () => {} }]);
    tasks.register({ name: "host", start: first });
    tasks.register({ name: "host", start: replacement });
    expect(tasks.names()).toEqual(["built-in", "host"]);
    tasks.start();
    expect(first).not.toHaveBeenCalled();
    expect(replacement).toHaveBeenCalledTimes(1);
    // A task added now would never start: loud, not silent.
    expect(() => tasks.register({ name: "late", start: () => {} })).toThrow(/registered after the API started/);
    await tasks.stop();
    // After a stop (a dev module reload) registration is open again.
    expect(() => tasks.register({ name: "late", start: () => {} })).not.toThrow();
  });

  it("a subscription never blocks start, and stopping cancels a pending retry then unsubscribes", async () => {
    let attempts = 0;
    const unsubscribe = vi.fn(async () => {});
    const task = subscriptionTask("listener", async () => { attempts += 1; throw new Error("database down"); }, unsubscribe);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const tasks = createBackgroundTasks([task]);
      tasks.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(attempts).toBe(1);
      await tasks.stop();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      const afterStop = attempts;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(attempts).toBe(afterStop);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("maintenance sweeps", () => {
  it("runs a registered sweep with the built-in ones, replacing by name", async () => {
    vi.resetModules();
    const sweeper = await import("../services/maintenance-sweeper.js");
    const builtIn = sweeper.maintenanceSweepNames();
    expect(builtIn).toContain("stale-queued-run-sweep");
    sweeper.registerMaintenanceSweep("host-upkeep", async () => "first");
    sweeper.registerMaintenanceSweep("host-upkeep", async () => "second");
    expect(sweeper.maintenanceSweepNames()).toEqual([...builtIn, "host-upkeep"]);
  });
});

describe("the API's start and stop lists", () => {
  // server.ts used to call each start in ensureApiStartup and each stop in a second, hand-kept list.
  it("server.ts starts and stops background tasks only through the one list", () => {
    const server = readFileSync(fileURLToPath(new URL("../server.ts", import.meta.url)), "utf8");
    const list = server.slice(server.indexOf("const apiBackgroundTasks = createBackgroundTasks(["), server.indexOf("export const registerApiBackgroundTask"));
    expect(list.length).toBeGreaterThan(500);
    const outside = server.replace(list, "");
    const stray = [...outside.matchAll(/^\s*(?:await\s+)?((?:start|stop)[A-Z]\w*(?:Sweeper|Reconciler|Evaluator|Flusher|Recovery|Refresher|Listener|Watchdog|Refresh|Maintenance))\(/gm)].map((match) => match[1]);
    expect(stray).toEqual([]);
    expect(outside).toMatch(/apiBackgroundTasks\.start\(\)/);
    expect(outside).toMatch(/replaceProcessTask\("api-background-tasks", apiBackgroundTasks\.stop\)/);
  });
});

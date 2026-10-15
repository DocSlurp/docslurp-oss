import { afterEach, describe, expect, it, vi } from "vitest";

import { processSingleton, replaceProcessTask, reusesAcrossModuleReloads } from "../lib/process-singleton.js";

describe("process singletons (dev module reloads)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("reuses resources only outside production and Vitest", () => {
    expect(reusesAcrossModuleReloads({ NODE_ENV: "development" })).toBe(true);
    expect(reusesAcrossModuleReloads({ NODE_ENV: "production" })).toBe(false);
    expect(reusesAcrossModuleReloads({ NODE_ENV: "development", VITEST: "true" })).toBe(false);
  });

  it("creates a cached resource once per key in dev", () => {
    const dev = { NODE_ENV: "development" };
    const key = `test-${Math.random()}`;
    const create = vi.fn(() => ({}));
    const first = processSingleton(key, create, dev);
    expect(processSingleton(key, create, dev)).toBe(first);
    expect(create).toHaveBeenCalledTimes(1);
    expect(processSingleton(key, create, { NODE_ENV: "production" })).not.toBe(first);
  });

  it("keeps one postgres pool when db.ts is re-evaluated in dev", async () => {
    vi.stubEnv("VITEST", undefined);
    vi.stubEnv("NODE_ENV", "development");
    const { sql: first } = await import("../db.js");
    vi.resetModules();
    const { sql: second } = await import("../db.js");
    expect(second).toBe(first);
  });

  it("creates a pool per evaluation under test, so suites can end their own", async () => {
    const { sql: first } = await import("../db.js");
    vi.resetModules();
    const { sql: second } = await import("../db.js");
    expect(second).not.toBe(first);
  });

  it("hands a reloaded module the previous instance's stop function", () => {
    const key = `task-${Math.random()}`;
    const stopOld = vi.fn();
    const stopNew = vi.fn();
    expect(replaceProcessTask(key, stopOld)).toBeUndefined();
    expect(replaceProcessTask(key, stopNew)).toBe(stopOld);
    expect(replaceProcessTask(key, stopNew)).toBeUndefined();
  });
});

import { afterEach, describe, expect, it } from "vitest";

import { CommandRunner, resolveCommandRssBudgetMb, resolveContainerMemoryLimitMb } from "../tools/runner.js";

const originalBudget = process.env.WORKER_COMMAND_MAX_RSS_MB;

afterEach(() => {
  if (originalBudget === undefined) {
    delete process.env.WORKER_COMMAND_MAX_RSS_MB;
    return;
  }

  process.env.WORKER_COMMAND_MAX_RSS_MB = originalBudget;
});

describe("worker memory budgeting", () => {
  it("derives a subprocess RSS budget from the container limit", () => {
    expect(resolveCommandRssBudgetMb({ cgroupLimitMb: 4096 })).toBe(2457);
    expect(resolveCommandRssBudgetMb({ cgroupLimitMb: 8192 })).toBe(4915);
    expect(resolveCommandRssBudgetMb({ explicitMb: 1536, cgroupLimitMb: 8192 })).toBe(1536);
  });

  it("falls back to MemTotal when cgroup memory is reported as unlimited", () => {
    expect(
      resolveContainerMemoryLimitMb({
        cgroupLimitRaw: "9223372036854771712",
        meminfoRaw: "MemTotal:        4194304 kB\nMemFree:         1024 kB\n",
      })
    ).toBe(4096);
    expect(
      resolveContainerMemoryLimitMb({
        cgroupLimitRaw: "4294967296",
        meminfoRaw: "MemTotal:        8388608 kB\n",
      })
    ).toBe(4096);
    expect(resolveContainerMemoryLimitMb({ cgroupLimitRaw: "max", meminfoRaw: "MemFree: 1024 kB\n" })).toBeNull();
  });

  it("kills subprocesses that exceed the configured RSS budget", async () => {
    process.env.WORKER_COMMAND_MAX_RSS_MB = "96";
    const runner = new CommandRunner();

    await expect(
      runner.run({
        binary: "node",
        args: [
          "-e",
          [
            "const blocks = [];",
            "for (let i = 0; i < 8; i += 1) {",
            "  blocks.push(Buffer.alloc(32 * 1024 * 1024, 1));",
            "}",
            "setInterval(() => {}, 1000);"
          ].join(" ")
        ],
        available: true
      })
    ).rejects.toThrow(/subprocess RSS budget/i);
  }, 20000);
});

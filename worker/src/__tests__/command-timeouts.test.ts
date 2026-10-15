import { describe, expect, it } from "vitest";

import { HungWorkError } from "../lib/hung-work.js";
import { runWithPerfContext } from "../lib/perf-context.js";
import { resolveAiRequestTimeoutMs, resolveCommandTimeoutMs, withRequestTimeout } from "../lib/work-progress.js";
import { CommandRunner } from "../tools/runner.js";

describe("command wall-clock budgets", () => {
  it("scales with pages and stops at the hard max", () => {
    expect(resolveCommandTimeoutMs(10, {})).toBe(300_000 + 10 * 15_000);
    expect(resolveCommandTimeoutMs(5_000, {})).toBe(90 * 60_000);
    expect(resolveCommandTimeoutMs(undefined, {})).toBe(90 * 60_000);
    expect(resolveCommandTimeoutMs(4, { WORKER_COMMAND_TIMEOUT_BASE_MS: "1000", WORKER_COMMAND_TIMEOUT_PER_PAGE_MS: "500", WORKER_COMMAND_TIMEOUT_MAX_MS: "2500" })).toBe(2_500);
  });

  it("kills a hung command and fails it as hung work", async () => {
    const runner = new CommandRunner();
    const plan = { ...(await runner.plan("sleep", "30")), timeoutMs: 300 };
    const started = Date.now();
    const error = await runner.run(plan).catch((caught: unknown) => caught);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(error).toBeInstanceOf(HungWorkError);
  }, 20_000);

  it("takes the page count from the document being processed", async () => {
    const runner = new CommandRunner();
    const plan = await runner.plan("sleep", "30");
    const env = { WORKER_COMMAND_TIMEOUT_BASE_MS: "100", WORKER_COMMAND_TIMEOUT_PER_PAGE_MS: "100", WORKER_COMMAND_TIMEOUT_MAX_MS: "60000" };
    const previous = { ...process.env };
    Object.assign(process.env, env);
    try {
      const error = await runWithPerfContext(
        { runId: "r", documentId: "d", pageCount: 2, scope: "document", stageName: "extract-markdown", pushPerformance: () => {} },
        () => runner.run(plan),
      ).catch((caught: unknown) => caught);
      expect((error as Error).message).toContain("(2 pages)");
    } finally {
      for (const key of Object.keys(env)) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  }, 20_000);
});

describe("AI request timeouts", () => {
  it("defaults to 5 minutes and combines with the caller's signal", async () => {
    expect(resolveAiRequestTimeoutMs({})).toBe(300_000);
    const caller = new AbortController();
    const combined = withRequestTimeout(caller.signal, 60_000);
    caller.abort(new Error("cancelled"));
    expect(combined.aborted).toBe(true);
    const timed = withRequestTimeout(undefined, 10);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(timed.aborted).toBe(true);
    expect((timed.reason as Error).name).toBe("TimeoutError");
  });
});

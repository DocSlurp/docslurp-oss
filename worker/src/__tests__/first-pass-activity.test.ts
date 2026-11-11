import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationFailure } from "@temporalio/common";

import { firstPassFailure, withFirstPassHeartbeat } from "../temporal/activities.js";
import { RunPolicyError } from "../lib/document-failure.js";
import { FIRST_PASS_RUN_POLICY_FAILURE } from "../temporal/shared.js";

afterEach(() => { vi.useRealTimers(); });

describe("first-pass activities (council #340)", () => {
  it("M2: heartbeats on a 10 s timer while work emits no event (staging, VM boot, retries)", async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn();
    let finish!: () => void;
    const running = withFirstPassHeartbeat({ heartbeat }, { firstPass: "batch" }, () => new Promise<string>((resolve) => { finish = () => resolve("done"); }));
    expect(heartbeat).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(heartbeat).toHaveBeenCalledTimes(7);
    finish();
    await expect(running).resolves.toBe("done");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(heartbeat).toHaveBeenCalledTimes(7);
  });

  it("H1: a run-policy stop (also wrapped) becomes a final, typed failure the workflow stops the run on", () => {
    const classify = () => "ordinary" as const;
    for (const error of [new RunPolicyError("Credits do not cover"), Object.assign(new Error("wrapped"), { cause: new RunPolicyError("Credits do not cover") })]) {
      const failure = firstPassFailure(error, classify) as ApplicationFailure;
      expect(failure).toBeInstanceOf(ApplicationFailure);
      expect(failure.type).toBe(FIRST_PASS_RUN_POLICY_FAILURE);
      expect(failure.nonRetryable).toBe(true);
    }
    const other = new Error("VM capacity");
    expect((firstPassFailure(other, classify) as ApplicationFailure).type).not.toBe(FIRST_PASS_RUN_POLICY_FAILURE);
  });
});

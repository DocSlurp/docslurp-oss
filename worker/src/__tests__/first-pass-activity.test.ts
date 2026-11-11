import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationFailure } from "@temporalio/common";

import { firstPassFailure, withFirstPassHeartbeat } from "../temporal/activities.js";
import { RunPolicyError } from "../lib/document-failure.js";
import { FIRST_PASS_BATCH_FINAL_FAILURE, FIRST_PASS_RUN_POLICY_FAILURE } from "../temporal/shared.js";
import { BATCH_FINAL_PROPERTY, isFinalBatchFailure } from "../extractors/sandboxed-pdf-batch.js";

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

  it("L-A: a batch the provider failed closed (confinement unavailable, cleanup unverified, no exit status) is never retried", () => {
    const classify = () => "ordinary" as const;
    const marked = (message: string) => Object.defineProperty(new Error(message), BATCH_FINAL_PROPERTY, { value: true, enumerable: false });
    for (const error of [
      marked("Document VM guest confinement unavailable"),
      marked("Document VM guest could not verify file cleanup"),
      Object.assign(new Error("wrapped"), { cause: marked("Document VM guest exit status unverified") }),
    ]) {
      expect(isFinalBatchFailure(error)).toBe(true);
      const failure = firstPassFailure(error, classify) as ApplicationFailure;
      expect(failure).toBeInstanceOf(ApplicationFailure);
      expect(failure.type).toBe(FIRST_PASS_BATCH_FINAL_FAILURE);
      expect(failure.nonRetryable).toBe(true);
      // Fixed text only: nothing from the provider's error crosses into the failure.
      expect(failure.message).not.toContain("Document VM");
    }
    // Only an explicit `true` marks a batch final; an ordinary VM loss stays retryable.
    for (const error of [null, undefined, "text", 42]) expect(isFinalBatchFailure(error)).toBe(false);
    for (const error of [new Error("VM capacity"), Object.assign(new Error("x"), { [BATCH_FINAL_PROPERTY]: "true" })]) {
      expect(isFinalBatchFailure(error)).toBe(false);
      const failure = firstPassFailure(error, classify) as ApplicationFailure;
      expect(failure.type).not.toBe(FIRST_PASS_BATCH_FINAL_FAILURE);
      expect(failure.nonRetryable).not.toBe(true);
    }
    // Cancellation and interruption keep their own handling.
    const final = marked("Document VM guest could not verify file cleanup");
    expect((firstPassFailure(final, () => "cancelled" as const) as ApplicationFailure).type).not.toBe(FIRST_PASS_BATCH_FINAL_FAILURE);
    expect((firstPassFailure(final, () => "interruption" as const) as ApplicationFailure).type).not.toBe(FIRST_PASS_BATCH_FINAL_FAILURE);
    // A run-policy stop in the chain still stops the run.
    const policy = Object.assign(marked("x"), { cause: new RunPolicyError("Credits do not cover") });
    expect((firstPassFailure(policy, classify) as ApplicationFailure).type).toBe(FIRST_PASS_RUN_POLICY_FAILURE);
  });
});

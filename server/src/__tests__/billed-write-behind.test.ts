import { afterEach, describe, expect, it, vi } from "vitest";

import { billedWriteBehindCredits, billedWriteBehindLost, billedWriteBehindMaxCredits, billedWriteBehindPending, drainBilledWriteBehind, writeBehindWithinCap } from "../lib/billed-write-behind.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function settles(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(() => { done = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  return done;
}

afterEach(() => { vi.unstubAllEnvs(); });

describe("billed write-behind cap", () => {
  it("defaults to 10 credits ($0.10) and accepts 0", () => {
    expect(billedWriteBehindMaxCredits({})).toBe(10);
    expect(billedWriteBehindMaxCredits({ SEARCH_WRITE_BEHIND_MAX_CREDITS: "0" })).toBe(0);
    expect(billedWriteBehindMaxCredits({ SEARCH_WRITE_BEHIND_MAX_CREDITS: "-3" })).toBe(10);
    expect(billedWriteBehindMaxCredits({ SEARCH_WRITE_BEHIND_MAX_CREDITS: "nope" })).toBe(10);
  });

  it("answers before writes within the cap and waits once it would pass it", async () => {
    vi.stubEnv("SEARCH_WRITE_BEHIND_MAX_CREDITS", "5");
    const first = gate();
    const second = gate();
    expect(await settles(writeBehindWithinCap(3, () => first.promise).done)).toBe(true);
    expect(billedWriteBehindCredits()).toBe(3);
    // 3 + 3 > 5: this request waits for its own write.
    const waiting = writeBehindWithinCap(3, () => second.promise).done;
    expect(await settles(waiting)).toBe(false);
    second.release();
    await waiting;
    first.release();
    await drainBilledWriteBehind();
    expect(billedWriteBehindCredits()).toBe(0);
    expect(billedWriteBehindPending()).toBe(0);
  });

  it("keeps a failed write's credits held and retries it with the same write until it commits", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const errors: number[] = [];
      const result = writeBehindWithinCap(4, async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("insert failed");
      }, { onError: (_error, attempt) => errors.push(attempt) });
      await expect(result.done).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      expect(billedWriteBehindCredits()).toBe(4);
      await vi.advanceTimersByTimeAsync(250);
      expect(attempts).toBe(2);
      expect(billedWriteBehindCredits()).toBe(4);
      await vi.advanceTimersByTimeAsync(1_000);
      await result.settled;
      expect(attempts).toBe(3);
      expect(errors).toEqual([0, 1]);
      expect(billedWriteBehindCredits()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never recycles the allowance through failures: past the cap requests write inline", async () => {
    vi.stubEnv("SEARCH_WRITE_BEHIND_MAX_CREDITS", "10");
    let inlineAttempts = 0;
    let deferred = 0;
    for (let i = 0; i < 100; i += 1) {
      const before = billedWriteBehindCredits();
      const { done } = writeBehindWithinCap(1, async () => {
        if (before >= 10) inlineAttempts += 1;
        throw new Error("database down");
      });
      if (billedWriteBehindCredits() > before) deferred += 1;
      await done;
    }
    // Ten failed charges hold the whole allowance; the other 90 waited for their own (failed) write.
    expect(deferred).toBe(10);
    expect(billedWriteBehindCredits()).toBe(10);
    expect(inlineAttempts).toBe(90);
    await drainBilledWriteBehind();
    expect(billedWriteBehindCredits()).toBe(0);
    expect(billedWriteBehindPending()).toBe(0);
  });

  it("shutdown drain retries without waiting for the backoff", async () => {
    let attempts = 0;
    writeBehindWithinCap(2, async () => { attempts += 1; if (attempts < 2) throw new Error("once"); });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const started = Date.now();
    await drainBilledWriteBehind();
    expect(Date.now() - started).toBeLessThan(200);
    expect(attempts).toBe(2);
    expect(billedWriteBehindCredits()).toBe(0);
  });

  it("writes before answering when the cap is 0", async () => {
    vi.stubEnv("SEARCH_WRITE_BEHIND_MAX_CREDITS", "0");
    const write = gate();
    const result = writeBehindWithinCap(1, () => write.promise).done;
    expect(await settles(result)).toBe(false);
    write.release();
    await result;
  });

  it("gives up at once on integrity errors and releases the credits", async () => {
    const lost = billedWriteBehindLost();
    let attempts = 0;
    const result = writeBehindWithinCap(3, async () => {
      attempts += 1;
      throw Object.assign(new Error("insert violates foreign key constraint"), { code: "23503" });
    });
    await result.settled;
    expect(attempts).toBe(1);
    expect(billedWriteBehindLost()).toBe(lost + 1);
    expect(billedWriteBehindCredits()).toBe(0);
  });

  it("never defers with a cap of 0, even a zero-credit write", async () => {
    vi.stubEnv("SEARCH_WRITE_BEHIND_MAX_CREDITS", "0");
    const write = gate();
    const result = writeBehindWithinCap(0, () => write.promise).done;
    expect(await settles(result)).toBe(false);
    write.release();
    await result;
  });

  it("bounds zero-credit writes by SEARCH_WRITE_BEHIND_MAX_PENDING", async () => {
    vi.stubEnv("SEARCH_WRITE_BEHIND_MAX_PENDING", "3");
    const write = gate();
    const deferred = Array.from({ length: 3 }, () => writeBehindWithinCap(0, () => write.promise).done);
    for (const done of deferred) expect(await settles(done)).toBe(true);
    expect(billedWriteBehindPending()).toBe(3);
    const fourth = writeBehindWithinCap(0, () => write.promise).done;
    expect(await settles(fourth)).toBe(false);
    write.release();
    await fourth;
    await drainBilledWriteBehind();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import { billedWriteBehindCredits, billedWriteBehindMaxCredits, billedWriteBehindPending, drainBilledWriteBehind, writeBehindWithinCap } from "../lib/billed-write-behind.js";

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

  it("releases the credits of a failed write and never rejects", async () => {
    const result = writeBehindWithinCap(4, async () => { throw new Error("insert failed"); });
    await expect(result.done).resolves.toBeUndefined();
    await expect(result.settled).resolves.toBeUndefined();
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
});

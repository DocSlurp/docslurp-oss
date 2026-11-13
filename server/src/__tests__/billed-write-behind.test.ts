import { afterEach, describe, expect, it, vi } from "vitest";

import { billedWriteBehindCredits, billedWriteBehindLost, billedWriteBehindMaxCredits, billedWriteBehindPending, drainBilledWriteBehind, resetBilledWriteBehindForTests, writeBehindWithinCap } from "../lib/billed-write-behind.js";

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

const ORG = { orgId: "org-a" };

afterEach(() => { vi.unstubAllEnvs(); resetBilledWriteBehindForTests(); });

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
    expect(await settles(writeBehindWithinCap(3, () => first.promise, ORG).done)).toBe(true);
    expect(billedWriteBehindCredits()).toBe(3);
    // 3 + 3 > 5: this request waits for its own write.
    const waiting = writeBehindWithinCap(3, () => second.promise, ORG).done;
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
      }, { ...ORG, onError: (_error, attempt) => errors.push(attempt) });
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
      }, ORG);
      if (billedWriteBehindCredits() > before) deferred += 1;
      await done;
    }
    // Ten failed charges hold the whole allowance; the other 90 waited for their own (failed) write.
    expect(deferred).toBe(10);
    expect(billedWriteBehindCredits()).toBe(10);
    expect(inlineAttempts).toBe(90);
    await drainBilledWriteBehind();
    // Abandoned at shutdown: their credits stay held as loss debt, so the allowance never reopens.
    expect(billedWriteBehindPending()).toBe(0);
    expect(billedWriteBehindCredits()).toBe(10);
    const later = gate();
    const next = writeBehindWithinCap(1, () => later.promise, ORG).done;
    expect(await settles(next)).toBe(false);
    later.release();
    await next;
  });

  it("shutdown drain retries without waiting for the backoff", async () => {
    let attempts = 0;
    writeBehindWithinCap(2, async () => { attempts += 1; if (attempts < 2) throw new Error("once"); }, ORG);
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
    const result = writeBehindWithinCap(1, () => write.promise, ORG).done;
    expect(await settles(result)).toBe(false);
    write.release();
    await result;
  });

  it("gives up at once on integrity errors and keeps their credits held as loss debt", async () => {
    const lost = billedWriteBehindLost();
    let attempts = 0;
    const result = writeBehindWithinCap(3, async () => {
      attempts += 1;
      throw Object.assign(new Error("insert violates foreign key constraint"), { code: "23503" });
    }, ORG);
    await result.settled;
    expect(attempts).toBe(1);
    expect(billedWriteBehindLost()).toBe(lost + 1);
    expect(billedWriteBehindCredits()).toBe(3);
  });

  it("never defers with a cap of 0, even a zero-credit write", async () => {
    vi.stubEnv("SEARCH_WRITE_BEHIND_MAX_CREDITS", "0");
    const write = gate();
    const result = writeBehindWithinCap(0, () => write.promise, ORG).done;
    expect(await settles(result)).toBe(false);
    write.release();
    await result;
  });

  it("bounds zero-credit writes by SEARCH_WRITE_BEHIND_MAX_PENDING", async () => {
    vi.stubEnv("SEARCH_WRITE_BEHIND_MAX_PENDING", "3");
    const write = gate();
    const deferred = Array.from({ length: 3 }, () => writeBehindWithinCap(0, () => write.promise, ORG).done);
    for (const done of deferred) expect(await settles(done)).toBe(true);
    expect(billedWriteBehindPending()).toBe(3);
    const fourth = writeBehindWithinCap(0, () => write.promise, ORG).done;
    expect(await settles(fourth)).toBe(false);
    write.release();
    await fourth;
    await drainBilledWriteBehind();
  });

  it("keeps each org's allowance separate: one org's unwritten or lost charges never make another org wait", async () => {
    vi.stubEnv("SEARCH_WRITE_BEHIND_MAX_CREDITS", "5");
    // org-a fills its allowance with abandoned (lost) charges.
    for (let i = 0; i < 5; i += 1) {
      await writeBehindWithinCap(1, async () => { throw Object.assign(new Error("fk"), { code: "23503" }); }, ORG).settled;
    }
    expect(billedWriteBehindCredits("org-a")).toBe(5);
    const blockedA = gate();
    const a = writeBehindWithinCap(1, () => blockedA.promise, ORG).done;
    expect(await settles(a)).toBe(false);
    // org-b still has its whole allowance.
    const slowB = gate();
    expect(await settles(writeBehindWithinCap(5, () => slowB.promise, { orgId: "org-b" }).done)).toBe(true);
    expect(billedWriteBehindCredits("org-b")).toBe(5);
    blockedA.release();
    slowB.release();
    await a;
    await drainBilledWriteBehind();
    expect(billedWriteBehindCredits("org-b")).toBe(0);
    expect(billedWriteBehindCredits("org-a")).toBe(5);
  });

  it("counts pending writes per org, with a process-wide memory bound", async () => {
    vi.stubEnv("SEARCH_WRITE_BEHIND_MAX_PENDING", "2");
    vi.stubEnv("SEARCH_WRITE_BEHIND_MAX_PENDING_TOTAL", "3");
    const write = gate();
    for (let i = 0; i < 2; i += 1) expect(await settles(writeBehindWithinCap(0, () => write.promise, ORG).done)).toBe(true);
    expect(await settles(writeBehindWithinCap(0, () => write.promise, ORG).done)).toBe(false);
    expect(await settles(writeBehindWithinCap(0, () => write.promise, { orgId: "org-b" }).done)).toBe(true);
    // Three deferred in the process: the memory bound now makes every org write first.
    expect(await settles(writeBehindWithinCap(0, () => write.promise, { orgId: "org-c" }).done)).toBe(false);
    write.release();
    await drainBilledWriteBehind();
  });

  it("never defers a write without an org", async () => {
    const write = gate();
    for (const orgId of [null, undefined, " "]) {
      const done = writeBehindWithinCap(1, () => write.promise, { orgId }).done;
      expect(await settles(done)).toBe(false);
    }
    expect(billedWriteBehindCredits()).toBe(0);
    write.release();
  });
});

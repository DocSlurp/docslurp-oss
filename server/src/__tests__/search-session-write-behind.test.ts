import { beforeEach, describe, expect, it, vi } from "vitest";

const reported = vi.hoisted(() => [] as Array<{ operation?: string }>);
vi.mock("../db.js", () => ({ sql: vi.fn() }));
vi.mock("../lib/public-errors.js", () => ({
  reportPublicError: (_error: unknown, context: { operation?: string }) => { reported.push(context); },
}));

const { createSearchSessionJournal, drainSearchSessionWrites, searchSessionWriteBacklog } = await import("../search/session.js");

beforeEach(() => { reported.length = 0; });

describe("write-behind search session writes", () => {
  it("retries a failed write once before reporting it", async () => {
    const journal = createSearchSessionJournal({ writeBehind: true });
    let attempts = 0;
    await journal.afterWrites(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("connection reset");
    });
    await drainSearchSessionWrites();
    expect(attempts).toBe(2);
    expect(reported).toEqual([]);
  });

  it("reports a write that fails twice, without throwing at the search", async () => {
    const journal = createSearchSessionJournal({ writeBehind: true });
    let attempts = 0;
    await expect(journal.afterWrites(async () => { attempts += 1; throw new Error("down"); })).resolves.toBeUndefined();
    await drainSearchSessionWrites();
    expect(attempts).toBe(2);
    expect(reported).toEqual([expect.objectContaining({ operation: "search-write-behind:after-writes" })]);
  });

  it("keeps one session's writes in order", async () => {
    const order: string[] = [];
    const journal = createSearchSessionJournal({ writeBehind: true });
    await journal.afterWrites(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); order.push("first"); });
    await journal.afterWrites(async () => { order.push("second"); });
    await drainSearchSessionWrites();
    expect(order).toEqual(["first", "second"]);
  });

  it("makes a search wait for its own write once the backlog is full", async () => {
    vi.stubEnv("SEARCH_WRITE_BEHIND_CONCURRENCY", "1");
    vi.stubEnv("SEARCH_WRITE_BEHIND_MAX_PENDING", "1");
    try {
      let release!: () => void;
      await createSearchSessionJournal({ writeBehind: true }).afterWrites(() => new Promise<void>((resolve) => { release = resolve; }));
      await createSearchSessionJournal({ writeBehind: true }).afterWrites(async () => {});
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(searchSessionWriteBacklog()).toEqual({ active: 1, queued: 1 });
      let returned = false;
      const third = createSearchSessionJournal({ writeBehind: true }).afterWrites(async () => {}).then(() => { returned = true; });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(returned).toBe(false);
      release();
      await third;
      expect(returned).toBe(true);
      await drainSearchSessionWrites();
      expect(searchSessionWriteBacklog()).toEqual({ active: 0, queued: 0 });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

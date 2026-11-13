import { beforeEach, describe, expect, it, vi } from "vitest";

const reported = vi.hoisted(() => [] as Array<{ operation?: string }>);
vi.mock("../db.js", () => ({ sql: vi.fn() }));
vi.mock("../lib/public-errors.js", () => ({
  reportPublicError: (_error: unknown, context: { operation?: string }) => { reported.push(context); },
}));

const { createSearchSessionJournal, drainSearchSessionWrites, searchSessionWriteBacklog } = await import("../search/session.js");
const { sql } = await import("../db.js");
const { billedWriteBehindCredits } = await import("../lib/billed-write-behind.js");
const { BILLABLE_UNIT_METRICS, unitChargeMetadata } = await import("@docslurp/shared");
const turns = await import("../lib/chat-turn-context.js");

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

  it("is waited for by a failing chat turn before it refunds (#90)", async () => {
    const turn = turns.createChatTurnContext({ refundOnFailure: true });
    let committed = false;
    await turns.runInChatTurnContext(turn, () => createSearchSessionJournal({ writeBehind: true })
      .afterWrites(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); committed = true; }));
    // The search answered before the write; the turn still counts it in flight.
    expect(committed).toBe(false);
    await turns.settleChatTurnWrites(turn);
    expect(committed).toBe(true);
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

describe("write-behind search usage", () => {
  /** Every usage insert waits for `release`, so a test can see whether the search waited for it. */
  function gateInserts() {
    let release!: () => void;
    const gate = new Promise<unknown[]>((resolve) => { release = () => resolve([{ id: "event" }]); });
    let inserts = 0;
    (sql as unknown as { mockImplementation(fn: () => unknown): void }).mockImplementation(() => { inserts += 1; return gate; });
    return { release, inserts: () => inserts };
  }

  function journalWithCost(costCents: number) {
    const journal = createSearchSessionJournal({ writeBehind: true, scope: { orgId: "org-a", projectId: "project-a" } });
    // A billed unit event keeps its credits; AI token events are priced at 0 credits.
    journal.record({ provider: "docslurp", model: "search", metric: BILLABLE_UNIT_METRICS.search, amount: 1, unit: "search",
      costCents, metadata: unitChargeMetadata() });
    return journal;
  }

  async function settles(promise: Promise<unknown>): Promise<boolean> {
    let done = false;
    void promise.then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    return done;
  }

  it("answers before a usage insert under the cap commits, and shutdown drains it", async () => {
    const gate = gateInserts();
    expect(await settles(journalWithCost(2).flushUsage("user-a"))).toBe(true);
    expect(gate.inserts()).toBeGreaterThan(0);
    expect(billedWriteBehindCredits()).toBe(2);
    const drained = drainSearchSessionWrites();
    expect(await settles(drained)).toBe(false);
    gate.release();
    await drained;
    expect(billedWriteBehindCredits()).toBe(0);
  });

  it("waits for the usage insert once unwritten usage would pass the cap", async () => {
    vi.stubEnv("SEARCH_WRITE_BEHIND_MAX_CREDITS", "5");
    try {
      const gate = gateInserts();
      expect(await settles(journalWithCost(4).flushUsage("user-a"))).toBe(true);
      // 4 + 4 > 5: this search waits for its own insert.
      const second = journalWithCost(4).flushUsage("user-a");
      expect(await settles(second)).toBe(false);
      gate.release();
      await second;
      await drainSearchSessionWrites();
      expect(billedWriteBehindCredits()).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("commits all usage before the response when the cap is 0", async () => {
    vi.stubEnv("SEARCH_WRITE_BEHIND_MAX_CREDITS", "0");
    try {
      const gate = gateInserts();
      const flushed = journalWithCost(1).flushUsage("user-a");
      expect(await settles(flushed)).toBe(false);
      gate.release();
      await flushed;
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("is waited for by a failing chat turn before it refunds (#90)", async () => {
    const gate = gateInserts();
    const turn = turns.createChatTurnContext({ refundOnFailure: true });
    await turns.runInChatTurnContext(turn, () => journalWithCost(1).flushUsage("user-a"));
    const settled = turns.settleChatTurnWrites(turn);
    expect(await settles(settled)).toBe(false);
    gate.release();
    await settled;
    await drainSearchSessionWrites();
  });
});

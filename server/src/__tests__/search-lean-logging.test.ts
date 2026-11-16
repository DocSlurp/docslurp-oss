import { searchCredits } from "@docslurp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({ apiKeyId: null as string | null, orgId: null as string | null, chatTurn: null as unknown }));
const charges = vi.hoisted(() => ({ calls: [] as Array<Record<string, any>>, usage: [] as Array<Record<string, any>>, failNext: 0 }));

vi.mock("../lib/request-context.js", async (original) => ({
  ...await original<typeof import("../lib/request-context.js")>(),
  currentRequestApiKeyId: () => context.apiKeyId,
  currentRequestOrgId: () => context.orgId,
}));
vi.mock("../lib/chat-turn-context.js", async (original) => ({
  ...await original<typeof import("../lib/chat-turn-context.js")>(),
  currentChatTurn: () => context.chatTurn,
}));
vi.mock("../lib/ai-usage.js", async (original) => ({
  ...await original<typeof import("../lib/ai-usage.js")>(),
  recordUnitCharge: vi.fn(async (args: Record<string, any>) => {
    charges.calls.push(args);
    if (charges.failNext > 0) { charges.failNext -= 1; throw new Error("connection reset"); }
    return {};
  }),
  persistUsageEvent: vi.fn(async (args: Record<string, any>) => {
    charges.usage.push(args);
    return args.event;
  }),
}));

const lean = await import("../search/lean-logging.js");
const { createUsageLedger } = await vi.importActual<typeof import("../lib/ai-usage.js")>("../lib/ai-usage.js");

beforeEach(() => {
  context.apiKeyId = "key1";
  context.orgId = null;
  context.chatTurn = null;
  charges.calls = [];
  charges.usage = [];
  charges.failNext = 0;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  charges.failNext = 0;
  await lean.flushSearchCharges();
  lean.resetSearchChargeDrainForTests();
});

describe("lean search logging", () => {
  it("applies to API-key keyword and hybrid searches only", () => {
    expect(lean.leanSearchLogging("keyword")).toBe(true);
    expect(lean.leanSearchLogging("hybrid")).toBe(true);
    expect(lean.leanSearchLogging("deep")).toBe(false);
    expect(lean.leanSearchLogging(undefined)).toBe(false);
    context.apiKeyId = null; // a dashboard session
    expect(lean.leanSearchLogging("keyword")).toBe(false);
    context.apiKeyId = "key1";
    context.chatTurn = { id: "turn" }; // searches a chat answer runs
    expect(lean.leanSearchLogging("keyword")).toBe(false);
    context.chatTurn = null;
    expect(lean.leanSearchLogging("keyword", { SEARCH_API_LEAN_LOGGING: "0" })).toBe(false);
  });

  it("keeps keyword history 7 days without result rows, hybrid 30 days with them", () => {
    expect(lean.apiSearchHistoryRetentionDays("hybrid", {})).toBe(30);
    expect(lean.apiSearchHistoryRetentionDays("keyword", {})).toBe(7);
    expect(lean.apiSearchHistoryRetentionDays("hybrid", { SEARCH_API_HISTORY_RETENTION_DAYS: "14" })).toBe(14);
    expect(lean.apiSearchHistoryRetentionDays("keyword", { SEARCH_API_KEYWORD_HISTORY_RETENTION_DAYS: "2" })).toBe(2);
    expect(lean.apiSearchHistoryRetentionDays("hybrid", { SEARCH_API_HISTORY_RETENTION_DAYS: "0" })).toBe(30);
    expect(lean.apiSearchHistoryRetentionDays("keyword", { SEARCH_API_KEYWORD_HISTORY_RETENTION_DAYS: "junk" })).toBe(7);
    expect(lean.leanSearchHistory("keyword")).toEqual({ expiresInDays: 7, resultRows: false });
    expect(lean.leanSearchHistory("hybrid")).toEqual({ expiresInDays: 30, resultRows: true });
    expect(lean.leanSearchHistory("deep")).toBeNull();
    context.apiKeyId = null;
    expect(lean.leanSearchHistory("keyword")).toBeNull();
  });

  it("counts every query of a keyword fan-out as a search", async () => {
    lean.enqueueSearchCharge({ userId: "u", orgId: "o", projectId: "p", mode: "keyword" }, 40);
    lean.enqueueSearchCharge({ userId: "u", orgId: "o", projectId: "p", mode: "keyword" });
    expect(lean.pendingSearchCharges()).toBe(41);
    await lean.flushSearchCharges();
    expect(charges.calls.map((call) => call.charge.amount)).toEqual([41]);
  });

  it("writes one charge per key, project and mode, scoped to that key", async () => {
    for (let i = 0; i < 5; i += 1) lean.enqueueSearchCharge({ userId: "u", orgId: "o", projectId: "p", mode: "keyword" });
    lean.enqueueSearchCharge({ userId: "u", orgId: "o", projectId: "p", mode: "hybrid" });
    lean.enqueueSearchCharge({ userId: "u", orgId: "o", projectId: "p2", mode: "keyword" });
    context.apiKeyId = "key2";
    lean.enqueueSearchCharge({ userId: "u", orgId: "o", projectId: "p", mode: "keyword" });
    expect(lean.pendingSearchCharges()).toBe(8);
    await lean.flushSearchCharges();
    expect(lean.pendingSearchCharges()).toBe(0);
    const summary = charges.calls.map((call) => [call.scope.apiKeyId, call.scope.projectId, call.charge.metadata.searchMode, call.charge.amount]).sort();
    expect(summary).toEqual([["key1", "p", "hybrid", 1], ["key1", "p", "keyword", 5], ["key1", "p2", "keyword", 1], ["key2", "p", "keyword", 1]]);
    const five = charges.calls.find((call) => call.charge.amount === 5)!;
    expect(five.charge).toMatchObject({ unit: "search", credits: searchCredits(5, { mode: "keyword" }) });
    expect(five.charge.metadata).toMatchObject({ batched: true, llmStrategies: false });
    expect(new Set(charges.calls.map((call) => call.charge.id)).size).toBe(4);
  });

  it("refuses a batched charge without an API key", () => {
    context.apiKeyId = null;
    expect(() => lean.enqueueSearchCharge({ userId: "u", orgId: "o", projectId: "p", mode: "keyword" })).toThrow(/API key/);
  });

  it("retries a failed batch with the same id, so the idempotent insert cannot bill twice", async () => {
    lean.enqueueSearchCharge({ userId: "u", orgId: "o", projectId: "p", mode: "keyword" });
    lean.enqueueSearchCharge({ userId: "u", orgId: "o", projectId: "p", mode: "keyword" });
    charges.failNext = 1;
    await lean.flushSearchCharges();
    expect(lean.pendingSearchCharges()).toBe(2);
    // New searches after the failure go to a new batch, never into the failed one.
    lean.enqueueSearchCharge({ userId: "u", orgId: "o", projectId: "p", mode: "keyword" });
    await lean.flushSearchCharges();
    expect(lean.pendingSearchCharges()).toBe(0);
    const [failed, retried, next] = charges.calls;
    expect(retried!.charge.id).toBe(failed!.charge.id);
    expect(retried!.charge.amount).toBe(2);
    expect(next!.charge.id).not.toBe(failed!.charge.id);
    expect(next!.charge.amount).toBe(1);
  });

  it("sums non-billable search usage per key and model, keeping every call's tokens", async () => {
    const embed = (tokens: number) => ({ provider: "openrouter", model: "embed-small", metric: "embed-query", amount: tokens, unit: "tokens", inputTokens: tokens, outputTokens: 0, costCents: tokens / 1e6, metadata: { billable: false } });
    lean.enqueueSearchUsage({ userId: "u", orgId: "o", projectId: "p" }, [embed(10), embed(14)]);
    lean.enqueueSearchUsage({ userId: "u", orgId: "o", projectId: "p" }, [{ ...embed(5), model: "embed-large" }]);
    expect(lean.pendingSearchUsageCalls()).toBe(3);
    await lean.flushSearchCharges();
    const rows = charges.usage.map((call) => [call.scope.apiKeyId, call.event.model, call.event.inputTokens, call.event.metadata.calls, call.event.metadata.billable]).sort();
    expect(rows).toEqual([["key1", "embed-large", 5, 1, false], ["key1", "embed-small", 24, 2, false]]);
    expect(charges.usage.every((call) => String(call.event.id).startsWith("search-usage-batch:"))).toBe(true);
  });

  it("never batches billable usage", () => {
    expect(() => lean.enqueueSearchUsage({ userId: "u", orgId: "o", projectId: "p" }, [{ provider: "x", model: "m", metric: "llm", amount: 1, unit: "tokens", inputTokens: 1, outputTokens: 1, costCents: 1, metadata: {} }]))
      .toThrow(/non-billable/);
  });

  it("a diverted ledger event stays visible but is never flushed by the ledger", async () => {
    const ledger = createUsageLedger({ userId: "u" });
    ledger.record({ provider: "openrouter", model: "embed-small", metric: "embed-query", inputTokens: 8 });
    ledger.record({ provider: "openrouter", model: "chat", metric: "rewrite", inputTokens: 8, outputTokens: 4 });
    const taken = ledger.divert((event) => event.metric === "embed-query");
    expect(taken.map((event) => event.metric)).toEqual(["embed-query"]);
    expect(ledger.divert((event) => event.metric === "embed-query")).toEqual([]);
    expect(ledger.events().map((event) => event.metric)).toEqual(["embed-query", "rewrite"]);
    // A recording client: each top-level insert is one tagged-template call whose text names usage_events.
    const inserts: string[] = [];
    const client = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("").includes("insert into usage_events")) inserts.push(String(values.find((value) => value === "embed-query" || value === "rewrite")));
      return Promise.resolve([]);
    }) as never;
    const batch = await ledger.flushWithin(client, { scope: { orgId: "o", projectId: "p" } });
    expect(inserts).toEqual(["rewrite"]);
    expect(batch.events.map((event) => event.metric)).toEqual(["rewrite"]);
  });

  it("fixes the organization when the search is queued, from the request", async () => {
    context.orgId = "org-of-project";
    lean.enqueueSearchCharge({ userId: "u", orgId: null, projectId: "p", mode: "keyword" });
    lean.enqueueSearchUsage({ userId: "u", orgId: null, projectId: "p" }, [{ provider: "o", model: "e", metric: "embed-query", amount: 1, unit: "tokens", inputTokens: 1, outputTokens: 0, costCents: 0, metadata: { billable: false } }]);
    context.orgId = null; // the flush runs outside the request
    await lean.flushSearchCharges();
    expect(charges.calls[0]!.scope.orgId).toBe("org-of-project");
    expect(charges.usage[0]!.scope.orgId).toBe("org-of-project");
    expect(charges.calls[0]!.charge.metadata.firstSearchAt).toMatch(/^\d{4}-/);
  });

  it("sums provider cost and keeps no per-call ids on a usage batch", async () => {
    const call = (cost: number, traceId: string) => ({ provider: "o", model: "e", metric: "embed-query", amount: 4, unit: "tokens", inputTokens: 4, outputTokens: 0, costCents: 0,
      metadata: { billable: false, providerCostCents: cost, traceId, spanId: traceId, providerRequestId: traceId, costSource: "catalog" } });
    lean.enqueueSearchUsage({ userId: "u", orgId: "o", projectId: "p" }, [call(0.002, "t1"), call(0.003, "t2")]);
    await lean.flushSearchCharges();
    const metadata = charges.usage[0]!.event.metadata;
    expect(metadata.providerCostCents).toBeCloseTo(0.005);
    expect(metadata).toMatchObject({ billable: false, batched: true, calls: 2, costSource: "catalog" });
    expect(metadata).not.toHaveProperty("traceId");
    expect(metadata).not.toHaveProperty("spanId");
    expect(metadata).not.toHaveProperty("providerRequestId");
  });

  it("writes a batch at once when it reaches 200 searches", async () => {
    for (let i = 0; i < 200; i += 1) lean.enqueueSearchCharge({ userId: "u", orgId: "o", projectId: "p", mode: "keyword" });
    await vi.waitFor(() => expect(charges.calls.map((call) => call.charge.amount)).toEqual([200]));
  });

  it("on shutdown writes searches that finish during the drain and reports what it could not write", async () => {
    lean.enqueueSearchCharge({ userId: "u", orgId: "o", projectId: "p", mode: "keyword" });
    const drained = lean.drainSearchCharges(2_000);
    // A search that finishes after the drain started is written at once, not left for a timer that never fires.
    lean.enqueueSearchCharge({ userId: "u", orgId: "o", projectId: "p", mode: "hybrid" });
    expect(await drained).toBe(0);
    expect(charges.calls.map((call) => [call.charge.metadata.searchMode, call.charge.amount]).sort()).toEqual([["hybrid", 1], ["keyword", 1]]);
    lean.resetSearchChargeDrainForTests();
    charges.failNext = 100;
    lean.enqueueSearchCharge({ userId: "u", orgId: "o", projectId: "p", mode: "keyword" });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await lean.drainSearchCharges(300)).toBe(1);
    expect(errors.mock.calls.some(([line]) => String(line).includes("shutdown: 1 searches"))).toBe(true);
    errors.mockRestore();
    charges.failNext = 0;
  });
});

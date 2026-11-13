import { searchCredits } from "@docslurp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({ apiKeyId: null as string | null, chatTurn: null as unknown }));
const charges = vi.hoisted(() => ({ calls: [] as Array<Record<string, any>>, failNext: 0 }));

vi.mock("../lib/request-context.js", async (original) => ({
  ...await original<typeof import("../lib/request-context.js")>(),
  currentRequestApiKeyId: () => context.apiKeyId,
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
}));

const lean = await import("../search/lean-logging.js");

beforeEach(() => {
  context.apiKeyId = "key1";
  context.chatTurn = null;
  charges.calls = [];
  charges.failNext = 0;
});
afterEach(async () => {
  vi.unstubAllEnvs();
  charges.failNext = 0;
  await lean.flushSearchCharges();
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

  it("reads the history retention, defaulting to 30 days", () => {
    expect(lean.apiSearchHistoryRetentionDays({})).toBe(30);
    expect(lean.apiSearchHistoryRetentionDays({ SEARCH_API_HISTORY_RETENTION_DAYS: "7" })).toBe(7);
    expect(lean.apiSearchHistoryRetentionDays({ SEARCH_API_HISTORY_RETENTION_DAYS: "0" })).toBe(30);
    expect(lean.apiSearchHistoryRetentionDays({ SEARCH_API_HISTORY_RETENTION_DAYS: "junk" })).toBe(30);
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
});

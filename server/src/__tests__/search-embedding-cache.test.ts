import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const embedConfiguredText = vi.hoisted(() => vi.fn());
vi.mock("../lib/ai.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ai.js")>()),
  embedConfiguredText,
}));
vi.mock("../db.js", () => ({ sql: vi.fn() }));
vi.mock("../services/organizations.js", () => ({ getWorkspaceAccess: vi.fn() }));

import { defaultEmbeddingConfig } from "@docslurp/shared";
import { createEmbeddingCache, embeddingCacheKey, normalizeEmbeddingQuery, resetEmbeddingCacheForTests, type EmbeddingCacheIdentity } from "../search/embedding-cache.js";
import { embeddingCacheBypassReason, prepareSearchSessionRetrievalPlan } from "../search/session-planner.js";
import { collectSearchTimings } from "../search/timings.js";
import { TtlLruCache } from "../search/ttl-lru.js";

const identity: EmbeddingCacheIdentity = {
  orgId: "org-a", provider: "openrouter", runtime: "remote", model: "m", baseUrl: "https://x",
  dimensions: 1024, requestedDimensions: null, normalize: true,
};

describe("embedding cache keys", () => {
  it("collapses whitespace but keeps case", () => {
    expect(normalizeEmbeddingQuery("  a \n  b\t")).toBe("a b");
    expect(embeddingCacheKey(identity, " Hello   world ")).toBe(embeddingCacheKey(identity, "Hello world"));
    expect(embeddingCacheKey(identity, "Hello")).not.toBe(embeddingCacheKey(identity, "hello"));
  });

  it("isolates org, provider, model, dimensions, endpoint and normalization", () => {
    const base = embeddingCacheKey(identity, "q");
    for (const change of [
      { orgId: "org-b" }, { provider: "deepinfra" }, { model: "m2" }, { dimensions: 512 },
      { requestedDimensions: 512 }, { baseUrl: "https://y" }, { normalize: false }, { runtime: "local" },
    ]) expect(embeddingCacheKey({ ...identity, ...change }, "q")).not.toBe(base);
  });

  it("stores no readable query text in keys", () => {
    expect(embeddingCacheKey(identity, "secret merger")).not.toContain("secret");
  });
});

describe("TtlLruCache", () => {
  it("expires entries after the TTL", () => {
    let now = 0;
    const cache = new TtlLruCache<number>(10, 1000, () => now);
    cache.set("a", 1);
    now = 999;
    expect(cache.get("a")).toBe(1);
    now = 1000;
    expect(cache.get("a")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("evicts the least recently used entry", () => {
    const cache = new TtlLruCache<number>(2, 1000);
    cache.set("a", 1); cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("is disabled by zero entries or zero TTL", () => {
    const off = createEmbeddingCache({ SEARCH_EMBEDDING_CACHE_MAX_ENTRIES: "0" } as NodeJS.ProcessEnv);
    off.set("a", [1]);
    expect(off.enabled).toBe(false);
    expect(off.get("a")).toBeUndefined();
    expect(createEmbeddingCache({ SEARCH_EMBEDDING_CACHE_TTL_SECONDS: "0" } as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(createEmbeddingCache({} as NodeJS.ProcessEnv).enabled).toBe(true);
    expect(createEmbeddingCache({ SEARCH_EMBEDDING_CACHE_MAX_ENTRIES: "junk" } as NodeJS.ProcessEnv).enabled).toBe(true);
  });
});

describe("query embedding through the search planner", () => {
  const records: Array<Record<string, unknown>> = [];
  const session = {
    record: (input: Record<string, unknown>) => { records.push(input); },
    recordDiagnostic: vi.fn(),
    adoptUsage: vi.fn(), usageEvents: () => [], diagnostics: () => ({}), persist: vi.fn(), flushUsage: vi.fn(), sessionId: "s",
  };
  const embedding = defaultEmbeddingConfig;

  function plan(query: string, orgId = "org-a", privacyMode: "standard" | "local-only" | "strict-privacy" = "standard") {
    // The planner starts the embedding without awaiting it; the vector leg awaits it. Settle it here.
    return collectSearchTimings(async () => {
      const planned = await prepareSearchSessionRetrievalPlan({
        query, userId: "u", options: {} as never, effectiveOptions: {} as never, workspaceId: "ws", orgId,
        workspaceSettings: {}, embedding, privacyMode, session: session as never,
      });
      return { ...planned, queryVector: await planned.queryVector };
    });
  }

  beforeEach(() => {
    records.length = 0;
    resetEmbeddingCacheForTests();
    for (const key of ["OPENROUTER_API_KEY", "DEEPINFRA_API_KEY", "PERPLEXITY_API_KEY", "OPENAI_API_KEY"]) process.env[key] = "test";
    embedConfiguredText.mockReset().mockImplementation(async (args: { onUsage?: (u: { inputTokens: number }) => void }) => {
      args.onUsage?.({ inputTokens: 7 });
      return { embedding: [0.1, 0.2, 0.3], usage: { inputTokens: 7 } };
    });
  });
  afterEach(() => { resetEmbeddingCacheForTests(); });

  it("records provider usage once on a miss and none on a hit", async () => {
    const first = await plan("what is   the policy");
    expect(first.timings.embedCacheMiss).toBe(1);
    const second = await plan("what is the policy ");
    expect(second.timings.embedCacheHit).toBe(1);
    expect(second.value.queryVector).toEqual([0.1, 0.2, 0.3]);
    expect(embedConfiguredText).toHaveBeenCalledTimes(1);
    expect(records.filter((r) => r.metric === "embed-query")).toHaveLength(1);
  });

  it("does not share entries across orgs", async () => {
    await plan("same text", "org-a");
    const other = await plan("same text", "org-b");
    expect(other.timings.embedCacheMiss).toBe(1);
    expect(embedConfiguredText).toHaveBeenCalledTimes(2);
  });

  it("returns copies so callers cannot corrupt cached vectors", async () => {
    const first = await plan("q");
    first.value.queryVector!.push(99);
    const second = await plan("q");
    expect(second.value.queryVector).toEqual([0.1, 0.2, 0.3]);
  });

  it("bypasses the cache in strict-privacy mode and counts the bypass", async () => {
    const first = await plan("q", "org-a", "strict-privacy").catch(() => undefined);
    await plan("q", "org-a", "strict-privacy").catch(() => undefined);
    expect(embedConfiguredText.mock.calls.length).toBe(2);
    if (first) expect(first.timings.embedCacheBypass).toBe(1);
    expect(session.recordDiagnostic).toHaveBeenCalledWith("embeddingCache", expect.objectContaining({ bypassed: true, bypassReason: "strict-privacy" }));
  });

  it("caches in local-only mode", async () => {
    await plan("q", "org-a", "local-only").catch(() => undefined);
    const second = await plan("q", "org-a", "local-only").catch(() => undefined);
    expect(embedConfiguredText.mock.calls.length).toBe(1);
    if (second) expect(second.timings.embedCacheHit).toBe(1);
  });

  it("names the bypass reason", () => {
    expect(embeddingCacheBypassReason("strict-privacy", "org-a")).toBe("strict-privacy");
    expect(embeddingCacheBypassReason("standard", undefined)).toBe("no-org");
    expect(embeddingCacheBypassReason("local-only", "org-a")).toBeNull();
    expect(embeddingCacheBypassReason("standard", "org-a")).toBeNull();
  });

  it("does not cache failures", async () => {
    embedConfiguredText.mockRejectedValueOnce(new Error("boom"));
    await plan("q").catch(() => undefined);
    await plan("q");
    expect(embedConfiguredText).toHaveBeenCalledTimes(2);
  });
});

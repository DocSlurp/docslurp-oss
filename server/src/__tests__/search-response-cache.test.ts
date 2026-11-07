import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The response cache on its own: strict-privacy anywhere in scope, or any
 * lookup that cannot answer in time, means no ticket (no cache read or write);
 * writes re-check privacy and invalidation; memory is bounded per organization.
 */

type Access = { projectId: string; orgId: string; pipeline: unknown } | Error | "slow";
const access = vi.hoisted(() => new Map<string, unknown>());
const lookups = vi.hoisted(() => ({ count: 0 }));
vi.mock("../services/organizations.js", () => ({
  getProjectAccessWithPipeline: vi.fn(async (projectId: string) => {
    lookups.count += 1;
    const entry = access.get(projectId) as Access | undefined;
    if (entry instanceof Error) throw entry;
    if (entry === "slow") {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { projectId, orgId: "org-1", pipeline: {} };
    }
    return entry ?? null;
  }),
}));
vi.mock("../search/eligible-documents.js", () => ({ ensureInvalidationListener: vi.fn(), onSearchProjectInvalidated: vi.fn() }));
vi.mock("../db.js", () => ({ sql: vi.fn(async () => { throw new Error("no database in this test"); }) }));

const cache = await import("../search/response-cache.js");

const request = { q: "pump", project: "ws-a" };
const ticket = (projectIds: string[], overrides: Partial<Parameters<typeof cache.responseCacheTicket>[0]> = {}) =>
  cache.responseCacheTicket({ userId: "user-1", apiKeyId: "key-1", projectIds, request, ...overrides });
const set = (id: string, orgId: string, privacyMode?: string) =>
  access.set(id, { projectId: id, orgId, pipeline: privacyMode ? { privacyMode } : {} });

beforeEach(() => {
  cache.clearSearchResponseCacheForTests();
  access.clear();
  lookups.count = 0;
  set("ws-a", "org-1");
  set("ws-b", "org-1", "local-only");
  set("ws-strict", "org-1", "strict-privacy");
  set("ws-other", "org-2");
});

describe("responseCacheTicket", () => {
  it("issues a hashed key for standard and local-only scopes", async () => {
    const value = await ticket(["ws-b", "ws-a"]);
    expect(value).toMatchObject({ orgKey: "org-1", userId: "user-1", projectIds: ["ws-a", "ws-b"] });
    expect(value!.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("separates callers, keys, organizations and exact requests", async () => {
    const base = (await ticket(["ws-a"]))!.key;
    const variants = await Promise.all([
      ticket(["ws-a"], { userId: "user-2" }),
      ticket(["ws-a"], { apiKeyId: null }),
      ticket(["ws-a"], { apiKeyId: "key-2" }),
      ticket(["ws-other"]),
      ticket(["ws-a"], { request: { ...request, tags: "x" } }),
      // Whitespace is not normalized away: the search runs on the query as sent.
      ticket(["ws-a"], { request: { ...request, q: " pump" } }),
    ]);
    for (const variant of variants) {
      expect(variant).not.toBeNull();
      expect(variant!.key).not.toBe(base);
    }
  });

  it("refuses a strict-privacy project alone or anywhere in a mixed scope", async () => {
    expect(await ticket(["ws-strict"])).toBeNull();
    expect(await ticket(["ws-a", "ws-strict"])).toBeNull();
    expect(await ticket(["ws-strict", "ws-b", "ws-a"])).toBeNull();
  });

  it("fails closed when privacy or access cannot be resolved", async () => {
    access.delete("ws-a");
    expect(await ticket(["ws-a"])).toBeNull();
    access.set("ws-a", new Error("db down"));
    expect(await ticket(["ws-a"])).toBeNull();
    access.set("ws-a", { projectId: "ws-other", orgId: "org-2", pipeline: {} });
    expect(await ticket(["ws-a"])).toBeNull();
    access.set("ws-a", { projectId: "ws-a", orgId: "org-1", pipeline: { privacyMode: "not-a-mode" } });
    expect(await ticket(["ws-a"])).toBeNull();
  });

  it("gives up (no cache) when the lookup is slower than its timeout", async () => {
    access.set("ws-a", "slow");
    const started = Date.now();
    expect(await ticket(["ws-a"])).toBeNull();
    expect(Date.now() - started).toBeLessThan(380);
  });

  it("shares lookups within one memo and repeats them without it", async () => {
    const memo = cache.createCacheScopeMemo();
    await ticket(["ws-a"], { memo });
    await ticket(["ws-a"], { memo, request: { q: "other" } });
    expect(lookups.count).toBe(1);
    await ticket(["ws-a"]);
    await ticket(["ws-a"]);
    expect(lookups.count).toBe(3);
  });

  it("refuses an empty scope or caller", async () => {
    expect(await ticket([])).toBeNull();
    expect(await ticket([""])).toBeNull();
    expect(await ticket(["ws-a"], { userId: " " })).toBeNull();
  });
});

describe("cacheableApiKeyId", () => {
  it("never caches an unknown caller", () => {
    expect(cache.cacheableApiKeyId(undefined, null)).toBeUndefined();
    expect(cache.cacheableApiKeyId(undefined, "key-1")).toBeUndefined();
  });

  it("never caches when the actor and request context disagree on the key", () => {
    expect(cache.cacheableApiKeyId("key-1", "key-2")).toBeUndefined();
    expect(cache.cacheableApiKeyId(null, "key-1")).toBeUndefined();
  });

  it("uses the agreed key, or null for a session", () => {
    expect(cache.cacheableApiKeyId("key-1", "key-1")).toBe("key-1");
    expect(cache.cacheableApiKeyId("key-1", null)).toBe("key-1");
    expect(cache.cacheableApiKeyId(null, null)).toBeNull();
  });
});

describe("storeResponse", () => {
  const data = (id = "x") => ({ results: [{ id }] });

  it("stores and replays an answer whose scope matches", async () => {
    const t = (await ticket(["ws-a"]))!;
    expect(await cache.storeResponse(t, data(), "ws-a")).toBe(true);
    expect(cache.readCachedResponse(t, 60_000)).toEqual(data());
  });

  it("requires an explicit scope match for a single-project ticket", async () => {
    const t = (await ticket(["ws-a"]))!;
    expect(await cache.storeResponse(t, data(), undefined)).toBe(false);
    expect(await cache.storeResponse(t, data(), null)).toBe(false);
    expect(await cache.storeResponse(t, data(), "ws-other")).toBe(false);
    expect(cache.readCachedResponse(t, 60_000)).toBeUndefined();
  });

  it("does not store when the project became strict-privacy during the search", async () => {
    const t = (await ticket(["ws-a"]))!;
    set("ws-a", "org-1", "strict-privacy");
    expect(await cache.storeResponse(t, data(), "ws-a")).toBe(false);
    set("ws-a", "org-1");
    expect(cache.readCachedResponse(t, 60_000)).toBeUndefined();
  });

  it("does not store when the project was invalidated during the search, even if it reads standard again", async () => {
    const t = (await ticket(["ws-a"]))!;
    cache.invalidateSearchResponseCacheProject("ws-a");
    expect(await cache.storeResponse(t, data(), "ws-a")).toBe(false);
  });

  it("drops a project's entries on invalidation", async () => {
    const a = (await ticket(["ws-a"]))!;
    const b = (await ticket(["ws-b"]))!;
    await cache.storeResponse(a, data("a"), "ws-a");
    await cache.storeResponse(b, data("b"), "ws-b");
    cache.invalidateSearchResponseCacheProject("ws-a");
    expect(cache.readCachedResponse(a, 60_000)).toBeUndefined();
    expect(cache.readCachedResponse(b, 60_000)).toEqual(data("b"));
  });

  it("skips oversized answers", async () => {
    cache.configureSearchResponseCacheLimitsForTests({ maxEntryBytes: 64 });
    const t = (await ticket(["ws-a"]))!;
    expect(await cache.storeResponse(t, { results: ["x".repeat(100)] }, "ws-a")).toBe(false);
    expect(cache.searchResponseCacheStatsForTests().entries).toBe(0);
  });

  it("caps each organization so one tenant cannot evict another's entries", async () => {
    cache.configureSearchResponseCacheLimitsForTests({ perOrgMaxEntries: 3, maxEntries: 5 });
    const victim = (await ticket(["ws-other"]))!;
    await cache.storeResponse(victim, data("victim"), "ws-other");
    for (let i = 0; i < 20; i += 1) {
      await cache.storeResponse((await ticket(["ws-a"], { request: { q: `flood ${i}` } }))!, data(`f${i}`), "ws-a");
    }
    expect(cache.searchResponseCacheStatsForTests().byOrg).toEqual({ "org-1": 3, "org-2": 1 });
    expect(cache.readCachedResponse(victim, 60_000)).toEqual(data("victim"));
  });

  it("evicts from the largest organization under global byte pressure", async () => {
    cache.configureSearchResponseCacheLimitsForTests({ maxBytes: 400 });
    const victim = (await ticket(["ws-other"]))!;
    await cache.storeResponse(victim, data("victim"), "ws-other");
    for (let i = 0; i < 30; i += 1) {
      await cache.storeResponse((await ticket(["ws-a"], { request: { q: `flood ${i}` } }))!, data(`f${i}`), "ws-a");
    }
    expect(cache.searchResponseCacheStatsForTests().bytes).toBeLessThanOrEqual(400);
    expect(cache.readCachedResponse(victim, 60_000)).toEqual(data("victim"));
  });
});

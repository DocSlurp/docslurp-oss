import { describe, expect, it } from "vitest";

import { createEmbeddingCache } from "../search/embedding-cache.js";
import { createResultCache } from "../search/result-cache.js";
import { OrgPartitionedTtlLru } from "../search/ttl-lru.js";

/**
 * Organization isolation (AGENTS.md): shared caches give each organization its own bounded share, so one
 * organization's volume can never evict another's entries (a side channel: org B's hits turning into misses
 * reveals that org A is busy), while memory stays bounded overall.
 */
describe("OrgPartitionedTtlLru", () => {
  it("never serves one organization's entry to another with an identical key", () => {
    const cache = new OrgPartitionedTtlLru<number>(10, 1000);
    cache.set("org-a", "same-key", 1);
    expect(cache.get("org-b", "same-key")).toBeUndefined();
    expect(cache.get("org-a", "same-key")).toBe(1);
  });

  it("refuses a blank organization on every read and write", () => {
    const cache = new OrgPartitionedTtlLru<number>(10, 1000);
    for (const org of ["", "  ", undefined as unknown as string, null as unknown as string]) {
      expect(() => cache.set(org, "k", 1)).toThrow(/organization id is required/);
      expect(() => cache.get(org, "k")).toThrow(/organization id is required/);
    }
  });

  it("caps each organization at its own share: a flood evicts only the flooder's entries", () => {
    const cache = new OrgPartitionedTtlLru<number>(100, 60_000, 25);
    for (let i = 0; i < 10; i++) cache.set("org-b", `b${i}`, i);
    for (let i = 0; i < 10_000; i++) cache.set("org-a", `a${i}`, i);
    expect(cache.sizeFor("org-a")).toBe(25);
    for (let i = 0; i < 10; i++) expect(cache.get("org-b", `b${i}`)).toBe(i);
    expect(cache.size).toBeLessThanOrEqual(100);
  });

  it("under global pressure, never evicts an organization holding no more than an equal share", () => {
    // 8 organizations at the per-org cap fill the cache to twice its size; the global cap still holds.
    const cache = new OrgPartitionedTtlLru<number>(40, 60_000, 10);
    for (let i = 0; i < 5; i++) cache.set("org-small", `s${i}`, i); // equal share with 8 orgs is 5
    for (let org = 0; org < 7; org++) {
      for (let i = 0; i < 1_000; i++) cache.set(`org-${org}`, `k${i}`, i);
    }
    expect(cache.size).toBeLessThanOrEqual(40);
    for (let i = 0; i < 5; i++) expect(cache.get("org-small", `s${i}`)).toBe(i);
  });

  it("a busy organization at or above its equal share evicts its own entries, never a larger organization's", () => {
    const cache = new OrgPartitionedTtlLru<number>(10, 60_000, 6);
    for (let i = 0; i < 6; i++) cache.set("org-b", `b${i}`, i);
    for (let i = 0; i < 1_000; i++) cache.set("org-a", `a${i}`, i);
    expect(cache.sizeFor("org-b")).toBe(6);
    expect(cache.sizeFor("org-a")).toBe(4);
    for (let i = 0; i < 6; i++) expect(cache.get("org-b", `b${i}`)).toBe(i);
  });

  it("reclaims expired entries before evicting another organization's live ones", () => {
    let now = 0;
    const cache = new OrgPartitionedTtlLru<number>(4, 1000, 4, () => now);
    cache.set("org-old", "x1", 1); cache.set("org-old", "x2", 2); cache.set("org-old", "x3", 3);
    now = 500;
    cache.set("org-live", "y1", 1);
    now = 1200; // org-old's entries expired; org-live's has not
    cache.set("org-new", "z1", 1);
    cache.set("org-new", "z2", 2);
    expect(cache.get("org-live", "y1")).toBe(1);
    expect(cache.size).toBeLessThanOrEqual(4);
  });

  it("keeps memory bounded with many organizations", () => {
    const cache = new OrgPartitionedTtlLru<number>(50, 60_000, 10);
    for (let org = 0; org < 500; org++) for (let i = 0; i < 3; i++) cache.set(`org-${org}`, `k${i}`, i);
    expect(cache.size).toBeLessThanOrEqual(50);
  });

  it("the search embedding and result caches are partitioned with a per-org cap", () => {
    const embeddings = createEmbeddingCache({ SEARCH_EMBEDDING_CACHE_MAX_ENTRIES: "8", SEARCH_EMBEDDING_CACHE_MAX_ENTRIES_PER_ORG: "2" } as NodeJS.ProcessEnv);
    embeddings.set("org-b", "b", [1]);
    for (let i = 0; i < 100; i++) embeddings.set("org-a", `a${i}`, [i]);
    expect(embeddings.get("org-b", "b")).toEqual([1]);
    expect(embeddings.sizeFor("org-a")).toBe(2);
    expect(embeddings.get("org-a", "b")).toBeUndefined();

    const results = createResultCache<number>({ SEARCH_RESULT_CACHE_MAX_ENTRIES: "8" } as NodeJS.ProcessEnv);
    expect(results.perOrgMaxEntries).toBe(2);
    results.set("org-b", "b", 1);
    for (let i = 0; i < 100; i++) results.set("org-a", `a${i}`, i);
    expect(results.get("org-b", "b")).toBe(1);
  });
});

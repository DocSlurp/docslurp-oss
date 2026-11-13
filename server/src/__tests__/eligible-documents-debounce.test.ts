import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(async () => []), { array: (values: unknown[]) => values }), apiPool: {} }));

const eligible = await import("../search/eligible-documents.js");

/**
 * Native search drops a project's cached eligible set on two hints: run progress
 * (debounced: documents arriving may wait one window) and withdrawals (immediate).
 */
describe("eligible-set invalidation", () => {
  const drops: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    eligible.resetEligibleDocumentCachesForTests();
    drops.length = 0;
  });
  afterEach(() => {
    eligible.resetEligibleDocumentCachesForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });
  eligible.onSearchProjectInvalidated({ invalidate: (projectId) => { drops.push(projectId); }, active: () => true });

  it("reloads at most once per window during a burst of run_events hints, and once more at the end of it", () => {
    for (let i = 0; i < 20; i += 1) {
      eligible.invalidateSearchProjectDebounced("p");
      vi.advanceTimersByTime(50);
    }
    // One immediate drop, then one at the window's end (t = 1000 ms); the rest coalesced.
    expect(drops).toEqual(["p", "p"]);
    vi.advanceTimersByTime(1_000);
    expect(drops).toEqual(["p", "p"]);
    // Quiet again: the next hint drops immediately.
    eligible.invalidateSearchProjectDebounced("p");
    expect(drops).toEqual(["p", "p", "p"]);
  });

  it("debounces per project", () => {
    eligible.invalidateSearchProjectDebounced("a");
    eligible.invalidateSearchProjectDebounced("b");
    eligible.invalidateSearchProjectDebounced("a");
    expect(drops).toEqual(["a", "b"]);
  });

  it("drops immediately on a withdrawal hint, even while a run_events drop is pending", () => {
    eligible.invalidateSearchProjectDebounced("p");
    eligible.invalidateSearchProjectDebounced("p");
    expect(drops).toEqual(["p"]);
    vi.advanceTimersByTime(100);
    eligible.handleSearchEligibilityHint(JSON.stringify({ projectIds: ["p"] }));
    expect(drops).toEqual(["p", "p"]);
    // Withdrawals are never debounced, however close together.
    eligible.handleSearchEligibilityHint(JSON.stringify({ projectIds: ["p"] }));
    expect(drops).toEqual(["p", "p", "p"]);
  });

  it("serves the cached set inside the window and a fresh one after it", async () => {
    const { sql } = await import("../db.js") as unknown as { sql: ReturnType<typeof vi.fn> };
    let rows = [{ id: "d1", filename: "a", mime_type: null, run_id: "r", tags: null, vector_ready: true, lexical: true, page_only_completed: false, owner_id: null, owner_index_config_hash: null, lance_stale: false }];
    sql.mockImplementation(async () => rows);
    const load = () => eligible.loadEligibleDocuments({ projectId: "p", embeddingModel: "m", dimension: 2 });
    const first = await load();
    eligible.invalidateSearchProjectDebounced("p"); // immediate: nothing dropped recently
    rows = [...rows, { ...rows[0]!, id: "d2" }];
    const second = await load();
    expect(second.documents.map((document) => document.id)).toEqual(["d1", "d2"]);
    expect(second).not.toBe(first);
    rows = [...rows, { ...rows[0]!, id: "d3" }];
    eligible.invalidateSearchProjectDebounced("p"); // inside the window: deferred
    expect(await load()).toBe(second);
    vi.advanceTimersByTime(1_000);
    expect((await load()).documents.map((document) => document.id)).toEqual(["d1", "d2", "d3"]);
  });

  it("SEARCH_ELIGIBLE_DEBOUNCE_MS=0 drops on every hint", () => {
    vi.stubEnv("SEARCH_ELIGIBLE_DEBOUNCE_MS", "0");
    eligible.invalidateSearchProjectDebounced("p");
    eligible.invalidateSearchProjectDebounced("p");
    expect(drops).toEqual(["p", "p"]);
  });
});

describe("excludedTableDocuments", () => {
  const document = (id: string, extra: Partial<import("../search/eligible-documents.js").EligibleDocument> = {}) => ({
    id, filename: id, mimeType: null, runId: "r", tags: [], vectorReady: true, lexical: true, ownerId: id, ownerIndexConfigHash: null, lanceStale: false, ...extra,
  });
  const set = { projectId: "p", embeddingModel: "m", dimension: 2, pageOnlyCompletedDocuments: 0, loadedAt: 0, documents: [
    document("a"), document("b"), document("copy", { ownerId: "a" }), document("early", { vectorReady: false, ownerId: null }),
  ] };
  it("is empty for a full-project scope and lists the row owners a filter leaves out", () => {
    expect(eligible.excludedTableDocuments(set, ["a", "b", "copy"])).toEqual([]);
    expect(eligible.excludedTableDocuments(set, ["b"])).toEqual(["a"]);
    // A copy searches through its owner's rows; documents without vectors are not in the table.
    expect(eligible.excludedTableDocuments(set, ["copy", "a"])).toEqual(["b"]);
  });
});

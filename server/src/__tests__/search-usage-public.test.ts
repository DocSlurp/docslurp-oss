import { describe, expect, it } from "vitest";

import { publicSearchResponse } from "../lib/search-usage.js";
import type { SearchResponse } from "../services/search.js";

const base = { results: [], sessionId: "s-1", availability: null } as unknown as SearchResponse;

describe("publicSearchResponse relevance floor", () => {
  it("exposes noMatch and the floor that produced it", () => {
    const data = publicSearchResponse({ ...base, relevanceFloor: { minScore: 0.1, dropped: 2, noMatch: true } });
    expect(data.noMatch).toBe(true);
    expect(data.relevanceFloor).toEqual({ minScore: 0.1, dropped: 2 });
  });

  it("reports noMatch false when the floor did not run", () => {
    const data = publicSearchResponse(base);
    expect(data.noMatch).toBe(false);
    expect("relevanceFloor" in data).toBe(false);
  });
});

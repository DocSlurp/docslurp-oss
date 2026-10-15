import { describe, expect, it } from "vitest";

import { buildPageIndexSearchMetadata } from "../stages/page-index.js";

describe("buildPageIndexSearchMetadata", () => {
  it("marks page index artifacts as page-searchable but not fully indexed", () => {
    expect(buildPageIndexSearchMetadata(5)).toEqual({
      mode: "page-index",
      searchablePages: 5,
      fullyIndexed: false
    });
  });
});

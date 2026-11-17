import { describe, expect, it } from "vitest";
import { searchInputSchema, searchOptions } from "./search-input.js";

describe("searchInputSchema query", () => {
  it("accepts a normal query and a query that merely contains a NUL byte", () => {
    expect(searchInputSchema.safeParse({ q: "tls handshake" }).success).toBe(true);
    expect(searchInputSchema.safeParse({ q: "tls \u0000 handshake" }).success).toBe(true);
  });

  it.each(["", "   ", "\u0000", " \u0000\u0000 "])("rejects the empty query %j", (q) => {
    const result = searchInputSchema.safeParse({ q });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["q"]);
  });
});

describe("removed contextual compression", () => {
  it("still accepts compression: false from older clients and refuses compression: true", () => {
    expect(searchInputSchema.safeParse({ q: "pump", compression: false }).success).toBe(true);
    expect(searchInputSchema.safeParse({ q: "pump", compression: true }).success).toBe(false);
    expect(searchOptions({ ...searchInputSchema.parse({ q: "pump", compression: false }), projectId: "p" })).not.toHaveProperty("useContextualCompression");
  });
});

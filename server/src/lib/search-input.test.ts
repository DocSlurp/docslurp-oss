import { describe, expect, it } from "vitest";
import { searchInputSchema } from "./search-input.js";

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

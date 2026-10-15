import { describe, expect, it } from "vitest";

import {
  canonicalIdForUrl,
  canonicalIdsForFiles,
  InvalidCanonicalIdError,
  normalizeCanonicalId,
} from "../lib/canonical-id.js";

describe("canonical IDs", () => {
  it("trims, treats blanks as absent, and bounds length", () => {
    expect(normalizeCanonicalId("  /products ")).toBe("/products");
    expect(normalizeCanonicalId("   ")).toBeNull();
    expect(normalizeCanonicalId(undefined)).toBeNull();
    expect(() => normalizeCanonicalId("x".repeat(2049))).toThrow(InvalidCanonicalIdError);
    expect(() => normalizeCanonicalId(42)).toThrow(InvalidCanonicalIdError);
  });

  it("derives URL identities without fragments or trailing slashes", () => {
    expect(canonicalIdForUrl("https://Example.com/products/#pricing")).toBe("https://example.com/products");
    expect(canonicalIdForUrl("https://example.com/?page=2")).toBe("https://example.com/?page=2");
  });

  it("maps multipart fields to files by position or filename", () => {
    expect(canonicalIdsForFiles(["a.md"], { canonicalId: "/a" })).toEqual(["/a"]);
    expect(canonicalIdsForFiles(["a.md", "b.md"], { canonicalId: ["/a", "/b"] })).toEqual(["/a", "/b"]);
    expect(canonicalIdsForFiles(["a.md", "b.md"], { canonicalIds: "[null, \"/b\"]" })).toEqual([null, "/b"]);
    expect(canonicalIdsForFiles(["a.md", "b.md"], { canonicalIds: "{\"a.md\": \"/a\"}" })).toEqual(["/a", null]);
    expect(canonicalIdsForFiles(["a.md"], {})).toEqual([null]);
  });

  it("rejects ambiguous or malformed multipart mappings", () => {
    expect(() => canonicalIdsForFiles(["a.md", "b.md"], { canonicalId: "/a" })).toThrow(InvalidCanonicalIdError);
    expect(() => canonicalIdsForFiles(["a.md", "b.md"], { canonicalIds: "[\"/a\"]" })).toThrow(InvalidCanonicalIdError);
    expect(() => canonicalIdsForFiles(["a.md"], { canonicalIds: "{\"c.md\": \"/c\"}" })).toThrow(InvalidCanonicalIdError);
    expect(() => canonicalIdsForFiles(["a.md"], { canonicalIds: "not json" })).toThrow(InvalidCanonicalIdError);
  });
});

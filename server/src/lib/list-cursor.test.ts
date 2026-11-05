import { describe, expect, it } from "vitest";

import { decodeListCursor, encodeListCursor, InvalidListCursorError, parseListLimit } from "./list-cursor.js";

describe("list cursors", () => {
  it("round-trips the keyset values of one list kind", () => {
    const cursor = encodeListCursor("documents", { createdAt: "2026-11-04 12:00:00.123456+00", id: "doc-9" });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeListCursor("documents", cursor, { createdAt: "string", id: "string" })).toEqual({ createdAt: "2026-11-04 12:00:00.123456+00", id: "doc-9" });
  });

  it.each([
    ["another list kind", encodeListCursor("runs", { createdAt: "x", id: "y" })],
    ["not base64url", "not a cursor!"],
    ["not JSON", Buffer.from("plain").toString("base64url")],
    ["a JSON array", Buffer.from("[1]").toString("base64url")],
    ["a missing field", encodeListCursor("documents", { createdAt: "x" })],
    ["a wrong field type", encodeListCursor("documents", { createdAt: 5, id: "y" })],
    ["oversized", "a".repeat(600)],
  ])("refuses %s with a 400", (_name, cursor) => {
    expect(() => decodeListCursor("documents", cursor, { createdAt: "string", id: "string" })).toThrow(InvalidListCursorError);
  });

  it("validates limits", () => {
    expect(parseListLimit(undefined, 50, 100)).toBe(50);
    expect(parseListLimit("7", 50, 100)).toBe(7);
    for (const bad of ["0", "101", "-1", "1.5", "abc", "1e2"]) expect(() => parseListLimit(bad, 50, 100)).toThrow();
  });
});

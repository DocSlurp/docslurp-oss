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

  it.each([
    "2026-11-04 12:00:00.123456+00",
    "2026-11-04T12:00:00Z",
    "2026-11-04 12:00:00+05:30",
    "2026-11-04 12:00:00-0800",
    "2026-11-04 12:00:00+15:59",
    "2026-11-04 12:00:00-15",
  ])("accepts the timestamp %s", (createdAt) => {
    expect(decodeListCursor("documents", encodeListCursor("documents", { createdAt, id: "y" }), { createdAt: "timestamp", id: "string" })).toEqual({ createdAt, id: "y" });
  });

  it.each([
    ["an offset beyond 15 hours", "2026-11-04 12:00:00+99"],
    ["an offset of 16 hours", "2026-11-04 12:00:00-16:00"],
    ["offset minutes of 60 or more", "2026-11-04 12:00:00+05:60"],
    ["offset minutes of 99", "2026-11-04 12:00:00+0599"],
    ["an impossible date", "2026-02-30 12:00:00+00"],
    ["an impossible hour", "2026-11-04 24:00:00+00"],
  ])("refuses a timestamp with %s with a 400, before it can fail the query's cast", (_name, createdAt) => {
    expect(() => decodeListCursor("documents", encodeListCursor("documents", { createdAt, id: "y" }), { createdAt: "timestamp", id: "string" })).toThrow(InvalidListCursorError);
  });

  it("validates limits", () => {
    expect(parseListLimit(undefined, 50, 100)).toBe(50);
    expect(parseListLimit("7", 50, 100)).toBe(7);
    for (const bad of ["0", "101", "-1", "1.5", "abc", "1e2"]) expect(() => parseListLimit(bad, 50, 100)).toThrow();
  });
});

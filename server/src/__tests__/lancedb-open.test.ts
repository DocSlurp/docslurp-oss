import { beforeEach, describe, expect, it, vi } from "vitest";
const spans = vi.hoisted(() => ({ set: vi.fn(), end: vi.fn(), start: vi.fn() }));
vi.mock("@docslurp/shared/observability", () => ({
  startDependencySpan: (...args: unknown[]) => {
    spans.start(...args);
    return { set: spans.set, end: spans.end, run: <T>(run: () => T) => run() };
  },
}));
import { lanceOpenFailure, openLanceTable } from "../search/lancedb-open.js";

beforeEach(() => vi.clearAllMocks());
describe("Lance table outcome telemetry", () => {
  it("records successful opens without changing the returned handle", async () => {
    const table = { name: "trusted_table" };
    expect(await openLanceTable("trusted_table", async () => table)).toBe(table);
    expect(spans.set).toHaveBeenCalledWith({ "docslurp.lancedb.open_outcome": "opened" });
    expect(spans.end).toHaveBeenCalledWith();
  });
  it("preserves a missing-table rejection for negative caching without an error span", async () => {
    const error = new Error("Table 'chunks_org_hash' was not found");
    await expect(openLanceTable("chunks_org_hash", async () => { throw error; })).rejects.toBe(error);
    expect(spans.start).toHaveBeenCalledWith("lancedb.openTable", expect.objectContaining({ "db.collection.name": "chunks_org_hash" }));
    expect(spans.set).toHaveBeenCalledWith({ "docslurp.lancedb.open_outcome": "not_found" });
    expect(spans.end.mock.calls).toEqual([[]]);
  });
  it.each([
    ["AccessDenied for https://private.example/key?token=secret", "permission_denied"],
    ["request timed out", "timeout"],
    ["ECONNRESET", "storage_unavailable"],
    ["corrupt manifest at s3://private/bucket", "unknown"],
  ])("keeps real failure status and sanitized diagnostic classification: %s", async (message, reason) => {
    const error = new Error(message);
    await expect(openLanceTable("chunks_org_hash", async () => { throw error; })).rejects.toBe(error);
    expect(spans.end).toHaveBeenCalledWith(error);
    expect(spans.set).toHaveBeenCalledWith({ "docslurp.lancedb.open_outcome": reason });
    expect(JSON.stringify(spans.set.mock.calls)).not.toContain(message);
  });
  it("does not confuse object-storage missing keys with an absent Lance table", () => {
    expect(lanceOpenFailure(new Error("NoSuchKey: object was not found"))).toBe("unknown");
  });
});

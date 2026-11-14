import { describe, expect, it, vi } from "vitest";
import { prewarmSearchIndexes, prewarmTable, type PrewarmableTable } from "../search/lancedb-prewarm.js";

function fakeTable(overrides: Partial<PrewarmableTable> = {}): PrewarmableTable & { prewarmIndex: ReturnType<typeof vi.fn>; prewarmData: ReturnType<typeof vi.fn> } {
  return {
    listIndices: async () => [
      { name: "vector_idx", indexType: "IvfHnswSq", columns: ["vector"] },
      { name: "id_idx", indexType: "BTree", columns: ["id"] },
      { name: "text_idx", indexType: "FTS", columns: ["text"] },
    ],
    prewarmIndex: vi.fn(async () => undefined),
    prewarmData: vi.fn(async () => undefined),
    schema: async () => ({ fields: [{ name: "id" }, { name: "vector" }, { name: "documentId" }] }),
    ...overrides,
  } as never;
}

describe("prewarmTable", () => {
  it("warms vector and FTS indexes but not scalar indexes, and skips data by default", async () => {
    const table = fakeTable();
    const log = vi.fn();
    const result = await prewarmTable(table, "t", { prewarmIndex: true, prewarmData: false }, log);
    expect(result.indexes).toEqual(["vector_idx", "text_idx"]);
    expect(table.prewarmData).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("prewarm table=t indexes=vector_idx,text_idx data=- "));
  });

  it("prewarms data columns that exist when enabled", async () => {
    const table = fakeTable({ schema: async () => ({ fields: [{ name: "id" }, { name: "vector" }] }) });
    const result = await prewarmTable(table, "t", { prewarmIndex: false, prewarmData: true }, vi.fn());
    expect(table.prewarmIndex).not.toHaveBeenCalled();
    expect(table.prewarmData).toHaveBeenCalledWith(["vector", "id"]);
    expect(result.dataColumns).toEqual(["vector", "id"]);
  });

  it("logs failures instead of throwing and keeps warming other targets", async () => {
    const table = fakeTable();
    table.prewarmIndex.mockRejectedValueOnce(new Error("boom\nstack"));
    const log = vi.fn();
    const result = await prewarmTable(table, "t", { prewarmIndex: true, prewarmData: true }, log);
    expect(result.errors).toEqual(["index vector_idx: boom"]);
    expect(result.indexes).toEqual(["text_idx"]);
    expect(result.dataColumns).toEqual(["vector", "id", "documentId"]);
    expect(log.mock.calls[0]![0]).toContain("errors=");
    const broken = fakeTable({ listIndices: async () => { throw new Error("offline"); } });
    await expect(prewarmTable(broken, "t", { prewarmIndex: true, prewarmData: false }, vi.fn())).resolves.toMatchObject({ errors: ["listIndices: offline"] });
  });

  it("does nothing when both switches are off", async () => {
    const table = fakeTable();
    const result = await prewarmTable(table, "t", { prewarmIndex: false, prewarmData: false }, vi.fn());
    expect(result.indexes).toEqual([]);
    expect(table.prewarmIndex).not.toHaveBeenCalled();
  });

  it("prewarmSearchIndexes loads the named indexes concurrently and reports failures without throwing", async () => {
    let active = 0;
    let peak = 0;
    const table = { prewarmIndex: vi.fn(async (name: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (name === "text_idx") throw new Error("boom\nstack");
    }) };
    const log = vi.fn();
    const result = await prewarmSearchIndexes(table, ["vector_idx", "text_idx"], "org/project/vectors", log);
    expect(peak).toBe(2);
    expect(result).toMatchObject({ indexes: ["vector_idx"], errors: ["index text_idx: boom"] });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[lancedb-session\] index-warm table=org\/project\/vectors indexes=vector_idx ms=\d+ errors=/));
  });
});

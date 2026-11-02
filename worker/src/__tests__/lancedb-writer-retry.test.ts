import { beforeEach, expect, it, vi } from "vitest";
import { connectLanceDb } from "../stages/lancedb-connection.js";
import { writeLanceDbRecords } from "../stages/lancedb-writer.js";

vi.mock("../stages/lancedb-connection.js", () => ({ connectLanceDb: vi.fn() }));

const execute = vi.fn();
const merge = {
  whenMatchedUpdateAll: vi.fn().mockReturnThis(),
  whenNotMatchedInsertAll: vi.fn().mockReturnThis(),
  execute,
};
const table = { schema: vi.fn().mockResolvedValue({ metadata: new Map() }), mergeInsert: vi.fn(() => merge), close: vi.fn() };
const db = { tableNames: vi.fn(), createTable: vi.fn(), openTable: vi.fn(), close: vi.fn() };
const records = [{ id: "a", documentId: "doc-a", chunkIndex: 0, text: "first", vector: [0.1, 0.2], metadata: {} }];
const missing = new Error("Table 'org_test' was not found  Caused by: Dataset at path org_test.lance was not found");
const write = (signal?: AbortSignal) => writeLanceDbRecords("/tmp/lance", "org_test", records, signal, { retries: 2, baseDelayMs: 0 });

beforeEach(() => {
  vi.clearAllMocks();
  db.tableNames.mockResolvedValue(["org_test"]);
  db.createTable.mockResolvedValue(table);
  db.openTable.mockResolvedValue(table);
  execute.mockResolvedValue(undefined);
  vi.mocked(connectLanceDb).mockResolvedValue(db as unknown as Awaited<ReturnType<typeof connectLanceDb>>);
});

it.each(["create", "open"])("retries a table whose first version is not yet readable during %s", async (phase) => {
  if (phase === "create") {
    db.tableNames.mockResolvedValue([]);
    db.createTable.mockRejectedValueOnce(missing);
  } else {
    db.openTable.mockRejectedValueOnce(missing);
  }
  await write();
  expect(db.tableNames).toHaveBeenCalledTimes(2);
  expect(execute).toHaveBeenCalledExactlyOnceWith(records);
  expect(db.close).toHaveBeenCalledOnce();
});

it("bounds retries when the table never becomes readable", async () => {
  db.openTable.mockRejectedValue(missing);
  await expect(write()).rejects.toBe(missing);
  expect(db.openTable).toHaveBeenCalledTimes(3);
  expect(execute).not.toHaveBeenCalled();
  expect(db.close).toHaveBeenCalledOnce();
});

it("retries strict creation when another writer wins after the table listing", async () => {
  db.tableNames.mockResolvedValueOnce([]).mockResolvedValue(["org_test"]);
  db.createTable.mockRejectedValueOnce(new Error("Table 'org_test' already exists"));
  await write();
  expect(db.createTable).toHaveBeenCalledExactlyOnceWith("org_test", records);
  expect(db.openTable).toHaveBeenCalledOnce();
  expect(execute).toHaveBeenCalledExactlyOnceWith(records);
  expect(db.close).toHaveBeenCalledOnce();
});

it("does not treat a missing dataset during an upsert as table initialization", async () => {
  execute.mockRejectedValue(missing);
  await expect(write()).rejects.toBe(missing);
  expect(execute).toHaveBeenCalledOnce();
  expect(table.close).toHaveBeenCalledOnce();
  expect(db.close).toHaveBeenCalledOnce();
});

it("does not retry unrelated initialization errors", async () => {
  const denied = new Error("Permission denied");
  db.openTable.mockRejectedValue(denied);
  await expect(write()).rejects.toBe(denied);
  expect(db.openTable).toHaveBeenCalledOnce();
  expect(db.close).toHaveBeenCalledOnce();
});

it("honors cancellation while waiting for a first version", async () => {
  const controller = new AbortController();
  db.openTable.mockImplementationOnce(async () => { controller.abort(); throw missing; });
  await expect(write(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(db.openTable).toHaveBeenCalledOnce();
  expect(db.close).toHaveBeenCalledOnce();
});

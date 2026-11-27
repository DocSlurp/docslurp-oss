import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "@lancedb/lancedb";
import { expect, it } from "vitest";
import { deleteLanceDbRecords, writeLanceDbRecords, writeLanceDbTextRecords } from "../stages/lancedb-writer.js";
import { hasCurrentChunkTextFtsIndex } from "../stages/lancedb-maintenance.js";

it.each([1, 2, 3, 4, 5])("creates an org table concurrently and upserts retried chunks without Python (%i)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "docslurp-lance-test-"));
  const record = (id: string, text: string) => ({
    id, documentId: id, chunkIndex: 0, text, vector: [0.1, 0.2, 0.3], metadata: { pageNumber: 1 },
  });
  try {
    const writers = await Promise.allSettled([
      writeLanceDbRecords(dir, "org_test", [record("a", "first")]),
      writeLanceDbRecords(dir, "org_test", [record("b", "second")]),
    ]);
    // Settle both writers before cleanup, even when one rejects.
    for (const writer of writers) if (writer.status === "rejected") throw writer.reason;
    await writeLanceDbRecords(dir, "org_test", [record("a", "updated")]);
    const db = await connect(dir);
    try {
      const table = await db.openTable("org_test");
      try {
        expect(await table.countRows()).toBe(2);
        const rows = await table.query().toArray();
        expect(rows.find((row) => row.id === "a")?.text).toBe("updated");
        expect(rows.find((row) => row.id === "b")?.text).toBe("second");
        expect(await table.vectorSearch([0.1, 0.2, 0.3]).limit(2).toArray()).toHaveLength(2);
      } finally { table.close(); }
    } finally { db.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("preserves every chunk from eight simultaneous first writers", async () => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const dir = await mkdtemp(path.join(tmpdir(), "docslurp-lance-concurrent-"));
    const records = Array.from({ length: 8 }, (_, index) => ({
      id: String(index), documentId: String(index), chunkIndex: 0,
      text: "original", vector: [0.1, 0.2, 0.3], metadata: { pageNumber: 1 },
    }));
    try {
      const writers = await Promise.allSettled(records.map((record) =>
        writeLanceDbRecords(dir, "chunks", [record]),
      ));
      for (const writer of writers) if (writer.status === "rejected") throw writer.reason;
      await writeLanceDbRecords(dir, "chunks", [{ ...records[0]!, text: "updated" }]);
      const db = await connect(dir);
      try {
        const table = await db.openTable("chunks");
        try {
          const rows = await table.query().toArray();
          expect(rows.map((row) => row.id).sort()).toEqual(records.map((record) => record.id));
          expect(rows.find((row) => row.id === "0")?.text).toBe("updated");
        } finally { table.close(); }
      } finally { db.close(); }
    } finally { await rm(dir, { recursive: true, force: true }); }
  }
}, 180_000);

it("retries timed-out attempts and transient storage errors, not data errors", async () => {
  const { isRetryableLanceCommitError } = await import("../stages/lancedb-writer.js");
  expect(isRetryableLanceCommitError(new Error("LanceDB write attempt timed out after 120000 ms"))).toBe(true);
  expect(isRetryableLanceCommitError(new Error("request failed: read ECONNRESET"))).toBe(true);
  expect(isRetryableLanceCommitError(new Error("S3 error: SlowDown, please reduce your request rate"))).toBe(true);
  expect(isRetryableLanceCommitError(new Error("Commit conflict for version 7"))).toBe(true);
  expect(isRetryableLanceCommitError(new Error("Invalid user input: vector dimension mismatch"))).toBe(false);
});

it("deletes rows by chunk id and ignores a table that does not exist", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "docslurp-lance-delete-"));
  const record = (id: string) => ({ id, documentId: "d", chunkIndex: 0, text: id, vector: [0.1, 0.2, 0.3], metadata: { pageNumber: 1 } });
  try {
    await deleteLanceDbRecords(dir, "missing", ["a"]);
    await writeLanceDbRecords(dir, "chunks", [record("d-000"), record("d-001"), record("d-0'2")]);
    await deleteLanceDbRecords(dir, "chunks", ["d-001", "d-0'2", "never-written"]);
    const db = await connect(dir);
    try {
      const table = await db.openTable("chunks");
      try {
        expect((await table.query().toArray()).map((row) => row.id)).toEqual(["d-000"]);
      } finally { table.close(); }
    } finally { db.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("writes chunk rows without vectors: keyword-searchable at once, skipped by vector search, filled by the vector write", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "docslurp-lance-text-"));
  const text = (index: number, body: string) => ({
    id: `d1-${index}`, documentId: "d1", chunkIndex: index, text: body,
    metadata: { documentId: "d1", sourceKey: "k", filename: "f.pdf" }, runId: "r1", pageNumber: 1, hydration: "{}",
  });
  const vector = (seed: number) => [seed, seed + 1, seed + 2].map((value) => value / 10);
  try {
    // The table does not exist: the text write creates it with a typed vector column and the full-text index.
    await writeLanceDbTextRecords(dir, "chunks", [text(0, "the annual subscription plan renews"), text(1, "refunds within thirty days")], 3);
    const db = await connect(dir);
    try {
      const table = await db.openTable("chunks");
      try {
        expect(String((await table.schema()).fields.find((field) => field.name === "vector")?.type)).toContain("FixedSizeList[3]");
        expect(hasCurrentChunkTextFtsIndex(await table.listIndices())).toBe(true);
        expect(await table.countRows("vector IS NULL")).toBe(2);
        expect((await table.query().fullTextSearch("refunds", { columns: "text" }).limit(5).toArray()).map((row) => row.id)).toEqual(["d1-1"]);
        expect(await table.vectorSearch(vector(1)).limit(5).toArray()).toEqual([]);
      } finally { table.close(); }
      // The index stage's upsert of the same ids fills the vectors.
      await writeLanceDbRecords(dir, "chunks", [0, 1].map((index) => ({ ...text(index, index === 0 ? "the annual subscription plan renews" : "refunds within thirty days"), vector: vector(index + 1) })));
      // A later text write (an embed retry) changes the text and keeps the stored vector; a new id gets none.
      await writeLanceDbTextRecords(dir, "chunks", [text(0, "rewritten opening"), text(2, "a third chunk")], 3);
      const after = await db.openTable("chunks");
      try {
        const rows = new Map((await after.query().toArray()).map((row) => [row.id as string, row]));
        expect(rows.get("d1-0")?.text).toBe("rewritten opening");
        expect(rows.get("d1-0")?.vector).not.toBeNull();
        expect(rows.get("d1-2")?.vector).toBeNull();
        expect((await after.vectorSearch(vector(1)).limit(5).toArray()).map((row) => row.id).sort()).toEqual(["d1-0", "d1-1"]);
      } finally { after.close(); }
    } finally { db.close(); }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("refuses text rows without the table's vector dimensions", async () => {
  await expect(writeLanceDbTextRecords("/nonexistent", "chunks", [{ id: "a", documentId: "a", chunkIndex: 0, text: "x", metadata: {} }], 0))
    .rejects.toThrow(/vector dimensions/);
});

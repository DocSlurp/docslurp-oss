import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "@lancedb/lancedb";
import { expect, it } from "vitest";
import { deleteLanceDbRecords, writeLanceDbRecords } from "../stages/lancedb-writer.js";

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

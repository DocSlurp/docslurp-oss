import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { connect } from "@lancedb/lancedb";
import { decodeLanceChunkHydration } from "@docslurp/shared/lancedb-hydration";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildVectorRecords } from "../stages/index-vectors.js";
import { withUniformHydrationColumns, writeLanceDbRecords } from "../stages/lancedb-writer.js";
import type { EmbeddingArtifact, VectorBackendRecord } from "../stages/embedding-runtime.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "lance-hydration-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const artifact = (documentId: string): Pick<EmbeddingArtifact, "chunks"> => ({
  chunks: [0, 1].map((index) => ({
    id: `${documentId}-${index}`, index, text: `chunk ${index} of ${documentId}`, tokenEstimate: 7, vector: [index, 1, 0, 0],
    headingPath: ["Intro"], pageNumber: index === 0 ? 3 : null, metadata: { blockIds: [`b${index}`] },
  })),
});

function legacyRecords(documentId: string): VectorBackendRecord[] {
  return buildVectorRecords(artifact(documentId), documentId, { sourceKey: "k", filename: "f.pdf" });
}

describe("LanceDB hydration columns", () => {
  it("carry what a citation needs when the run is known", () => {
    const [first, second] = buildVectorRecords(artifact("d1"), "d1", { filename: "f.pdf" }, "run-1");
    expect(first).toMatchObject({ runId: "run-1", pageNumber: 3 });
    expect(second!.pageNumber).toBe(0);
    expect(decodeLanceChunkHydration(first!.hydration)).toEqual({
      v: 1, runId: "run-1", headingPath: ["Intro"], pageNumber: 3, tokenEstimate: 7, metadata: { blockIds: ["b0"] },
    });
    expect(legacyRecords("d1")[0]).not.toHaveProperty("hydration");
  });

  it("give mixed batches one schema", () => {
    const rows = withUniformHydrationColumns([...legacyRecords("d1"), ...buildVectorRecords(artifact("d2"), "d2", {}, "run-2")]);
    expect(rows.map((row) => row.hydration)).toEqual(["", "", expect.any(String), expect.any(String)]);
  });

  it("are added to an existing table, and older writers can still insert after", async () => {
    await writeLanceDbRecords(dir, "chunks", legacyRecords("old"));
    await writeLanceDbRecords(dir, "chunks", buildVectorRecords(artifact("new"), "new", {}, "run-1"));
    // A worker on the previous release keeps writing rows without the columns.
    await writeLanceDbRecords(dir, "chunks", legacyRecords("older-writer"));
    const db = await connect(dir);
    const table = await db.openTable("chunks");
    const names = (await table.schema()).fields.map((field) => field.name);
    expect(names).toEqual(expect.arrayContaining(["runId", "pageNumber", "hydration"]));
    const rows = await table.query().select(["id", "runId", "hydration"]).toArray() as Array<{ id: string; runId: string | null; hydration: string | null }>;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("old-0")!.hydration).toBeNull();
    expect(byId.get("older-writer-0")!.hydration).toBeNull();
    expect(decodeLanceChunkHydration(byId.get("new-0")!.hydration)?.runId).toBe("run-1");
    table.close();
    db.close();
  });
});

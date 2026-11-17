import type { Store } from "../db/store.js";
import type { Document } from "../models.js";

/**
 * Test fixtures load a document by id: this reads the run it belongs to and loads it within that run, as a stage does.
 * Production code always passes its own run or organization (PostgresRunLedger.loadDocument).
 */
export async function loadFixtureDocument(store: Store, documentId: string): Promise<Document> {
  const [row] = await store.stageSql<Array<{ run_id: string }>>`select run_id from documents where id = ${documentId}`;
  return await store.loadDocument(documentId, { runId: row?.run_id ?? "" });
}

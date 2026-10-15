
import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

import { Store } from "../db/store.js";
import type { WorkflowState } from "../pipeline/pipeline.js";


let db: PGlite;
let server: PGLiteSocketServer;
let store: Store;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
      values ('run-1', 'o1', 'u1', 'w', 'url-ingest', 'completed', 'completed', '{}'),
             ('run-2', 'o1', 'u1', 'w', 'url-ingest', 'processing', 'index', '{}');
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, canonical_id, created_at, page_count)
      values ('v1', 'o1', 'u1', 'w', 'run-1', 'p.html', 'text/html', 'k1', 'completed', 'https://x.test/p', '2026-01-01', 3),
             ('v2', 'o1', 'u1', 'w', 'run-2', 'p.html', 'text/html', 'k2', 'embed', 'https://x.test/p', '2026-01-02', 4);
    insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
      values ('vi-v1', 'v1', 'lancedb', 'b', 'p', 'm', 4);
    insert into document_run_stage_states (run_id, document_id, stage_name, status)
      values ('run-2', 'v2', 'index', 'processing');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  const port = served.port;
  store = new Store(`postgres://postgres@127.0.0.1:${port}/postgres`, 60_000);
}, 60_000);

afterAll(async () => {
  await server?.stop();
  await db?.close();
});

describe("canonical cutover", () => {
  it("registers vectors, completes, supersedes and announces in one step", async () => {
    const state = {
      run: { id: "run-2", userId: "u1", workspaceId: "w", stats: {} },
      documents: [{ id: "v2", pageCount: 4 }],
      vectorIndexes: [
        { documentId: "v2", backend: "lancedb", bucket: "b", path: "p2", embeddingModel: "m", dimension: 4 },
        { documentId: "other", backend: "lancedb", bucket: "b", path: "p3", embeddingModel: "m", dimension: 4 },
      ],
      setDocumentStage: () => {},
      refreshStats: () => {},
    } as unknown as WorkflowState;

    await store.completeDocumentStage(state, "v2", "index", "", {});
    // The socket server holds PGlite exclusively while a client is connected.
    await store.close();

    const live = await db.query<{ id: string }>(`
      select d.id from documents d
      where d.workspace_id = 'w' and d.status = 'completed' and d.superseded_at is null
        and exists (select 1 from vector_indexes vi where vi.document_id = d.id)
    `);
    expect(live.rows).toEqual([{ id: "v2" }]);
    expect((await db.query(`select page_count::int as pages from workspace_corpus_stats where workspace_id = 'w'`)).rows)
      .toEqual([{ pages: 4 }]);
    // Only this document's vectors were flushed; the rest stay buffered for updateProgress.
    expect(state.vectorIndexes.map((vector) => vector.documentId)).toEqual(["other"]);
    const events = await db.query<{ event_type: string; document_id: string; payload: { replacedDocumentIds: string[] } }>(
      `select event_type, document_id, payload from workspace_run_events where event_type = 'document.replaced'`,
    );
    expect(events.rows.map((row) => [row.document_id, row.payload.replacedDocumentIds])).toEqual([["v2", ["v1"]]]);
  });
});

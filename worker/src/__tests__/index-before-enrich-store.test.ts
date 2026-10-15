import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Store } from "../db/store.js";
import { loadRunState } from "../pipeline/stage-execution.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

let db: PGlite;
let server: PGLiteSocketServer;
let url: string;

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
      values ('run-1', 'o1', 'u1', 'w', 'upload', 'processing', 'embed', '{}', 2);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, created_at)
      values ('d-1', 'o1', 'u1', 'w', 'run-1', 'a.pdf', 'application/pdf', 'k1', 'processing', 1, '2026-01-01'),
             ('d-2', 'o1', 'u1', 'w', 'run-1', 'b.pdf', 'application/pdf', 'k2', 'completed', 1, '2026-01-02');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  url = `postgres://postgres@127.0.0.1:${served.port}/postgres`;
}, 60_000);

afterAll(async () => {
  await server?.stop();
  await db?.close();
});

async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const store = new Store(url, 60_000, { poolMax: 1 });
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

async function status(id: string): Promise<string | undefined> {
  const result = await db.query<{ status: string }>(`select status from documents where id = $1`, [id]);
  return result.rows[0]?.status;
}

describe("enrichment stages after index (WORKER_INDEX_BEFORE_ENRICH)", () => {
  it("keep an indexed document completed, so it stays searchable", async () => {
    await withStore(async (store) => {
      const state = await loadRunState(store, "run-1");
      await store.startDocumentStage(state, "d-1", "embed");
      await store.completeDocumentStage(state, "d-1", "embed", "", {});
      await store.startDocumentStage(state, "d-1", "index");
      await store.completeDocumentStage(state, "d-1", "index", "", {});
    });
    expect(await status("d-1")).toBe("completed");

    await withStore(async (store) => {
      const state = await loadRunState(store, "run-1");
      await store.startDocumentStage(state, "d-1", "document-summary");
      expect(await status("d-1")).toBe("completed");
      await store.completeDocumentStage(state, "d-1", "document-summary", "", {});
      expect(await status("d-1")).toBe("completed");
      await store.startDocumentStage(state, "d-1", "graph-enrich");
      await store.failDocumentStage(state, "d-1", "graph-enrich", "graph provider down");
    });
    // A failed enrichment stage fails the run, but the indexed document stays searchable.
    expect(await status("d-1")).toBe("completed");
  });

  it("still move a document this run has not indexed through its stages", async () => {
    // d-2 starts 'completed' (e.g. a stale status) but this run never indexed it.
    await withStore(async (store) => {
      const state = await loadRunState(store, "run-1");
      await store.startDocumentStage(state, "d-2", "embed");
      expect(await status("d-2")).toBe("processing");
      await store.completeDocumentStage(state, "d-2", "embed", "", {});
      expect(await status("d-2")).toBe("embed");
    });
  });
});

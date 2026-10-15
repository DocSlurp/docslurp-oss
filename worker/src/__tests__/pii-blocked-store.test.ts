import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fingerprintPiiMatch } from "@docslurp/shared";

import { Store } from "../db/store.js";
import { loadRunState } from "../pipeline/stage-execution.js";
import { createPostgresPiiDetectionSink } from "../stages/pii-detect.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

let db: PGlite;
let server: PGLiteSocketServer;
let url: string;
process.env.WORKER_PII_DB_POOL_MAX = "1";

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
      values ('run-1', 'o1', 'u1', 'w', 'upload', 'processing', 'pii-detect', '{}', 2);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, created_at)
      values ('d-block', 'o1', 'u1', 'w', 'run-1', 'hr.pdf', 'application/pdf', 'k1', 'processing', 2, '2026-01-01'),
             ('d-ok', 'o1', 'u1', 'w', 'run-1', 'ok.pdf', 'application/pdf', 'k2', 'processing', 1, '2026-01-02');
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  const port = served.port;
  url = `postgres://postgres@127.0.0.1:${port}/postgres`;
}, 60_000);

afterAll(async () => {
  await server?.stop();
  await db?.close();
});

// The socket server serves one client at a time, so each phase opens and closes its own pool.
async function withStore<T>(fn: (store: Store) => Promise<T>): Promise<T> {
  const store = new Store(url, 60_000, { poolMax: 1 });
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

describe("PII-blocked documents in the run lifecycle", () => {
  it("stay blocked through stage checkpoints and run completion, with a reason", async () => {
    await withStore(async (store) => {
      const state = await loadRunState(store, "run-1");
      await store.startDocumentStage(state, "d-block", "pii-detect");
    });

    const sink = createPostgresPiiDetectionSink(url);
    const match = { patternType: "ssn" as const, matchedPrefix: fingerprintPiiMatch("ssn", "123-45-6789"), pageNumber: 2, byteOffset: 4, length: 11 };
    // Recording twice (a retried stage) must not duplicate detections.
    await sink.recordDetections("d-block", "run-1", [match], false);
    await sink.recordDetections("d-block", "run-1", [match], false);
    await sink.setDocumentOutcome("d-block", {
      runId: "run-1", action: "block_indexing", matchCount: 1, patternTypes: ["ssn"],
      blocked: true, reviewRequired: false, redacted: false, reason: "PII policy blocked indexing: 1 match (ssn)",
      withheldArtifactUris: ["s3://b/k1"],
    });
    await sink.close();

    await withStore(async (store) => {
      const state = await loadRunState(store, "run-1");
      expect(state.documents.find((document) => document.id === "d-block")?.status).toBe("pii_blocked");
      await store.completeDocumentStage(state, "d-block", "pii-detect", "", { blocked: true, matchCount: 1 });
      // A later stage starting (it should not, but if it did) cannot flip the status back.
      await store.startDocumentStage(state, "d-block", "embed");
      await store.completeDocumentStage(state, "d-block", "embed", "", {});
      await store.startDocumentStage(state, "d-ok", "index");
      await store.completeDocumentStage(state, "d-ok", "index", "", {});
    });

    await withStore(async (store) => {
      const state = await loadRunState(store, "run-1");
      await store.completeRun(state);
      expect(state.documents.find((document) => document.id === "d-block")?.status).toBe("pii_blocked");
    });

    const documents = await db.query<{ id: string; status: string; metadata: { pii?: Record<string, unknown> } }>(
      `select id, status, metadata from documents order by id`,
    );
    expect(documents.rows.map((row) => [row.id, row.status])).toEqual([["d-block", "pii_blocked"], ["d-ok", "completed"]]);
    expect(documents.rows[0]?.metadata.pii).toMatchObject({
      blocked: true, action: "block_indexing", matchCount: 1, patternTypes: ["ssn"],
      reason: "PII policy blocked indexing: 1 match (ssn)",
      withheldArtifactUris: ["s3://b/k1"],
    });
    const run = await db.query<{ status: string }>(`select status from workspace_runs where id = 'run-1'`);
    expect(run.rows[0]?.status).toBe("completed");
    const detections = await db.query<{ pattern_type: string; page_number: number; matched_prefix: string }>(
      `select pattern_type, page_number, matched_prefix from pii_detections where document_id = 'd-block'`,
    );
    expect(detections.rows).toEqual([{ pattern_type: "ssn", page_number: 2, matched_prefix: match.matchedPrefix }]);

    // The API's artifact guard (server/src/services/pii-artifact-guard.ts) matches this shape.
    const withheld = await db.query<{ id: string }>(`
      select d.id from documents d
      where exists (
        select 1 from jsonb_array_elements_text(
          case when jsonb_typeof(d.metadata->'pii'->'withheldArtifactUris') = 'array'
            then d.metadata->'pii'->'withheldArtifactUris' else '[]'::jsonb end
        ) as withheld(uri)
        where withheld.uri = any($1::text[])
      )
    `, [["s3://b/k1"]]);
    expect(withheld.rows).toEqual([{ id: "d-block" }]);

    // Search only serves completed documents, so the blocked one is never retrievable.
    const searchable = await db.query<{ id: string }>(
      `select id from documents where workspace_id = 'w' and status = 'completed' and superseded_at is null`,
    );
    expect(searchable.rows).toEqual([{ id: "d-ok" }]);
  });

  it("a clean rescan lifts an earlier block and clears the PII metadata", async () => {
    await db.exec(`
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, metadata)
        values ('d-rescan', 'o1', 'u1', 'w', 'run-1', 'r.pdf', 'application/pdf', 'k3', 'pii_blocked', 1, '{"pii": {"blocked": true}, "keep": 1}');
    `);
    await withStore(async (store) => {
      const state = await loadRunState(store, "run-1");
      await store.startDocumentStage(state, "d-rescan", "pii-detect");
    });
    const sink = createPostgresPiiDetectionSink(url);
    await sink.setDocumentOutcome("d-rescan", {
      runId: "run-1", action: "block_indexing", matchCount: 0, patternTypes: [],
      blocked: false, reviewRequired: false, redacted: false, reason: null, withheldArtifactUris: [],
    });
    await sink.close();

    const row = await db.query<{ status: string; metadata: Record<string, unknown> }>(
      `select status, metadata from documents where id = 'd-rescan'`,
    );
    expect(row.rows[0]).toEqual({ status: "processing", metadata: { keep: 1 } });
  });

  it("a PII rescan withdraws early keyword search until embed rewrites the chunks", async () => {
    await db.exec(`
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, lexical_searchable_at)
        values ('d-early', 'o1', 'u1', 'w', 'run-1', 'e.pdf', 'application/pdf', 'k4', 'graph-enrich', 1, now());
    `);
    const marker = async () => (await db.query<{ early: boolean }>(
      `select lexical_searchable_at is not null as early from documents where id = 'd-early'`,
    )).rows[0]?.early;
    await withStore(async (store) => {
      const state = await loadRunState(store, "run-1");
      // Other stages keep the marker; a (re)scan clears it while the status reads 'processing'.
      await store.startDocumentStage(state, "d-early", "page-index");
      expect(await marker()).toBe(true);
      await store.startDocumentStage(state, "d-early", "pii-detect");
      expect(await marker()).toBe(false);
      await store.markDocumentLexicalSearchable("d-early");
      expect(await marker()).toBe(true);
    });
  });
});

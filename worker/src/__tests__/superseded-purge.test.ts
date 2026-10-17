
import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

import { drainDocumentCleanupQueue, purgeSupersededDocuments, type DeleteVectorRows } from "../db/superseded-purge.js";


let db: PGlite;
let server: PGLiteSocketServer;
let sql: postgres.Sql<Record<string, unknown>>;

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  const port = served.port;
  sql = postgres(`postgres://postgres@127.0.0.1:${port}/postgres`, { max: 1, prepare: false, onnotice: () => {} });
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1')`;
  await sql`insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W')`;
}, 60_000);

afterAll(async () => {
  await sql?.end();
  await server?.stop();
  await db?.close();
});

beforeEach(async () => {
  await sql`delete from documents`;
  await sql`delete from kg_nodes`;
  await sql`delete from workspace_runs`;
  // The delete triggers just enqueued cleanup for the rows above.
  await sql`delete from document_cleanup_queue`;
  await sql`delete from storage_cleanup_queue`;
});

async function seedEntity(nodeId: string, chunkIds: string[]) {
  await sql`
    insert into kg_nodes (id, workspace_id, run_id, user_id, canonical_name, normalized_name, entity_type, mention_count, source_document_count)
    values (${nodeId}, 'w', 'run-1', 'u1', ${nodeId}, ${nodeId}, 'thing', ${chunkIds.length * 2}, ${chunkIds.length})
  `;
  for (const chunkId of chunkIds) {
    await sql`
      insert into chunk_entities (chunk_id, workspace_id, run_id, user_id, node_id, entity_name, entity_type, mention_count)
      values (${chunkId}, 'w', 'run-1', 'u1', ${nodeId}, ${nodeId}, 'thing', 2)
    `;
  }
}

async function seedRun(id: string) {
  await sql`
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, total_documents, pipeline)
    values (${id}, 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'completed', 1, '{}'::jsonb)
  `;
}

async function seedVersion(args: { id: string; runId: string; createdAt: string; dedupedFrom?: string }) {
  await sql`
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status,
      canonical_id, created_at, page_count, file_size, deduped_from_document_id)
    values (${args.id}, 'o1', 'u1', 'w', ${args.runId}, 'products.mdx', 'text/markdown', 'u1/src/raw/products.mdx',
      'queued', '/products', ${args.createdAt}, 2, 10, ${args.dedupedFrom ?? null})
  `;
  await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text) values (${`${args.id}-000`}, ${args.id}, ${args.runId}, 'u1', 0, 'hello')`;
  await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
    values (${`vi-${args.id}`}, ${args.id}, 'lancedb', 'b', 'p', 'model/x', 4)`;
}

function fakeStorage(keys: string[]) {
  const deleted: string[] = [];
  return {
    deleted,
    storage: {
      bucket: "b",
      async listKeys({ prefix }: { prefix: string }) {
        return { keys: keys.filter((key) => key.startsWith(prefix)) };
      },
      async deleteKeys(batch: string[]) {
        deleted.push(...batch);
      },
    },
  };
}

const options = (deleteVectorRows: DeleteVectorRows, graceSeconds = 0) => ({
  graceSeconds,
  batchSize: 10,
  deleteSources: false,
  lancedbRoot: "/tmp/lance",
  deleteVectorRows,
});

describe("superseded version purge", () => {
  it("swaps versions atomically, then deletes the old version's derived data but keeps its tombstone and source", async () => {
    await seedRun("run-1");
    await seedRun("run-2");
    await seedVersion({ id: "v1", runId: "run-1", createdAt: "2026-01-01" });
    await sql`update documents set status = 'completed' where id = 'v1'`;
    await seedVersion({ id: "v2", runId: "run-2", createdAt: "2026-01-02" });

    // While v2 processes, the corpus counts only v1.
    expect((await sql`select page_count::int as pages from workspace_corpus_stats where workspace_id = 'w'`)[0]).toEqual({ pages: 2 });
    await sql`update documents set status = 'completed' where id = 'v2'`;
    expect((await sql`select document_count::int as docs, page_count::int as pages from workspace_corpus_stats where workspace_id = 'w'`)[0])
      .toEqual({ docs: 1, pages: 2 });

    const vectorDeletes: Parameters<DeleteVectorRows>[0][] = [];
    const { storage, deleted } = fakeStorage([
      "u1/run-1/markdown/v1.md",
      "u1/run-1/images/v1/150dpi/page-1.png",
      "u1/run-1/markdown/other.md",
      "u1/src/raw/products.mdx",
    ]);
    const result = await purgeSupersededDocuments(sql, storage, options(async (args) => { vectorDeletes.push(args); }));

    expect(result).toEqual({ purged: 1, failed: 0 });
    expect(deleted.sort()).toEqual(["u1/run-1/images/v1/150dpi/page-1.png", "u1/run-1/markdown/v1.md"]);
    expect(vectorDeletes).toEqual([{ uri: "/tmp/lance/o1/vectors/model%2Fx/4", table: "chunks", documentIds: ["v1"] }]);
    const [v1] = await sql`select purged_at is not null as purged, superseded_by_document_id from documents where id = 'v1'`;
    expect(v1).toEqual({ purged: true, superseded_by_document_id: "v2" });
    expect(await sql`select document_id from document_chunks order by document_id`).toEqual([{ document_id: "v2" }]);
    expect(await sql`select document_id from vector_indexes order by document_id`).toEqual([{ document_id: "v2" }]);
    expect(await sql`select event_type, document_id from workspace_run_events where event_type = 'document.purged'`)
      .toEqual([{ event_type: "document.purged", document_id: "v2" }]);

    // Idempotent: nothing left to purge.
    expect(await purgeSupersededDocuments(sql, storage, options(async () => {}))).toEqual({ purged: 0, failed: 0 });
  });

  it("keeps shared artifacts and vectors while a dedup copy still depends on them", async () => {
    await seedRun("run-1");
    await seedRun("run-2");
    await seedRun("run-3");
    await seedVersion({ id: "v1", runId: "run-1", createdAt: "2026-01-01" });
    await sql`update documents set status = 'completed' where id = 'v1'`;
    await sql`
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, deduped_from_document_id)
      values ('copy', 'o1', 'u1', 'w', 'run-3', 'products.mdx', 'text/markdown', 'k', 'completed', 'v1')
    `;
    await seedVersion({ id: "v2", runId: "run-2", createdAt: "2026-01-02" });
    await sql`update documents set status = 'completed' where id = 'v2'`;

    let vectorDeletes = 0;
    const { storage, deleted } = fakeStorage(["u1/run-1/markdown/v1.md"]);
    expect(await purgeSupersededDocuments(sql, storage, options(async () => { vectorDeletes += 1; })))
      .toEqual({ purged: 1, failed: 0 });
    expect(deleted).toEqual([]);
    expect(vectorDeletes).toBe(0);
    expect(await sql`select document_id from document_chunks where document_id = 'v1'`).toEqual([]);
  });

  it("keeps storage artifacts a partial reprocess reuses but deletes the old vectors", async () => {
    await seedRun("run-1");
    await seedRun("run-2");
    await seedVersion({ id: "v1", runId: "run-1", createdAt: "2026-01-01" });
    await sql`update documents set status = 'completed' where id = 'v1'`;
    await seedVersion({ id: "v2", runId: "run-2", createdAt: "2026-01-02" });
    await sql`update documents set reused_from_document_id = 'v1' where id = 'v2'`;
    await sql`update documents set status = 'completed' where id = 'v2'`;

    const vectorDeletes: string[] = [];
    const { storage, deleted } = fakeStorage(["u1/run-1/markdown/v1.md"]);
    expect(await purgeSupersededDocuments(sql, storage, options(async (args) => { vectorDeletes.push(...args.documentIds); })))
      .toEqual({ purged: 1, failed: 0 });
    expect(deleted).toEqual([]);
    expect(vectorDeletes).toEqual(["v1"]);
    expect(await sql`select document_id from document_chunks where document_id = 'v1'`).toEqual([]);
  });

  it("reclaims reused artifacts once the last reusing version is purged too", async () => {
    await seedRun("run-1");
    await seedRun("run-2");
    await seedRun("run-3");
    await seedVersion({ id: "v1", runId: "run-1", createdAt: "2026-01-01" });
    await sql`update documents set status = 'completed' where id = 'v1'`;
    // v2 is a partial reprocess of v1: it reads v1's markdown.
    await seedVersion({ id: "v2", runId: "run-2", createdAt: "2026-01-02" });
    await sql`update documents set reused_from_document_id = 'v1' where id = 'v2'`;
    await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status, artifact_uri)
      values ('run-2', 'v2', 'extract-markdown', 'completed', 's3://b/u1/run-1/markdown/v1.md')`;
    await sql`update documents set status = 'completed' where id = 'v2'`;

    const { storage, deleted } = fakeStorage(["u1/run-1/markdown/v1.md", "u1/run-2/embeddings/v2.json"]);
    const opts = options(async () => {});
    expect(await purgeSupersededDocuments(sql, storage, opts)).toEqual({ purged: 1, failed: 0 });
    expect(deleted).toEqual([]);

    // A full reprocess replaces v2; purging v2 releases the last live reference to v1's files.
    await seedVersion({ id: "v3", runId: "run-3", createdAt: "2026-01-03" });
    await sql`update documents set status = 'completed' where id = 'v3'`;
    expect(await purgeSupersededDocuments(sql, storage, opts)).toEqual({ purged: 1, failed: 0 });
    expect(deleted.sort()).toEqual(["u1/run-1/markdown/v1.md", "u1/run-2/embeddings/v2.json"]);
  });

  it("drops embedding reuse refs into the embedding artifacts it deletes", async () => {
    await seedRun("run-1");
    await seedRun("run-2");
    await seedVersion({ id: "v1", runId: "run-1", createdAt: "2026-01-01" });
    await sql`update documents set status = 'completed' where id = 'v1'`;
    await seedVersion({ id: "v2", runId: "run-2", createdAt: "2026-01-02" });
    await sql`update documents set status = 'completed' where id = 'v2'`;
    await sql`delete from embedding_reuse_refs`;
    await sql`
      insert into embedding_reuse_refs (org_id, embed_key, artifact_uri, chunk_index) values
        ('o1', 'gone', 's3://b/u1/run-1/embeddings/v1.json', 0),
        ('o1', 'kept', 's3://b/u1/run-2/embeddings/v2.json', 0)
    `;

    const { storage, deleted } = fakeStorage(["u1/run-1/embeddings/v1.json"]);
    await purgeSupersededDocuments(sql, storage, options(async () => {}));

    expect(deleted).toEqual(["u1/run-1/embeddings/v1.json"]);
    expect(await sql`select embed_key from embedding_reuse_refs`).toEqual([{ embed_key: "kept" }]);
  });

  it("waits out the grace period and retries after an external delete fails", async () => {
    await seedRun("run-1");
    await seedRun("run-2");
    await seedVersion({ id: "v1", runId: "run-1", createdAt: "2026-01-01" });
    await sql`update documents set status = 'completed' where id = 'v1'`;
    await seedVersion({ id: "v2", runId: "run-2", createdAt: "2026-01-02" });
    await sql`update documents set status = 'completed' where id = 'v2'`;
    const { storage } = fakeStorage([]);

    expect(await purgeSupersededDocuments(sql, storage, options(async () => {}, 3600))).toEqual({ purged: 0, failed: 0 });

    const failing = await purgeSupersededDocuments(sql, storage, options(async () => { throw new Error("lance down"); }));
    expect(failing.purged).toBe(0);
    expect(failing.failed).toBeGreaterThan(0);
    expect(await sql`select count(*)::int as chunks from document_chunks where document_id = 'v1'`).toEqual([{ chunks: 1 }]);

    expect(await purgeSupersededDocuments(sql, storage, options(async () => {}))).toEqual({ purged: 1, failed: 0 });
  });

  it("retires failed older versions when a newer one succeeds, and late failures on arrival", async () => {
    await seedRun("run-1");
    await seedRun("run-2");
    await seedRun("run-3");
    await seedVersion({ id: "failed-old", runId: "run-1", createdAt: "2026-01-01" });
    await sql`update documents set status = 'failed' where id = 'failed-old'`;
    await seedVersion({ id: "late", runId: "run-2", createdAt: "2026-01-02" });
    await seedVersion({ id: "good", runId: "run-3", createdAt: "2026-01-03" });
    await sql`update documents set status = 'completed' where id = 'good'`;
    await sql`update documents set status = 'failed' where id = 'late'`;

    expect(await sql`select id, superseded_by_document_id from documents order by id`).toEqual([
      { id: "failed-old", superseded_by_document_id: "good" },
      { id: "good", superseded_by_document_id: null },
      { id: "late", superseded_by_document_id: "good" },
    ]);
    const { storage } = fakeStorage([]);
    expect(await purgeSupersededDocuments(sql, storage, options(async () => {}))).toEqual({ purged: 2, failed: 0 });
  });

  it("recomputes knowledge-graph counts and drops nodes left without mentions", async () => {
    await seedRun("run-1");
    await seedRun("run-2");
    await seedVersion({ id: "v1", runId: "run-1", createdAt: "2026-01-01" });
    await sql`update documents set status = 'completed' where id = 'v1'`;
    await seedVersion({ id: "v2", runId: "run-2", createdAt: "2026-01-02" });
    await seedEntity("only-old", ["v1-000"]);
    await seedEntity("shared", ["v1-000", "v2-000"]);
    await sql`update documents set status = 'completed' where id = 'v2'`;

    const { storage } = fakeStorage([]);
    await purgeSupersededDocuments(sql, storage, options(async () => {}));
    expect(await sql`select id, mention_count, source_document_count from kg_nodes order by id`)
      .toEqual([{ id: "shared", mention_count: 2, source_document_count: 1 }]);
  });

  it("never deletes another document's files through a dedup copy's inherited artifact URIs", async () => {
    await seedRun("run-1");
    await seedRun("run-2");
    await seedRun("run-3");
    await seedVersion({ id: "source", runId: "run-1", createdAt: "2026-01-01" });
    await sql`update documents set status = 'completed', canonical_id = null where id = 'source'`;
    await seedVersion({ id: "copy", runId: "run-2", createdAt: "2026-01-02", dedupedFrom: "source" });
    await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status, artifact_uri)
      values ('run-2', 'copy', 'extract-markdown', 'completed', 's3://b/u1/run-1/markdown/source.md')`;
    await sql`update documents set status = 'completed' where id = 'copy'`;
    await seedVersion({ id: "next", runId: "run-3", createdAt: "2026-01-03" });
    await sql`update documents set status = 'completed' where id = 'next'`;

    // This tests artifact ownership, independent of the millisecond clock's
    // strict grace-period boundary (superseded_at < now()).
    await sql`update documents set superseded_at = now() - interval '1 second' where superseded_at is not null`;
    const { storage, deleted } = fakeStorage(["u1/run-1/markdown/source.md", "u1/run-2/markdown/copy.md"]);
    await purgeSupersededDocuments(sql, storage, options(async () => {}));
    expect(deleted).toEqual(["u1/run-2/markdown/copy.md"]);
  });

  it("cleans storage, LanceDB and graph counts for documents deleted by hand", async () => {
    await seedRun("run-1");
    await sql`insert into kg_nodes (id, workspace_id, run_id, user_id, canonical_name, normalized_name, entity_type, mention_count)
      values ('gone', 'w', 'run-1', 'u1', 'gone', 'gone', 'thing', 2)`;
    await sql`
      insert into document_cleanup_queue (document_id, org_id, user_id, workspace_id, run_id, source_key,
        delete_source, keep_shared_artifacts, vector_targets, artifact_uris, kg_node_ids)
      values ('deleted', 'o1', 'u1', 'w', 'run-1', 'u1/src/raw/deleted.pdf', true, false,
        '[{"backend":"lancedb","embeddingModel":"model/x","dimension":4}]'::jsonb,
        array['s3://b/u1/run-1/markdown/deleted.md'], array['gone'])
    `;
    const vectorDeletes: Parameters<DeleteVectorRows>[0][] = [];
    const { storage, deleted } = fakeStorage(["u1/run-1/images/deleted/page-1.png", "u1/run-1/markdown/kept.md", "u1/src/raw/deleted.pdf"]);

    expect(await drainDocumentCleanupQueue(sql, storage, options(async (args) => { vectorDeletes.push(args); })))
      .toEqual({ purged: 1, failed: 0 });
    expect(deleted.sort()).toEqual(["u1/run-1/images/deleted/page-1.png", "u1/run-1/markdown/deleted.md", "u1/src/raw/deleted.pdf"]);
    expect(vectorDeletes).toEqual([{ uri: "/tmp/lance/o1/vectors/model%2Fx/4", table: "chunks", documentIds: ["deleted"] }]);
    expect(await sql`select id from kg_nodes`).toEqual([]);
    expect(await sql`select document_id from document_cleanup_queue`).toEqual([]);
  });

  it("keeps queue entries for retry when external cleanup fails", async () => {
    await sql`
      insert into document_cleanup_queue (document_id, org_id, user_id, workspace_id, vector_targets)
      values ('stuck', 'o1', 'u1', 'w', '[{"backend":"lancedb","embeddingModel":"m","dimension":4}]'::jsonb)
    `;
    const { storage } = fakeStorage([]);
    const failing = await drainDocumentCleanupQueue(sql, storage, options(async () => { throw new Error("lance down"); }));
    expect(failing.failed).toBeGreaterThan(0);
    expect(await sql`select attempts > 0 as retried, last_error from document_cleanup_queue`).toEqual([{ retried: true, last_error: "lance down" }]);
  });
});

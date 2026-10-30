import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import postgres from "postgres";
import { legacyEmbeddingLocations, legacyOrgTable } from "../stages/lancedb-legacy-layout.js";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Store } from "../db/store.js";
import {
  drainDocumentCleanupQueue,
  drainStorageCleanupQueue,
  workspaceVectorPrefixTarget,
  type DeleteVectorRows,
  type DropVectorTable,
  type SupersededPurgeOptions,
} from "../db/superseded-purge.js";
import { startMigratedPostgres } from "../test/migrated-postgres.js";
import type { ArtifactStore } from "../tools/storage.js";

/**
 * Data lifecycle (migration 0035, docs/data-deletion.md): every path that
 * deletes documents or runs enqueues external cleanup through the delete
 * triggers, and the sweep leaves no residual object-storage keys or LanceDB rows.
 */

let stop: () => Promise<void>;
let store: Store;
let sql: postgres.Sql<Record<string, unknown>>;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  // The PGlite socket serves one connection, so assertions share the store's.
  store = new Store(pg.url, 60_000);
  sql = (store as unknown as { sql: postgres.Sql<Record<string, unknown>> }).sql;
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x'), ('u2', 'B', 'b@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id, retain_document_versions) values ('o1', 'Org', 'org', 'u1', 1)`;
}, 60_000);

afterAll(async () => {
  await store?.close();
  await stop?.();
});

beforeEach(async () => {
  await sql`delete from upload_sessions`;
  await sql`delete from workspaces`;
  await sql`delete from document_cleanup_queue`;
  await sql`delete from storage_cleanup_queue`;
  await sql`delete from vector_index_outbox`;
  await sql`insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W'), ('keep', 'o1', 'u1', 'Keep')`;
});

const MODEL = { backend: "lancedb", embeddingModel: "model/x", dimension: 4 };
/** Workspace w's database for MODEL; every workspace has its own. */
const TABLE_URI = "/tmp/lance/o1/w/vectors-model%2Fx-4";
const KEEP_TABLE_URI = "/tmp/lance/o1/keep/vectors-model%2Fx-4";

async function seedRun(id: string, workspaceId = "w", status = "completed") {
  await sql`
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, total_documents, pipeline, artifacts)
    values (${id}, 'o1', 'u1', ${workspaceId}, 'bulk-upload', ${status}, ${status}, 1, '{}'::jsonb,
      ${sql.json({ "knowledge-graph": `s3://b/u1/${id}/graph/workspace-graph.json` })})
  `;
}

async function seedDocument(id: string, runId: string, workspaceId = "w", status = "completed") {
  await sql`
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status)
    values (${id}, 'o1', 'u1', ${workspaceId}, ${runId}, ${`${id}.pdf`}, 'application/pdf', ${`u1/up-${id}/raw/${id}.pdf`}, ${status})
  `;
  await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text)
    values (${`${id}-c0`}, ${id}, ${runId}, 'u1', 0, 'hello')`;
  await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
    values (${`vi-${id}`}, ${id}, 'lancedb', 'b', 'p', ${MODEL.embeddingModel}, ${MODEL.dimension})`;
  await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status, artifact_uri)
    values (${runId}, ${id}, 'extract-markdown', 'completed', ${`s3://b/u1/${runId}/markdown/${id}.md`})`;
}

/** Object storage and LanceDB fakes that really remove what they are asked to. */
function fakeExternalStores(keys: string[], vectorRows: Record<string, string[]>) {
  const objects = new Set(keys);
  const tables = new Map(Object.entries(vectorRows).map(([table, ids]) => [table, new Set(ids)]));
  const vectorDeleteCalls: Array<{ table: string; documentIds: string[] }> = [];
  const storage = {
    bucket: "b",
    async listKeys({ prefix, maxKeys }: { prefix: string; maxKeys?: number }) {
      return { keys: [...objects].filter((key) => key.startsWith(prefix)).slice(0, maxKeys ?? 10_000) };
    },
    async deleteKeys(batch: string[]) {
      for (const key of batch) objects.delete(key);
    },
  };
  const deleteVectorRows: DeleteVectorRows = async ({ uri, table, documentIds }) => {
    vectorDeleteCalls.push({ table: `${uri}#${table}`, documentIds: [...documentIds].sort() });
    for (const id of documentIds) tables.get(`${uri}#${table}`)?.delete(id);
  };
  const dropVectorTable: DropVectorTable = async ({ uri, table }) => {
    tables.delete(`${uri}#${table}`);
  };
  const options: SupersededPurgeOptions = {
    graceSeconds: 0,
    batchSize: 10,
    deleteSources: false,
    lancedbRoot: "/tmp/lance",
    deleteVectorRows,
    dropVectorTable,
    };
  return { objects, tables, vectorDeleteCalls, storage, options };
}

async function drainAll(stores: ReturnType<typeof fakeExternalStores>) {
  await drainDocumentCleanupQueue(sql, stores.storage, stores.options);
  await drainStorageCleanupQueue(sql, stores.storage, stores.options);
}

describe("delete triggers enqueue external cleanup", () => {
  it("cleans a replayed original after its delay without deleting the sealed source or other tenants", async () => {
    await seedRun("live");
    const original = "u1/upload/raw/original.pdf";
    const sealed = "u1/upload/raw/sealed-file.pdf";
    const other = "u2/upload/raw/original.pdf";
    await sql`insert into upload_sessions (id, user_id, org_id, status) values ('sealed-session', 'u1', 'o1', 'confirmed')`;
    await sql`insert into upload_session_files (id, session_id, filename, mime_type, source_key, upload_mode)
      values ('sealed-file', 'sealed-session', 'source.pdf', 'application/pdf', ${sealed}, 'single')`;
    const stores = fakeExternalStores([sealed, other], {});
    await sql`insert into storage_cleanup_queue (kind, org_id, target, payload, reason, not_before)
      values ('upload_original', 'o1', ${original}, ${sql.json({sealedKey: sealed})}, 'sealed_upload', now() + interval '1 day')`;
    stores.objects.add(original); // A replayed PUT after immediate deletion.
    await drainStorageCleanupQueue(sql, stores.storage, stores.options);
    expect(stores.objects.has(original)).toBe(true);
    await sql`update storage_cleanup_queue set not_before = now()`;
    const failing = {...stores.storage, deleteKeys: async () => { throw new Error("storage unavailable"); }};
    for (let failure = 0; failure < 11; failure++) {
      await sql`update storage_cleanup_queue set not_before = now()`;
      expect((await drainStorageCleanupQueue(sql, failing, stores.options)).failed).toBe(1);
    }
    expect((await sql`select * from storage_cleanup_queue`).length).toBe(1);
    await sql`update storage_cleanup_queue set not_before = now()`;
    await drainStorageCleanupQueue(sql, stores.storage, stores.options);
    expect([...stores.objects]).toEqual([sealed, other]);
    expect((await sql`select * from storage_cleanup_queue`).length).toBe(1);
    stores.objects.add(original); // A late PUT finishes after the first successful cleanup.
    await sql`update storage_cleanup_queue set not_before = now()`;
    await drainStorageCleanupQueue(sql, stores.storage, stores.options);
    expect([...stores.objects]).toEqual([sealed, other]);
    stores.objects.add(original);
    await sql`update storage_cleanup_queue set org_id = 'wrong-org', not_before = now()`;
    expect((await drainStorageCleanupQueue(sql, stores.storage, stores.options)).failed).toBe(1);
    expect(stores.objects.has(original)).toBe(true);
  });

  it("defers old run cleanup while an upload recovers, then protects the recovered run", async () => {
    const source = "u1/upload/raw/source.pdf";
    await sql`insert into upload_sessions (id, user_id, org_id, status) values ('recover', 'u1', 'o1', 'ingesting')`;
    await sql`insert into upload_session_files (id, session_id, filename, mime_type, source_key, upload_mode)
      values ('recover-file', 'recover', 'source.pdf', 'application/pdf', ${source}, 'single')`;
    await sql`insert into storage_cleanup_queue (kind, org_id, target, artifact_uris, reason)
      values ('storage_prefix', 'o1', 'u1/recover/', ${sql.array([source])}, 'run_creation')`;
    const stores = fakeExternalStores([source, 'u1/recover/markdown/new.md'], {});
    await drainAll(stores);
    expect([...stores.objects]).toEqual([source, 'u1/recover/markdown/new.md']);
    await seedRun('recover');
    await sql`update upload_sessions set status = 'confirmed' where id = 'recover'`;
    await sql`update storage_cleanup_queue set not_before = now()`;
    await drainAll(stores);
    expect([...stores.objects]).toEqual([source, 'u1/recover/markdown/new.md']);
    await sql`delete from workspace_runs where id = 'recover'`;
    await sql`update storage_cleanup_queue set not_before = now()`;
    await drainAll(stores);
    expect([...stores.objects]).toEqual([]);
  });

  it("keeps registered upload bytes when an old partial document is cleaned", async () => {
    await seedRun('partial');
    await seedDocument('partial-doc', 'partial');
    const source = 'u1/up-partial-doc/raw/partial-doc.pdf';
    await sql`insert into upload_sessions (id, user_id, org_id, status) values ('retry', 'u1', 'o1', 'ingesting')`;
    await sql`insert into upload_session_files (id, session_id, filename, mime_type, source_key, upload_mode)
      values ('retry-file', 'retry', 'source.pdf', 'application/pdf', ${source}, 'single')`;
    const stores = fakeExternalStores([source], {});
    await sql`delete from documents where id = 'partial-doc'`;
    await drainAll(stores);
    expect([...stores.objects]).toEqual([source]);
  });

  it("records a deleted document's vectors, artifacts, source and graph nodes before cascades remove them", async () => {
    await seedRun("r1");
    await seedDocument("d1", "r1");
    await sql`insert into kg_nodes (id, workspace_id, run_id, user_id, canonical_name, normalized_name, entity_type, mention_count)
      values ('n1', 'w', 'r1', 'u1', 'Acme', 'acme', 'org', 1)`;
    await sql`insert into chunk_entities (chunk_id, workspace_id, run_id, user_id, node_id, entity_name, entity_type, mention_count)
      values ('d1-c0', 'w', 'r1', 'u1', 'n1', 'Acme', 'org', 1)`;
    await sql`insert into vector_index_outbox (table_key, lance_uri, lance_table, org_id, document_id, run_id, artifact_key)
      values ('other#chunks', 'other', 'chunks', 'o1', 'd1', 'r1', 'k')`;

    await sql`delete from documents where id = 'd1'`;

    const [row] = await sql<Record<string, unknown>[]>`
      select org_id, run_id, source_key, delete_source, vector_targets, artifact_uris, kg_node_ids
      from document_cleanup_queue where document_id = 'd1'
    `;
    expect(row).toEqual({
      org_id: "o1",
      run_id: "r1",
      source_key: "u1/up-d1/raw/d1.pdf",
      delete_source: true,
      vector_targets: expect.arrayContaining([MODEL, { backend: "lancedb", uri: "other", table: "chunks" }]),
      artifact_uris: ["s3://b/u1/r1/markdown/d1.md"],
      kg_node_ids: ["n1"],
    });
    // A pending vector write for a deleted document is dropped, not written later.
    expect(await sql`select id from vector_index_outbox`).toEqual([]);
  });

  it("enqueues one storage prefix per deleted run, with a grace period while it was in flight", async () => {
    await seedRun("r-done");
    await seedRun("r-live", "w", "processing");
    await sql`delete from workspace_runs where id in ('r-done', 'r-live')`;

    expect(await sql`
      select target, artifact_uris, not_before > now() + interval '10 minutes' as delayed
      from storage_cleanup_queue order by target
    `).toEqual([
      { target: "u1/r-done/", artifact_uris: ["s3://b/u1/r-done/graph/workspace-graph.json"], delayed: false },
      { target: "u1/r-live/", artifact_uris: ["s3://b/u1/r-live/graph/workspace-graph.json"], delayed: true },
    ]);
  });

  it("covers every document and run when a workspace is deleted outright", async () => {
    await seedRun("r1");
    await seedRun("r2");
    await seedDocument("d1", "r1");
    await seedDocument("d2", "r2");
    await sql`delete from workspaces where id = 'w'`;

    expect(await sql`select document_id from document_cleanup_queue order by document_id`)
      .toEqual([{ document_id: "d1" }, { document_id: "d2" }]);
    expect(await sql`select target from storage_cleanup_queue order by target`)
      .toEqual([{ target: "u1/r1/" }, { target: "u1/r2/" }]);
  });
});

describe("run retention", () => {
  const retention = () =>
    store as unknown as {
      purgeExpiredArtifacts(storage: ArtifactStore, batchSize: number): Promise<void>;
      deleteExpiredRuns(batchSize: number): Promise<void>;
    };

  it("defaults new workspaces to 30-day document expiry and supports keeping indefinitely", async () => {
    expect((await sql`select run_retention_days from workspaces where id = 'w'`)[0].run_retention_days).toBe(30);
    await seedRun("old");
    await seedRun("recent");
    await seedDocument("d-old", "old");
    await seedDocument("d-recent", "recent");
    await sql`update workspace_runs set created_at = now() - interval '31 days' where id = 'old'`;
    await sql`update workspace_runs set created_at = now() - interval '29 days' where id = 'recent'`;
    await retention().deleteExpiredRuns(10);
    expect(await sql`select id from documents order by id`).toEqual([{ id: "d-recent" }]);
    await sql`update workspaces set run_retention_days = null where id = 'w'`;
    await sql`update workspace_runs set created_at = now() - interval '100 days' where id = 'recent'`;
    await retention().deleteExpiredRuns(10);
    expect(await sql`select id from documents`).toEqual([{ id: "d-recent" }]);
  });

  it("deletes expired runs with their documents and enqueues cleanup even without artifact retention", async () => {
    await seedRun("old");
    await seedRun("new");
    await seedDocument("d-old", "old");
    await seedDocument("d-new", "new");
    await sql`update documents set previous_version_id = 'd-old' where id = 'd-new'`;
    await sql`update workspaces set artifact_retention_days = null, run_retention_days = 2 where id = 'w'`;
    await sql`update workspace_runs set created_at = now() - interval '3 days' where id = 'old'`;

    await retention().deleteExpiredRuns(10);

    expect(await sql`select id from workspace_runs where workspace_id = 'w' order by id`).toEqual([{ id: "new" }]);
    expect(await sql`select id, previous_version_id from documents where workspace_id = 'w'`)
      .toEqual([{ id: "d-new", previous_version_id: null }]);
    expect(await sql`select document_id from document_cleanup_queue`).toEqual([{ document_id: "d-old" }]);
    expect(await sql`select target from storage_cleanup_queue`).toEqual([{ target: "u1/old/" }]);

    const stores = fakeExternalStores(
      ["u1/old/markdown/d-old.md", "u1/old/graph/workspace-graph.json", "u1/up-d-old/raw/d-old.pdf", "u1/new/markdown/d-new.md", "u1/up-d-new/raw/d-new.pdf"],
      { [`${TABLE_URI}#chunks`]: ["d-old", "d-new"] },
    );
    await drainAll(stores);
    expect([...stores.objects].sort()).toEqual(["u1/new/markdown/d-new.md", "u1/up-d-new/raw/d-new.pdf"]);
    expect([...stores.tables.get(`${TABLE_URI}#chunks`)!]).toEqual(["d-new"]);
  });

  it("hands vector targets to the sweep when artifact retention drops the vector index rows", async () => {
    await seedRun("old");
    await seedDocument("d-old", "old");
    await sql`update workspaces set artifact_retention_days = 1 where id = 'w'`;
    await sql`update workspace_runs set created_at = now() - interval '3 days' where id = 'old'`;

    await retention().purgeExpiredArtifacts({ bucket: "b", deleteKeys: async () => {} } as unknown as ArtifactStore, 10);

    expect(await sql`select document_id, delete_source, vector_targets from document_cleanup_queue`)
      .toEqual([{ document_id: "d-old", delete_source: false, vector_targets: [MODEL] }]);
    expect(await sql`select count(*)::int as count from documents where id = 'd-old'`).toEqual([{ count: 1 }]);
  });
});

describe("cleanup sweep", () => {
  it("leaves no residual keys or vectors after a workspace delete, in one vector delete per table", async () => {
    await seedRun("r1");
    await seedRun("r2");
    await seedRun("rk", "keep");
    for (const id of ["d1", "d2", "d3"]) await seedDocument(id, id === "d3" ? "r2" : "r1");
    await seedDocument("dk", "rk", "keep");
    const stores = fakeExternalStores(
      [
        "u1/r1/markdown/d1.md", "u1/r1/images/d1/page-1.png", "u1/r1/markdown/d2.md", "u1/r1/graph/workspace-graph.json",
        "u1/r2/markdown/d3.md", "u1/r2/vision/d3.json",
        "u1/up-d1/raw/d1.pdf", "u1/up-d2/raw/d2.pdf", "u1/up-d3/raw/d3.pdf",
        "u1/rk/markdown/dk.md", "u1/up-dk/raw/dk.pdf",
      ],
      { [`${TABLE_URI}#chunks`]: ["d1", "d2", "d3"], [`${KEEP_TABLE_URI}#chunks`]: ["dk"] },
    );

    await sql`delete from workspaces where id = 'w'`;
    await drainAll(stores);

    expect([...stores.objects].sort()).toEqual(["u1/rk/markdown/dk.md", "u1/up-dk/raw/dk.pdf"]);
    expect([...stores.tables.get(`${TABLE_URI}#chunks`)!]).toEqual([]);
    expect([...stores.tables.get(`${KEEP_TABLE_URI}#chunks`)!]).toEqual(["dk"]);
    expect(stores.vectorDeleteCalls).toEqual([{ table: `${TABLE_URI}#chunks`, documentIds: ["d1", "d2", "d3"] }]);
    expect(await sql`select count(*)::int as count from document_cleanup_queue`).toEqual([{ count: 0 }]);
    expect(await sql`select count(*)::int as count from storage_cleanup_queue`).toEqual([{ count: 0 }]);
  });

  it("keeps a raw source another document still uses", async () => {
    await seedRun("r1");
    await seedDocument("d1", "r1");
    await seedDocument("d2", "r1");
    await sql`update documents set source_key = 'u1/shared/raw/same.pdf' where id in ('d1', 'd2')`;
    const stores = fakeExternalStores(["u1/shared/raw/same.pdf", "u1/r1/markdown/d1.md"], {});

    await sql`delete from documents where id = 'd1'`;
    await drainAll(stores);
    expect([...stores.objects]).toEqual(["u1/shared/raw/same.pdf"]);
  });

  it("waits out the grace period for runs that were still in flight", async () => {
    await seedRun("live", "w", "processing");
    const stores = fakeExternalStores(["u1/live/markdown/late.md"], {});
    await sql`delete from workspace_runs where id = 'live'`;

    await drainAll(stores);
    expect([...stores.objects]).toEqual(["u1/live/markdown/late.md"]);

    await sql`update storage_cleanup_queue set not_before = now() - interval '1 second'`;
    await drainAll(stores);
    expect([...stores.objects]).toEqual([]);
  });

  it("drops a whole workspace vector table instead of deleting its documents row by row", async () => {
    await seedRun("r1");
    await seedDocument("d1", "r1");
    await seedRun("rk", "keep");
    await seedDocument("dk", "rk", "keep");
    await sql`insert into storage_cleanup_queue (kind, org_id, target, payload, reason)
      values ('vector_table', 'o1', 'o1|w|model/x|4', ${sql.json({ workspaceId: "w", embeddingModel: "model/x", dimension: 4 })}, 'workspace_deleted')`;
    await sql`insert into vector_index_tables (table_key) values (${`${TABLE_URI}#chunks`})`;
    const stores = fakeExternalStores([], { [`${TABLE_URI}#chunks`]: ["d1"], [`${KEEP_TABLE_URI}#chunks`]: ["dk"] });

    await sql`delete from workspaces where id = 'w'`;
    await drainAll(stores);

    expect(stores.vectorDeleteCalls).toEqual([]);
    expect([...stores.tables.keys()]).toEqual([`${KEEP_TABLE_URI}#chunks`]);
    expect(await sql`select table_key from vector_index_tables`).toEqual([]);
  });

  it("drops a deleted org's legacy org-level tables from cleanup rows queued before workspace databases", async () => {
    const legacy = [...legacyEmbeddingLocations("/tmp/lance", "o1", "model/x", 4), legacyOrgTable("/tmp/lance", "o1")];
    // Migration 0082 marks rows queued with the old payload shape.
    await sql`insert into storage_cleanup_queue (kind, org_id, target, payload, reason)
      values ('vector_table', 'o1', 'o1|model/x|4', ${sql.json({ embeddingModel: "model/x", dimension: 4, legacyLayout: true })}, 'org_deleted')`;
    const stores = fakeExternalStores([], Object.fromEntries([...legacy.map((location) => [`${location.uri}#${location.table}`, ["d1"]]), [`${KEEP_TABLE_URI}#chunks`, ["dk"]]]));

    await drainAll(stores);

    expect([...stores.tables.keys()]).toEqual([`${KEEP_TABLE_URI}#chunks`]);
    expect(await sql`select count(*)::int as count from storage_cleanup_queue`).toEqual([{ count: 0 }]);
  });

  it("purges everything under a deleted workspace's LanceDB root, and only that workspace's", async () => {
    const root = await mkdtemp(path.join(process.env.TMPDIR ?? tmpdir(), "lance-prefix-"));
    try {
      for (const file of ["o1/w/vectors-old%2Fmodel-8/chunks.lance/data.lance", "o1/w/vectors-model%2Fx-4/chunks.lance/x", "o1/keep/vectors-model%2Fx-4/chunks.lance/x"]) {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), "x");
      }
      const tableUri = `${root}/o1/w/vectors-model%2Fx-4`;
      await sql`insert into vector_index_tables (table_key, lance_uri, lance_table) values (${`${tableUri}#chunks`}, ${tableUri}, 'chunks')`;
      await sql`insert into storage_cleanup_queue (kind, org_id, target, payload, reason)
        values ('vector_prefix', 'o1', 'o1|w', ${sql.json({ workspaceId: "w" })}, 'workspace_deleted')`;
      const stores = fakeExternalStores([], {});
      await drainStorageCleanupQueue(sql, stores.storage, { ...stores.options, lancedbRoot: root });

      expect(await readdir(path.join(root, "o1"))).toEqual(["keep"]);
      expect(await sql`select count(*)::int as count from vector_index_tables`).toEqual([{ count: 0 }]);
      expect(await sql`select count(*)::int as count from storage_cleanup_queue`).toEqual([{ count: 0 }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves a workspace root to a local directory or a prefix in the artifact bucket only", () => {
    expect(workspaceVectorPrefixTarget("/data/lance/o1/w", "b")).toEqual({ kind: "local", path: "/data/lance/o1/w" });
    expect(workspaceVectorPrefixTarget("file:///data/lance/o1/w", "b")).toEqual({ kind: "local", path: "/data/lance/o1/w" });
    expect(workspaceVectorPrefixTarget("s3://b/lancedb/o1/w", "b")).toEqual({ kind: "bucket", prefix: "lancedb/o1/w/" });
    expect(workspaceVectorPrefixTarget("s3+ddb://b/o1/w", "b")).toEqual({ kind: "bucket", prefix: "o1/w/" });
    expect(workspaceVectorPrefixTarget("s3://other/lancedb/o1/w", "b")).toEqual({ kind: "unsupported" });
    expect(workspaceVectorPrefixTarget("s3://b/w", "b")).toEqual({ kind: "unsupported" });
    expect(workspaceVectorPrefixTarget("gs://b/lancedb/o1/w", "b")).toEqual({ kind: "unsupported" });
  });

  it("keeps artifacts a partial reprocess still reuses, then reclaims them with the last reference", async () => {
    await seedRun("r-old");
    await seedRun("r-new");
    await seedDocument("d-old", "r-old");
    await seedDocument("d-x", "r-old");
    await seedDocument("d-new", "r-new");
    // As seedReusedStageOutputs does: the new version points at the old version's artifacts.
    await sql`update documents set reused_from_document_id = 'd-old' where id = 'd-new'`;
    await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status, artifact_uri)
      values ('r-new', 'd-new', 'split-pages', 'completed', 's3://b/u1/r-old/images/d-old/manifest.json')`;
    const stores = fakeExternalStores(
      [
        "u1/r-old/markdown/d-old.md", "u1/r-old/images/d-old/manifest.json", "u1/r-old/images/d-old/page-1.png",
        "u1/r-old/markdown/d-x.md", "u1/r-new/markdown/d-new.md",
      ],
      { [`${TABLE_URI}#chunks`]: ["d-old", "d-x", "d-new"] },
    );

    // Retention removes the old run while the new version still reuses it.
    await sql`delete from documents where run_id = 'r-old'`;
    await sql`delete from workspace_runs where id = 'r-old'`;
    await drainAll(stores);

    expect([...stores.objects].sort()).toEqual([
      "u1/r-new/markdown/d-new.md", "u1/r-old/images/d-old/manifest.json", "u1/r-old/images/d-old/page-1.png",
      "u1/r-old/markdown/d-old.md",
    ]);
    // Vectors are never shared by a partial reprocess.
    expect([...stores.tables.get(`${TABLE_URI}#chunks`)!]).toEqual(["d-new"]);
    expect(await sql`select target, not_before > now() + interval '1 hour' as deferred from storage_cleanup_queue`)
      .toEqual([{ target: "u1/r-old/", deferred: true }]);

    // Deleting the last reference releases the old version's artifacts.
    await sql`delete from documents where id = 'd-new'`;
    await sql`delete from workspace_runs where id = 'r-new'`;
    await drainAll(stores);
    expect([...stores.objects]).toEqual([]);
    expect(await sql`select count(*)::int as count from storage_cleanup_queue`).toEqual([{ count: 0 }]);
  });

  it("keeps a deleted run's artifacts while a partial reprocess still reads them, then reclaims them", async () => {
    await seedRun("old");
    await seedRun("new");
    await seedDocument("v1", "old");
    await seedDocument("v2", "new");
    await sql`update documents set reused_from_document_id = 'v1' where id = 'v2'`;
    // The partial reprocess seeded v2's stage state with v1's artifact URI.
    await sql`update document_run_stage_states set artifact_uri = 's3://b/u1/old/markdown/v1.md' where document_id = 'v2'`;
    const stores = fakeExternalStores(
      ["u1/old/markdown/v1.md", "u1/old/images/v1/page-1.png", "u1/old/classify/other.json"],
      { [`${TABLE_URI}#chunks`]: ["v1", "v2"] },
    );

    await sql`delete from documents where id = 'v1'`;
    await sql`delete from workspace_runs where id = 'old'`;
    await drainAll(stores);
    // v1's vectors go (v2 has its own); its artifacts stay as a unit.
    expect([...stores.tables.get(`${TABLE_URI}#chunks`)!]).toEqual(["v2"]);
    expect([...stores.objects].sort()).toEqual(["u1/old/images/v1/page-1.png", "u1/old/markdown/v1.md"]);
    expect(await sql`select target, not_before > now() + interval '12 hours' as deferred from storage_cleanup_queue`)
      .toEqual([{ target: "u1/old/", deferred: true }]);

    // Deleting the last reference brings the prefix purge forward.
    await sql`delete from documents where id = 'v2'`;
    await drainAll(stores);
    expect([...stores.objects]).toEqual([]);
    expect(await sql`select count(*)::int as count from storage_cleanup_queue where target = 'u1/old/'`).toEqual([{ count: 0 }]);
  });

  it("refuses to purge a prefix wider than one run", async () => {
    await sql`insert into storage_cleanup_queue (kind, target, reason) values ('storage_prefix', 'u1/', 'test')`;
    const stores = fakeExternalStores(["u1/anything.json"], {});
    expect((await drainStorageCleanupQueue(sql, stores.storage, stores.options)).failed).toBe(1);
    expect([...stores.objects]).toEqual(["u1/anything.json"]);
    expect(await sql`select attempts, last_error from storage_cleanup_queue`)
      .toEqual([{ attempts: 1, last_error: expect.stringMatching(/unsafe storage prefix/i) }]);
  });
});

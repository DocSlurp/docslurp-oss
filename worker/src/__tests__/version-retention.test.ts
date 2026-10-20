import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

import { effectiveRetainedVersions } from "@docslurp/shared";
import { purgeSupersededDocuments, retentionActions, retentionCandidateChains, type DeleteVectorRows } from "../db/superseded-purge.js";

let db: PGlite;
let server: PGLiteSocketServer;
let sql: postgres.Sql<Record<string, unknown>>;

beforeAll(async () => {
  db = await createMigratedDatabase();
  const served = await serveOnRandomPort(db);
  server = served.server;
  sql = postgres(`postgres://postgres@127.0.0.1:${served.port}/postgres`, { max: 1, prepare: false, onnotice: () => {} });
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1')`;
  await sql`insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W')`;
  await sql`insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, total_documents, pipeline)
    values ('run', 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'completed', 1, '{}'::jsonb)`;
}, 60_000);

afterAll(async () => {
  await sql?.end();
  await server?.stop();
  await db?.close();
});

beforeEach(async () => {
  await sql`delete from documents`;
  await sql`delete from document_cleanup_queue`;
  await sql`delete from storage_cleanup_queue`;
  await sql`update organizations set plan_id = 'free', retain_document_versions = null where id = 'o1'`;
  await sql`update workspaces set retain_document_versions = null where id = 'w'`;
  await sql`update organizations set retention_changed_at = null, retention_swept_at = null`;
  await sql`update workspaces set retention_changed_at = null, retention_swept_at = null`;
});

/** Creates versions v1..vN of one canonical document; vN is current. */
async function seedChain(count: number, canonicalId = "/chain", prefix = "v") {
  for (let i = 1; i <= count; i += 1) {
    const id = `${prefix}${i}`;
    await sql`
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status,
        canonical_id, created_at, page_count, file_size)
      values (${id}, 'o1', 'u1', 'w', 'run', 'a.md', 'text/markdown', 'u1/src/a.md', 'queued',
        ${canonicalId}, ${`2026-01-${String(i).padStart(2, "0")}`}, 2, 10)
    `;
    await sql`insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text) values (${`${id}-0`}, ${id}, 'run', 'u1', 0, 'hello')`;
    await sql`insert into document_pages (id, document_id, run_id, user_id, page_number, text, token_estimate)
      values (${`${id}-p1`}, ${id}, 'run', 'u1', 1, 'page', 1)`;
    await sql`insert into vector_indexes (id, document_id, backend, bucket, path, embedding_model, dimension)
      values (${`vi-${id}`}, ${id}, 'lancedb', 'b', 'p', 'm', 4)`;
    await sql`update documents set status = 'completed' where id = ${id}`;
  }
}

// The app file is outside this package's tsconfig rootDir, so load it at runtime only.
type OrgStorage = { sourceBytes: number; pages: number };
async function getOrgStorage(orgId: string, db: unknown): Promise<OrgStorage> {
  const path = new URL("../../../server/src/services/billing/overview.ts", import.meta.url).href;
  const mod = (await import(/* @vite-ignore */ path)) as { getOrgStorage(orgId: string, db: unknown): Promise<OrgStorage> };
  return mod.getOrgStorage(orgId, db);
}

const storage = {
  bucket: "b",
  async listKeys() { return { keys: [] as string[] }; },
  async deleteKeys() {},
};

async function sweep(deleteVectorRows: DeleteVectorRows = async () => {}, billingEnforced = true) {
  return purgeSupersededDocuments(sql, storage, {
    graceSeconds: 0, batchSize: 50, deleteSources: false, lancedbRoot: "/tmp/lance", deleteVectorRows, billingEnforced,
  });
}

async function states() {
  const rows = await sql<{ id: string; purged: boolean; archived: boolean; chunks: number; pages: number }[]>`
    select d.id, d.purged_at is not null as purged, d.archived_at is not null as archived,
      (select count(*)::int from document_chunks c where c.document_id = d.id) as chunks,
      (select count(*)::int from document_pages p where p.document_id = d.id) as pages
    from documents d order by d.created_at
  `;
  return Object.fromEntries(rows.map((r) => [r.id, r]));
}

describe("retention-aware superseded purge", () => {
  it("a config re-index replaces its source without taking a retention slot", async () => {
    await sql`update organizations set plan_id = 'silver' where id = 'o1'`;
    await seedChain(2);
    await sweep();
    expect((await states()).v1).toMatchObject({ purged: false, archived: true });

    // Re-index of the current version v2: v3 supersedes v2 and records reindex_of.
    await sql`
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status,
        canonical_id, created_at, page_count, file_size, reindex_of, previous_version_id)
      values ('v3', 'o1', 'u1', 'w', 'run', 'a.md', 'text/markdown', 'u1/src/a.md', 'queued',
        '/chain', '2026-01-03', 2, 10, 'v2', 'v2')
    `;
    await sql`update documents set status = 'completed' where id = 'v3'`;
    const result = await sweep();
    const s = await states();
    // v2 (the re-indexed source) is purged; the older archived v1 keeps its slot; v3 is current.
    expect(s.v2!.purged).toBe(true);
    expect(s.v1).toMatchObject({ purged: false, archived: true });
    expect(s.v3).toMatchObject({ purged: false, archived: false });
    expect(result.purged).toBe(1);
    expect(await sweep()).toEqual({ purged: 0, failed: 0 });
  });

  it("an ordinary new upload still archives the previous version and purges the oldest", async () => {
    await sql`update organizations set plan_id = 'silver' where id = 'o1'`;
    await seedChain(3);
    await sweep();
    const s = await states();
    expect([s.v1!.purged, s.v2!.archived, s.v3!.archived]).toEqual([true, true, false]);
  });

  it("free plan keeps only the current version", async () => {
    await sql`update organizations set retain_document_versions = 5 where id = 'o1'`;
    await seedChain(3);
    await sweep();
    const s = await states();
    expect([s.v1!.purged, s.v2!.purged, s.v3!.purged]).toEqual([true, true, false]);
    expect(s.v2!.archived).toBe(false);
  });

  it("paid default keeps current plus one archived version with pages but no search data", async () => {
    await sql`update organizations set plan_id = 'silver' where id = 'o1'`;
    await seedChain(3);
    const deletes: string[] = [];
    const result = await sweep(async (a) => { deletes.push(...a.documentIds); });
    expect(result).toMatchObject({ purged: 1, archived: 1, failed: 0 });
    const s = await states();
    expect(s.v1!.purged).toBe(true);
    expect(s.v2).toMatchObject({ purged: false, archived: true, chunks: 0, pages: 1 });
    expect(s.v3).toMatchObject({ purged: false, archived: false, chunks: 1, pages: 1 });
    expect(deletes.sort()).toEqual(["v1", "v2"]);
    expect(await sql`select document_id from vector_indexes order by document_id`).toEqual([{ document_id: "v3" }]);
    // Idempotent.
    expect(await sweep()).toEqual({ purged: 0, failed: 0 });
  });

  it("org setting 5 archives four versions", async () => {
    await sql`update organizations set plan_id = 'gold', retain_document_versions = 5 where id = 'o1'`;
    await seedChain(6);
    await sweep();
    const s = await states();
    expect(["v1", "v2", "v3", "v4", "v5"].map((id) => s[id]!.archived)).toEqual([false, true, true, true, true]);
    expect(s.v1!.purged).toBe(true);
    expect(s.v6!.archived).toBe(false);
  });

  it("lowering retention purges the extra archived versions on the next sweep", async () => {
    await sql`update organizations set plan_id = 'silver', retain_document_versions = 5 where id = 'o1'`;
    await seedChain(5);
    await sweep();
    expect((await states()).v2!.archived).toBe(true);
    await sql`update organizations set retain_document_versions = 2 where id = 'o1'`;
    await sweep();
    const s = await states();
    expect([s.v1!.purged, s.v2!.purged, s.v3!.purged, s.v4!.purged, s.v5!.purged]).toEqual([true, true, true, false, false]);
    expect(s.v4!.archived).toBe(true);
  });

  it("workspace override wins over the org setting", async () => {
    await sql`update organizations set plan_id = 'silver', retain_document_versions = 5 where id = 'o1'`;
    await sql`update workspaces set retain_document_versions = 1 where id = 'w'`;
    await seedChain(3);
    await sweep();
    const s = await states();
    expect([s.v1!.purged, s.v2!.purged]).toEqual([true, true]);
  });

  it("keeps dedup-shared vector rows while copies are live", async () => {
    await sql`update organizations set plan_id = 'silver' where id = 'o1'`;
    await seedChain(2);
    await sql`
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, deduped_from_document_id)
      values ('copy', 'o1', 'u1', 'w', 'run', 'a.md', 'text/markdown', 'k', 'completed', 'v1')
    `;
    const deletes: string[] = [];
    await sweep(async (a) => { deletes.push(...a.documentIds); });
    expect(deletes).toEqual([]);
    const s = await states();
    expect(s.v1).toMatchObject({ archived: true, chunks: 0, pages: 1 });
  });

  it("archived versions keep no search data and stay superseded, so search paths exclude them", async () => {
    await sql`update organizations set plan_id = 'silver' where id = 'o1'`;
    await seedChain(2);
    await sql`insert into document_page_vectors (document_id, page_number, model, dims, bits, int8, scale, workspace_id, org_id)
      values ('v1', 1, 'img', 8, decode('00','hex'), decode('00','hex'), 1, 'w', 'o1')`;
    await sweep();
    const [row] = await sql`
      select d.archived_at is not null as archived, d.superseded_at is not null as superseded,
        (select count(*)::int from document_chunks where document_id = d.id) as chunks,
        (select count(*)::int from vector_indexes where document_id = d.id) as vectors,
        (select count(*)::int from document_page_vectors where document_id = d.id) as page_vectors
      from documents d where id = 'v1'`;
    expect(row).toEqual({ archived: true, superseded: true, chunks: 0, vectors: 0, page_vectors: 0 });
  });

  it("failed newest uploads do not take a retention slot", async () => {
    await sql`update organizations set plan_id = 'silver' where id = 'o1'`;
    await seedChain(2);
    await sql`insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, canonical_id, created_at)
      values ('bad', 'o1', 'u1', 'w', 'run', 'a.md', 'text/markdown', 'k', 'failed', '/chain', '2026-02-01')`;
    await sql`update documents set superseded_at = null, superseded_by_document_id = null where id = 'bad'`;
    await sweep();
    expect((await states()).v1).toMatchObject({ archived: true, purged: false });
  });

  it("SQL keep rule matches effectiveRetainedVersions across the plan/setting matrix", async () => {
    const settings = [null, 1, 3, 100];
    for (const plan of ["free", "silver", "gold", "platinum"]) {
      for (const org of settings) {
        for (const ws of settings) {
          await sql`delete from documents`;
          await sql`update organizations set plan_id = ${plan}, retain_document_versions = ${org} where id = 'o1'`;
          await sql`update workspaces set retain_document_versions = ${ws} where id = 'w'`;
          const keep = effectiveRetainedVersions({ planId: plan, orgSetting: org, workspaceSetting: ws, billingEnforced: true });
          for (const billingEnforced of [true, false]) {
            await sql`delete from documents`;
            const expected = effectiveRetainedVersions({ planId: plan, orgSetting: org, workspaceSetting: ws, billingEnforced });
            await seedChain(5);
            await sweep(async () => {}, billingEnforced);
            const s = await states();
            const live = ["v1", "v2", "v3", "v4", "v5"].filter((id) => !s[id]!.purged).length;
            expect(live, `${plan} org=${org} ws=${ws} billing=${billingEnforced}`).toBe(Math.min(5, expected));
          }
          void keep;
        }
      }
    }
  }, 120_000);

  it("already-archived chains produce no actions and a single query per sweep", async () => {
    await sql`update organizations set plan_id = 'silver' where id = 'o1'`;
    for (let i = 0; i < 30; i += 1) await seedChain(2, `/c${i}`, `c${i}-`);
    await sweep();
    expect(await sql`select count(*)::int as n from documents where archived_at is not null`).toEqual([{ n: 30 }]);
    expect(await retentionActions(sql, 0, 50)).toEqual([]);
    let queries = 0;
    const counting = new Proxy(sql, {
      apply(target, thisArg, args) {
        const pending = Reflect.apply(target as never, thisArg, args) as PromiseLike<unknown>;
        const then = pending.then.bind(pending);
        // Count only queries that are actually executed (fragments composed into another query are not).
        pending.then = ((...a: Parameters<typeof then>) => { queries += 1; return then(...a); }) as typeof pending.then;
        return pending;
      },
    }) as typeof sql;
    expect(await retentionActions(counting, 0, 50, { billingEnforced: true })).toEqual([]);
    expect(queries).toBe(1);
  }, 60_000);

  it("archived versions keep counting toward org storage; purging removes them", async () => {
    await sql`update organizations set plan_id = 'silver', retain_document_versions = 2 where id = 'o1'`;
    await seedChain(3);
    const live = await getOrgStorage("o1", sql);
    expect(live).toMatchObject({ sourceBytes: 10, pages: 2 });
    await sweep();
    // v3 live + v2 archived (v1 purged): 2 docs of 10 bytes / 2 pages.
    expect(await getOrgStorage("o1", sql)).toMatchObject({ sourceBytes: 20, pages: 4 });
    await sql`update organizations set retain_document_versions = 1 where id = 'o1'`;
    await sweep();
    expect(await getOrgStorage("o1", sql)).toMatchObject({ sourceBytes: 10, pages: 2 });
  });

  async function insertVersion(id: string, status: string, createdAt: string, extra: { reindexOf?: string; supersede?: boolean } = {}) {
    await sql`
      insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status,
        canonical_id, created_at, page_count, file_size, reindex_of)
      values (${id}, 'o1', 'u1', 'w', 'run', 'a.md', 'text/markdown', 'u1/src/a.md', ${status},
        '/chain', ${createdAt}, 2, 10, ${extra.reindexOf ?? null})`;
  }

  it("a queued re-index child takes no slot and evicts no archived version", async () => {
    await sql`update organizations set plan_id = 'silver' where id = 'o1'`;
    await seedChain(2);
    await sweep();
    await insertVersion("child", "queued", "2026-01-05", { reindexOf: "v2" });
    await sweep();
    const s = await states();
    expect(s.v1).toMatchObject({ purged: false, archived: true });
    expect(s.v2).toMatchObject({ purged: false });
    expect(s.child).toMatchObject({ purged: false });
  });

  it("a blocked re-index child takes no slot and evicts no archived version", async () => {
    await sql`update organizations set plan_id = 'silver' where id = 'o1'`;
    await seedChain(2);
    await sweep();
    await insertVersion("child", "blocked", "2026-01-05", { reindexOf: "v2" });
    await sweep();
    expect((await states()).v1).toMatchObject({ purged: false, archived: true });
  });

  it("a superseded failed version is purged and never takes a slot", async () => {
    await sql`update organizations set plan_id = 'silver' where id = 'o1'`;
    await seedChain(1);
    await insertVersion("v2", "failed", "2026-01-02");
    await seedChainTail();
    await sweep();
    const s = await states();
    expect(s.v2).toMatchObject({ purged: true });
    expect(s.v1).toMatchObject({ purged: false, archived: true });
    expect(s.v3).toMatchObject({ purged: false, archived: false });
  });

  it("a cancelled re-index child superseded by a chained change is purged, not archived", async () => {
    await sql`update organizations set plan_id = 'silver' where id = 'o1'`;
    await seedChain(2);
    await sweep();
    await insertVersion("child", "cancelled", "2026-01-03", { reindexOf: "v2" });
    await insertVersion("v4", "queued", "2026-01-04");
    await sql`update documents set status = 'completed' where id = 'v4'`;
    await sql`update documents set superseded_at = now(), superseded_by_document_id = 'v4' where id = 'child'`;
    await sweep();
    const s = await states();
    expect(s.child).toMatchObject({ purged: true, archived: false });
    expect(s.v2).toMatchObject({ purged: false, archived: true });
    expect(s.v4).toMatchObject({ purged: false, archived: false });
  });

  it("unchanged archived chains are not candidates; a setting change makes them candidates until swept", async () => {
    await sql`update organizations set plan_id = 'silver', retain_document_versions = 3 where id = 'o1'`;
    for (let i = 0; i < 20; i += 1) await seedChain(2, `/c${i}`, `c${i}-`);
    await sweep();
    await sweep(); // an idle sweep marks the creation-time setting change as applied
    expect(await sql`select count(*)::int as n from documents where archived_at is not null`).toEqual([{ n: 20 }]);
    const candidates = async () => (await sql`select * from (${retentionCandidateChains(sql)}) c`).length;
    expect(await candidates()).toBe(0);
    await sql`update organizations set retain_document_versions = 1 where id = 'o1'`;
    expect(await candidates()).toBe(20);
    await sweep();
    expect(await sql`select count(*)::int as n from documents where purged_at is not null`).toEqual([{ n: 20 }]);
    await sweep();
    expect(await candidates()).toBe(0);
    await sql`update workspaces set retain_document_versions = 2 where id = 'w'`;
    expect(await candidates()).toBe(0); // nothing non-purged remains to examine
  }, 60_000);

  it("without billing enforcement the free plan honours settings and defaults to two versions", async () => {
    await seedChain(3);
    await sweep(async () => {}, false);
    let s = await states();
    expect([s.v1!.purged, s.v2!.archived, s.v3!.archived]).toEqual([true, true, false]);
    await sql`delete from documents`;
    await sql`update organizations set retain_document_versions = 3 where id = 'o1'`;
    await seedChain(4);
    await sweep(async () => {}, false);
    s = await states();
    expect([s.v1!.purged, s.v2!.archived, s.v3!.archived, s.v4!.archived]).toEqual([true, true, true, false]);
  });

  it("with billing enforced the free plan still keeps one version", async () => {
    await sql`update organizations set retain_document_versions = 3 where id = 'o1'`;
    await seedChain(3);
    await sweep(async () => {}, true);
    const s = await states();
    expect([s.v1!.purged, s.v2!.purged, s.v3!.purged]).toEqual([true, true, false]);
  });

  async function seedChainTail() {
    // v3: a completed upload after the failed v2, superseding it.
    await insertVersion("v3", "queued", "2026-01-03");
    await sql`update documents set status = 'completed' where id = 'v3'`;
  }

  it("without an explicit option the sweep follows billing_runtime, not the worker's env", async () => {
    const run = async () => purgeSupersededDocuments(sql, storage, { graceSeconds: 0, batchSize: 50, deleteSources: false, lancedbRoot: "/tmp/lance", deleteVectorRows: async () => {} });
    await sql`update billing_runtime set metering_enforced = true`;
    await seedChain(3);
    await run();
    let s = await states();
    expect([s.v1!.purged, s.v2!.purged, s.v3!.purged]).toEqual([true, true, false]);
    await sql`delete from documents`;
    await sql`update billing_runtime set metering_enforced = false`;
    await sql`update organizations set retain_document_versions = 3 where id = 'o1'`;
    await seedChain(4);
    await run();
    s = await states();
    expect([s.v1!.purged, s.v2!.archived, s.v3!.archived, s.v4!.archived]).toEqual([true, true, true, false]);
  });

  it("purges archived predecessors after the current version is deleted", async () => {
    await sql`update organizations set plan_id = 'silver' where id = 'o1'`;
    await seedChain(2);
    await sweep();
    await sweep();
    expect((await states()).v1).toMatchObject({ archived: true, purged: false });
    await sql`delete from documents where id = 'v2'`;
    await sweep();
    expect((await states()).v1).toMatchObject({ purged: true });
  });
});

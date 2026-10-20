import type { PGlite } from "@electric-sql/pglite";
import type { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { Store } from "../db/store.js";
import { loadRunState } from "../pipeline/stage-execution.js";
import { createMigratedDatabase } from "../test/migrated-db.js";
import { serveOnRandomPort } from "../test/migrated-postgres.js";

let db: PGlite;
let server: PGLiteSocketServer;
let url: string;

beforeEach(() => {
  vi.stubEnv("DOCSLURP_DEFERRED_PROFILES", "1");
});

beforeAll(async () => {
  db = await createMigratedDatabase();
  await db.exec(`
    insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
    insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
    insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
      values ('up', 'o1', 'u1', 'w', 'upload', 'completed', 'completed', '{"indexingMode":"map"}', 1),
             ('bf', 'o1', 'u1', 'w', 'full-index', 'processing', 'page-embed', '{"indexingMode":"visual","stageSubset":["page-embed"]}', 1);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, canonical_id, version_number, indexing_mode, created_at)
      values ('src', 'o1', 'u1', 'w', 'up', 'a.pdf', 'application/pdf', 'k1', 'completed', 4, 'c1', 1, 'map', '2026-01-01');
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, canonical_id, version_number, previous_version_id, reused_from_document_id, indexing_mode, created_at)
      values ('tmp', 'o1', 'u1', 'w', 'bf', 'a.pdf', 'application/pdf', 'k1', 'processing', 4, 'c1', 2, 'src', 'src', 'visual', '2026-01-02');
    -- The source materialized pages 1-2 on demand.
    insert into document_page_states (document_id, page_number, state, materialized_by, fee_billed_run)
      select 'src', n, case when n <= 2 then 'indexed' else 'unseen' end, case when n <= 2 then 'query' end, case when n <= 2 then 'm1' end from generate_series(1,4) n;
    insert into document_pages (id, document_id, run_id, user_id, page_number, text, token_estimate)
      values ('src-page-0001', 'src', 'up', 'u1', 1, 'indexed page one', 4);
    -- The backfill embedded every page of the temporary version.
    insert into document_page_states (document_id, page_number, state, embedded_at, embedding_model, mapped)
      select 'tmp', n, 'unseen', now(), 'img-model', true from generate_series(1,4) n;
    insert into document_page_vectors (document_id, page_number, model, dims, bits, int8, scale, workspace_id, org_id)
      select 'tmp', n, 'img-model', 8, decode('00','hex'), decode('00','hex'), 1, 'w', 'o1' from generate_series(1,4) n;
    insert into document_maps (document_id, run_id, nodes) values ('tmp', 'bf', '[]'::jsonb);
  `);
  const served = await serveOnRandomPort(db);
  server = served.server;
  url = `postgres://postgres@127.0.0.1:${served.port}/postgres`;
}, 120_000);

afterAll(async () => {
  await server?.stop();
  await db?.close();
});

describe("mode-switch backfill completion (I7)", () => {
  it("re-keys locator artifacts onto the source and never supersedes it", async () => {
    const store = new Store(url, 60_000, { poolMax: 1 });
    try {
      const state = await loadRunState(store, "bf");
      await store.completeRun(state);
    } finally {
      await store.close();
    }
    const q = async <T>(text: string) => (await db.query<T>(text)).rows;
    const [src] = await q<{ superseded_at: string | null; indexing_mode: string; status: string }>(`select superseded_at, indexing_mode, status from documents where id = 'src'`);
    expect(src).toMatchObject({ superseded_at: null, indexing_mode: "visual", status: "completed" });
    const [tmp] = await q<{ superseded_at: string | null; canonical_id: string | null }>(`select superseded_at, canonical_id from documents where id = 'tmp'`);
    expect(tmp!.superseded_at).not.toBeNull();
    expect(tmp!.canonical_id).toBeNull();

    // Query-materialized pages stay indexed and keep their billing stamp; the backfill's embedded flags land on them.
    const pages = await q<{ page_number: number; state: string; fee_billed_run: string | null; embedded_at: string | null; embedding_model: string | null; mapped: boolean }>(
      `select page_number, state, fee_billed_run, embedded_at, embedding_model, mapped from document_page_states where document_id = 'src' order by page_number`);
    expect(pages.map((p) => p.state)).toEqual(["indexed", "indexed", "unseen", "unseen"]);
    expect(pages.map((p) => p.fee_billed_run)).toEqual(["m1", "m1", null, null]);
    expect(pages.every((p) => p.embedded_at !== null && p.embedding_model === "img-model" && p.mapped)).toBe(true);
    expect(await q(`select 1 from document_pages where document_id = 'src' and page_number = 1`)).toHaveLength(1);

    expect(await q(`select 1 from document_page_vectors where document_id = 'src'`)).toHaveLength(4);
    expect(await q(`select 1 from document_page_vectors where document_id = 'tmp'`)).toHaveLength(0);
    expect(await q(`select 1 from document_maps where document_id = 'src'`)).toHaveLength(1);
  });
});


async function completeRun(runId: string) {
  const store = new Store(url, 60_000, { poolMax: 1 });
  try {
    await store.completeRun(await loadRunState(store, runId));
  } finally {
    await store.close();
  }
}

/** A second source/temp pair with its own backfill run, so scenarios do not interfere. */
async function seedPair(tag: string, pages = 3) {
  await db.exec(`
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, total_documents)
      values ('bf-${tag}', 'o1', 'u1', 'w', 'full-index', 'processing', 'page-embed', '{"indexingMode":"visual","stageSubset":["page-embed"]}', 1);
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, canonical_id, version_number, indexing_mode, created_at)
      values ('src-${tag}', 'o1', 'u1', 'w', 'up', '${tag}.pdf', 'application/pdf', 'k-${tag}', 'completed', ${pages}, 'c-${tag}', 1, 'map', '2026-01-01');
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count, canonical_id, version_number, previous_version_id, reused_from_document_id, indexing_mode, created_at)
      values ('tmp-${tag}', 'o1', 'u1', 'w', 'bf-${tag}', '${tag}.pdf', 'application/pdf', 'k-${tag}', 'processing', ${pages}, 'c-${tag}', 2, 'src-${tag}', 'src-${tag}', 'visual', '2026-01-02');
    insert into document_page_states (document_id, page_number, state)
      select 'src-${tag}', n, 'unseen' from generate_series(1,${pages}) n;
    insert into document_page_states (document_id, page_number, state, embedded_at, embedding_model, mapped)
      select 'tmp-${tag}', n, 'unseen', now(), 'img-model', true from generate_series(1,${pages}) n;
    insert into document_page_vectors (document_id, page_number, model, dims, bits, int8, scale, workspace_id, org_id)
      select 'tmp-${tag}', n, 'img-model', 8, decode('00','hex'), decode('00','hex'), 1, 'w', 'o1' from generate_series(1,${pages}) n;
  `);
}

const rows = async <T>(text: string) => (await db.query<T>(text)).rows;

describe("backfill completion when the source changed mid-run", () => {
  it("retires the temporary version and completes the run when the source was deleted", async () => {
    await seedPair("del");
    await db.exec(`delete from documents where id = 'src-del'`);
    // The delete nulled the temp's links to its source.
    expect(await rows(`select reused_from_document_id from documents where id = 'tmp-del'`)).toEqual([{ reused_from_document_id: null }]);

    await completeRun("bf-del");

    const [tmp] = await rows<{ superseded_at: string | null; canonical_id: string | null }>(`select superseded_at, canonical_id from documents where id = 'tmp-del'`);
    expect(tmp!.superseded_at).not.toBeNull();
    expect(tmp!.canonical_id).toBeNull();
    const [run] = await rows<{ status: string }>(`select status from workspace_runs where id = 'bf-del'`);
    expect(run!.status).toBe("completed");
  });

  it("skips adoption and retires the temporary version when the source was superseded", async () => {
    await seedPair("sup");
    await db.exec(`update documents set superseded_at = now(), canonical_id = null where id = 'src-sup'`);

    await completeRun("bf-sup");

    // Nothing was re-keyed onto the superseded source, and its mode is untouched.
    expect(await rows(`select 1 from document_page_vectors where document_id = 'src-sup'`)).toHaveLength(0);
    expect(await rows(`select 1 from document_page_states where document_id = 'src-sup' and embedded_at is not null`)).toHaveLength(0);
    expect((await rows<{ indexing_mode: string }>(`select indexing_mode from documents where id = 'src-sup'`))[0]!.indexing_mode).toBe("map");
    const [tmp] = await rows<{ superseded_at: string | null; canonical_id: string | null }>(`select superseded_at, canonical_id from documents where id = 'tmp-sup'`);
    expect(tmp!.superseded_at).not.toBeNull();
    expect(tmp!.canonical_id).toBeNull();
  });

  it("skips a purged source", async () => {
    await seedPair("pur");
    await db.exec(`update documents set purged_at = now() where id = 'src-pur'`);
    await completeRun("bf-pur");
    expect(await rows(`select 1 from document_page_vectors where document_id = 'src-pur'`)).toHaveLength(0);
    expect((await rows<{ superseded_at: string | null }>(`select superseded_at from documents where id = 'tmp-pur'`))[0]!.superseded_at).not.toBeNull();
  });
});

describe("backfill adoption guards", () => {
  it("is a no-op while the deferred-profiles flag is off", async () => {
    vi.stubEnv("DOCSLURP_DEFERRED_PROFILES", "");
    await seedPair("off");
    await completeRun("bf-off");
    expect(await rows(`select 1 from document_page_vectors where document_id = 'src-off'`)).toHaveLength(0);
    // Neither the source's mode nor its liveness changed, and the temp is retired rather than superseding it.
    expect(await rows(`select indexing_mode, superseded_at, canonical_id, status from documents where id = 'src-off'`))
      .toEqual([{ indexing_mode: "map", superseded_at: null, canonical_id: "c-off", status: "completed" }]);
    const [tmp] = await rows<{ superseded_at: string | null; canonical_id: string | null }>(`select superseded_at, canonical_id from documents where id = 'tmp-off'`);
    expect(tmp!.superseded_at).not.toBeNull();
    expect(tmp!.canonical_id).toBeNull();
  });

  it("retires failed and cancelled temporary versions so no ghost keeps a canonical id", async () => {
    await seedPair("bad1");
    await seedPair("bad2");
    await seedPair("bad3");
    await db.exec(`
      update documents set status = 'failed' where id = 'tmp-bad1';
      update documents set status = 'cancelled' where id = 'tmp-bad2';
      delete from documents where id = 'src-bad3';
      update documents set status = 'failed' where id = 'tmp-bad3';
    `);
    for (const tag of ["bad1", "bad2", "bad3"]) await completeRun(`bf-${tag}`);
    for (const tag of ["bad1", "bad2", "bad3"]) {
      const [tmp] = await rows<{ superseded_at: string | null; canonical_id: string | null; status: string }>(`select superseded_at, canonical_id, status from documents where id = 'tmp-${tag}'`);
      expect(tmp!.canonical_id, tag).toBeNull();
      expect(tmp!.superseded_at, tag).not.toBeNull();
    }
    // The failure stays visible, and live sources were left alone.
    expect((await rows<{ status: string }>(`select status from documents where id = 'tmp-bad1'`))[0]!.status).toBe("failed");
    expect(await rows(`select 1 from documents where id in ('src-bad1','src-bad2') and superseded_at is null`)).toHaveLength(2);
    expect(await rows(`select 1 from document_page_vectors where document_id in ('src-bad1','src-bad2')`)).toHaveLength(0);
  });

  it("keeps the source's page text for pages it has indexed even when the temporary pass blocked them", async () => {
    await seedPair("pii");
    await db.exec(`
      update document_page_states set state = 'indexed', materialized_by = 'query' where document_id = 'src-pii' and page_number = 1;
      update document_page_states set state = 'blocked-pii' where document_id = 'tmp-pii' and page_number in (1, 2);
      insert into document_pages (id, document_id, run_id, user_id, page_number, text, token_estimate)
        values ('src-pii-page-0001', 'src-pii', 'up', 'u1', 1, 'indexed one', 3), ('src-pii-page-0002', 'src-pii', 'up', 'u1', 2, 'coarse two', 3);
    `);
    await completeRun("bf-pii");
    const pages = await rows<{ page_number: number }>(`select page_number from document_pages where document_id = 'src-pii' order by page_number`);
    expect(pages.map((p) => p.page_number)).toEqual([1]);
    const states = await rows<{ page_number: number; state: string }>(`select page_number, state from document_page_states where document_id = 'src-pii' order by page_number`);
    expect(states.map((p) => p.state)).toEqual(["indexed", "blocked-pii", "unseen"]);
  });
});

import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Search availability reads the trigger-maintained documents.chunk_count and
 * documents.stored_page_count (migration 0063) instead of counting chunk and
 * page rows on every search. These checks build fixtures through the same kinds
 * of writes the worker and server make, then compare loadSearchAvailability with
 * the previous row-counting query, which stays here as the reference.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let eligibility: typeof import("../search/eligibility.js");
let loadSearchAvailability: typeof import("../search/session-setup.js").loadSearchAvailability;

beforeAll(async () => {
  const pg = await startMigratedPostgres();
  stop = pg.stop;
  sql = postgres(pg.url, { max: 1, prepare: false, onnotice: () => {} }) as unknown as postgres.Sql<Record<string, unknown>>;
  vi.doMock("../db.js", () => ({ sql }));
  await sql`insert into "user"(id, name, email) values ('u1', 'A', 'a@x')`;
  await sql`insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1')`;
  await sql`insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W'), ('w2', 'o1', 'u1', 'Other')`;
  eligibility = await import("../search/eligibility.js");
  ({ loadSearchAvailability } = await import("../search/session-setup.js"));
}, 120_000);

afterAll(async () => {
  await sql?.end();
  await stop?.();
});

beforeEach(async () => {
  await sql`delete from document_pages`;
  await sql`delete from document_run_stage_states`;
  await sql`delete from document_chunks`;
  await sql`delete from documents`;
  await sql`delete from workspace_runs`;
});

/** The pre-0063 query: counts document_pages and document_chunks rows per search. */
async function legacyAvailability(args: { workspaceId: string; runId?: string }) {
  const { fullyIndexedDocument, earlyLexicalDocument, servableInProgressVersion } = eligibility;
  const [row] = await sql`
    with scoped_runs as (
      select id, status, lease_expires_at
      from workspace_runs
      where workspace_id = ${args.workspaceId}
        and (${args.runId ?? null}::text is null or id = ${args.runId ?? null})
    ),
    scoped_docs as (
      select d.id, d.run_id, d.page_count, d.status, d.workspace_id, d.canonical_id, d.created_at, d.superseded_at,
        ${fullyIndexedDocument("d")} as fully_indexed,
        ${earlyLexicalDocument("d")} as keyword_only
      from documents d
      join scoped_runs runs on runs.id = d.run_id
      where d.superseded_at is null
        and d.status <> 'pii_blocked'
    ),
    page_stage as (
      select distinct states.document_id
      from document_run_stage_states states
      join scoped_runs runs on runs.id = states.run_id
      where states.stage_name = 'page-index'
        and states.status = 'completed'
    ),
    page_counts as (
      select document_id, count(*)::int as page_count
      from document_pages
      where run_id in (select id from scoped_runs)
      group by document_id
    ),
    chunk_counts as (
      select document_id, count(*)::int as chunk_count
      from document_chunks
      where run_id in (select id from scoped_runs)
      group by document_id
    ),
    classified as (
      select docs.*,
        runs.status as run_status,
        runs.lease_expires_at,
        page_stage.document_id is not null as page_indexed,
        page_stage.document_id is not null and not docs.fully_indexed and not docs.keyword_only
          and coalesce(page_counts.page_count, 0) > 0
          and ${servableInProgressVersion("docs")} as page_only,
        coalesce(page_counts.page_count, 0) as stored_pages,
        coalesce(chunk_counts.chunk_count, 0) as chunk_count
      from scoped_runs runs
      left join scoped_docs docs on docs.run_id = runs.id
      left join page_stage on page_stage.document_id = docs.id
      left join page_counts on page_counts.document_id = docs.id
      left join chunk_counts on chunk_counts.document_id = docs.id
    )
    select
      count(distinct docs.id)::int as total_documents,
      count(distinct docs.id) filter (where docs.fully_indexed)::int as indexed_documents,
      count(distinct docs.id) filter (where docs.page_indexed)::int as page_indexed_documents,
      count(distinct docs.id) filter (where docs.page_only)::int as page_only_documents,
      count(distinct docs.id) filter (where docs.keyword_only)::int as keyword_only_documents,
      count(distinct docs.id) filter (
        where docs.fully_indexed or docs.keyword_only or docs.page_only
      )::int as searchable_documents,
      count(distinct docs.id) filter (
        where coalesce(docs.status, '') not in ('completed', 'failed', 'cancelled')
          and (
            docs.run_status = 'queued'
            or (docs.run_status = 'processing' and coalesce(docs.lease_expires_at, to_timestamp(0)) >= now())
          )
      )::int as in_progress_documents,
      count(distinct docs.id) filter (
        where coalesce(docs.status, '') = 'failed'
          or docs.run_status = 'failed'
          or (docs.run_status = 'processing' and coalesce(docs.lease_expires_at, to_timestamp(0)) < now())
      )::int as failed_documents,
      coalesce(sum(docs.page_count), 0)::int as total_pages,
      coalesce(sum(
        case
          when docs.fully_indexed or docs.keyword_only then greatest(coalesce(docs.page_count, 0), docs.stored_pages)
          when docs.page_only then docs.stored_pages
          else 0
        end
      ), 0)::int as searchable_pages,
      coalesce(sum(docs.chunk_count) filter (where docs.fully_indexed or docs.keyword_only), 0)::int as indexed_chunk_count,
      (select count(*) from scoped_runs where status = 'queued')::int as queued_runs,
      (
        select count(*) from scoped_runs
        where status = 'processing' and coalesce(lease_expires_at, to_timestamp(0)) >= now()
      )::int as processing_runs,
      (select count(*) from scoped_runs where status = 'failed')::int as failed_runs,
      (
        select count(*) from scoped_runs
        where status = 'processing' and coalesce(lease_expires_at, to_timestamp(0)) < now()
      )::int as stalled_runs
    from classified docs
  `;
  return row;
}

let clock = 0;

async function run(id: string, args: { status?: string; workspaceId?: string; leaseMinutes?: number } = {}) {
  await sql`
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, lease_expires_at)
    values (${id}, 'o1', 'u1', ${args.workspaceId ?? "w"}, 'bulk-upload', ${args.status ?? "processing"}, 'embed', '{}'::jsonb,
      now() + make_interval(mins => ${args.leaseMinutes ?? 5}))
  `;
}

async function doc(id: string, args: {
  runId: string;
  status: string;
  pages?: number;
  canonicalId?: string;
  lexical?: boolean;
  workspaceId?: string;
}) {
  clock += 1;
  await sql`
    insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status,
      page_count, canonical_id, lexical_searchable_at, created_at)
    values (${id}, 'o1', 'u1', ${args.workspaceId ?? "w"}, ${args.runId}, ${`${id}.pdf`}, 'application/pdf', ${`raw/${id}`},
      ${args.status}, ${args.pages ?? 4}, ${args.canonicalId ?? null}, ${args.lexical ? new Date() : null},
      to_timestamp(${1_800_000_000 + clock}))
  `;
}

/** One multi-row INSERT, like the worker's batched insertChunks. */
async function chunks(documentId: string, runId: string, count: number, from = 0) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `${documentId}-c${from + i}`, document_id: documentId, run_id: runId, user_id: "u1",
    chunk_index: from + i, text: `chunk ${from + i}`, heading_path: "{}", token_estimate: 2, metadata: "{}",
  }));
  await sql`insert into document_chunks ${sql(rows, "id", "document_id", "run_id", "user_id", "chunk_index", "text", "heading_path", "token_estimate", "metadata")}`;
}

async function pages(documentId: string, runId: string, count: number) {
  const rows = Array.from({ length: count }, (_, i) => ({
    id: `${documentId}-p${i + 1}`, document_id: documentId, run_id: runId, user_id: "u1", page_number: i + 1, text: `page ${i + 1}`,
  }));
  await sql`insert into document_pages ${sql(rows, "id", "document_id", "run_id", "user_id", "page_number", "text")}`;
}

async function pageIndexed(runId: string, documentId: string) {
  await sql`
    insert into document_run_stage_states (run_id, document_id, stage_name, status)
    values (${runId}, ${documentId}, 'page-index', 'completed')
  `;
}

/** Stored counters must equal the real row counts for every document. */
async function expectCountersExact() {
  const drift = await sql`
    select d.id, d.chunk_count, d.stored_page_count,
      (select count(*)::int from document_chunks c where c.document_id = d.id) as actual_chunks,
      (select count(*)::int from document_pages p where p.document_id = d.id) as actual_pages
    from documents d
  `;
  for (const row of drift) {
    expect({ id: row.id, chunks: row.chunk_count, pages: row.stored_page_count })
      .toEqual({ id: row.id, chunks: row.actual_chunks, pages: row.actual_pages });
  }
}

async function expectSameAsLegacy(scopes: Array<{ workspaceId: string; runId?: string }>) {
  await expectCountersExact();
  for (const scope of scopes) {
    expect(await loadSearchAvailability(scope)).toEqual(await legacyAvailability(scope));
  }
}

/** Every document state the availability block distinguishes, across three runs and two workspaces. */
async function mixedWorkspace() {
  await run("r-done", { status: "completed" });
  await doc("complete", { runId: "r-done", status: "completed", pages: 10 });
  await chunks("complete", "r-done", 25);
  // Page rows beyond page_count: searchable_pages takes the larger number.
  await doc("complete-extra-pages", { runId: "r-done", status: "completed", pages: 2 });
  await chunks("complete-extra-pages", "r-done", 3);
  await pages("complete-extra-pages", "r-done", 5);

  await run("r-live");
  await doc("in-progress", { runId: "r-live", status: "vision-extract", pages: 8 });
  await doc("keyword-only", { runId: "r-live", status: "graph-enrich", lexical: true, pages: 6 });
  await chunks("keyword-only", "r-live", 7);
  await doc("page-only", { runId: "r-live", status: "page-index", pages: 9 });
  await pages("page-only", "r-live", 4);
  await pageIndexed("r-live", "page-only");
  // Page-index done but no page rows stored yet: not page-only.
  await doc("page-stage-no-rows", { runId: "r-live", status: "page-index", pages: 3 });
  await pageIndexed("r-live", "page-stage-no-rows");
  await doc("failed", { runId: "r-live", status: "failed", pages: 5 });
  await chunks("failed", "r-live", 2);
  await pages("failed", "r-live", 2);
  await pageIndexed("r-live", "failed");
  await doc("pii", { runId: "r-live", status: "pii_blocked", pages: 4 });
  await chunks("pii", "r-live", 4);
  await doc("superseded", { runId: "r-live", status: "completed", pages: 4 });
  await chunks("superseded", "r-live", 6);
  await sql`update documents set superseded_at = now() where id = 'superseded'`;

  // A replacement in progress while its completed version serves search.
  await doc("v1", { runId: "r-done", status: "completed", canonicalId: "c1", pages: 3 });
  await chunks("v1", "r-done", 5);
  await doc("v2", { runId: "r-live", status: "page-index", canonicalId: "c1", lexical: true, pages: 3 });
  await chunks("v2", "r-live", 5);
  await pages("v2", "r-live", 3);
  await pageIndexed("r-live", "v2");

  // A stalled run: lease expired while processing.
  await run("r-stalled", { leaseMinutes: -10 });
  await doc("stalled", { runId: "r-stalled", status: "embed", lexical: true, pages: 2 });
  await chunks("stalled", "r-stalled", 1);
  await run("r-failed", { status: "failed" });
  await doc("orphan", { runId: "r-failed", status: "graph-enrich", lexical: true, pages: 2 });
  await chunks("orphan", "r-failed", 2);
  await run("r-queued", { status: "queued" });

  await run("r-other", { workspaceId: "w2" });
  await doc("elsewhere", { runId: "r-other", status: "completed", workspaceId: "w2", pages: 7 });
  await chunks("elsewhere", "r-other", 9);
}

const scopes = [
  { workspaceId: "w" },
  { workspaceId: "w", runId: "r-done" },
  { workspaceId: "w", runId: "r-live" },
  { workspaceId: "w", runId: "r-stalled" },
  { workspaceId: "w", runId: "r-failed" },
  { workspaceId: "w", runId: "r-queued" },
  { workspaceId: "w", runId: "r-other" },
  { workspaceId: "w2" },
  { workspaceId: "empty" },
];

describe("search availability from document counters", () => {
  it("matches the row-counting query for every document state", async () => {
    await mixedWorkspace();
    await expectSameAsLegacy(scopes);

    expect(await loadSearchAvailability({ workspaceId: "w" })).toMatchObject({
      // Superseded and PII-blocked documents are not counted.
      total_documents: 11,
      indexed_documents: 3,
      // keyword-only, plus stalled (its run is still marked processing).
      keyword_only_documents: 2,
      page_only_documents: 1,
      searchable_documents: 6,
      // failed, stalled (lease expired) and orphan (run failed).
      failed_documents: 3,
      total_pages: 53,
      // complete 10 + complete-extra-pages max(2, 5) + v1 3 + keyword-only 6 + page-only 4 + stalled 2.
      searchable_pages: 30,
      // complete 25 + complete-extra-pages 3 + v1 5 + keyword-only 7 + stalled 1.
      indexed_chunk_count: 41,
      queued_runs: 1,
      failed_runs: 1,
      stalled_runs: 1,
    });
  });

  it("stays exact through re-chunking, run purges, upserts, copies and document deletes", async () => {
    await mixedWorkspace();

    // Retry writes more chunks in a second batch, then drops the stale tail
    // (deleteStaleDocumentChunks).
    await chunks("keyword-only", "r-live", 4, 7);
    await sql`
      delete from document_chunks
      where document_id = 'keyword-only' and id <> all(${sql.array(["keyword-only-c0", "keyword-only-c1", "keyword-only-c8"])}::text[])
    `;
    // Upsert of existing chunk ids (insertChunks on conflict do update) does not double count.
    await sql`
      insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, token_estimate, metadata)
      select id, document_id, run_id, user_id, chunk_index, text || ' again', heading_path, token_estimate, metadata
      from document_chunks where document_id = 'complete'
      on conflict (id) do update set text = excluded.text
    `;
    // Copy chunks and pages from another document (stage reuse / run creation).
    await doc("reused", { runId: "r-live", status: "completed", pages: 10 });
    await sql`
      insert into document_pages (id, document_id, run_id, user_id, page_number, text)
      select gen_random_uuid()::text, 'reused', 'r-live', user_id, page_number, text
      from document_pages where document_id = 'complete-extra-pages'
    `;
    await sql`
      insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, token_estimate, metadata)
      select gen_random_uuid()::text, 'reused', 'r-live', user_id, chunk_index, text, heading_path, token_estimate, metadata
      from document_chunks where document_id = 'complete'
    `;
    // Per-row inserts (document review) and per-document delete.
    await sql`delete from document_pages where document_id = 'page-only'`;
    for (const n of [1, 2]) {
      await sql`insert into document_pages (id, document_id, run_id, user_id, page_number, text) values (${`page-only-r${n}`}, 'page-only', 'r-live', 'u1', ${n}, 'redo')`;
    }
    await expectSameAsLegacy(scopes);

    // Run-scoped purge (store.ts resetRun) of one run's chunks and pages.
    await sql`delete from document_chunks where run_id = 'r-done'`;
    await sql`delete from document_pages where run_id = 'r-done'`;
    await expectSameAsLegacy(scopes);

    // Deleting documents cascades to their chunks and pages without error.
    await sql`delete from documents where id in ('keyword-only', 'v2', 'reused')`;
    await expectSameAsLegacy(scopes);
    await sql`delete from workspace_runs where id = 'r-stalled'`;
    await expectSameAsLegacy(scopes);
  });
  it("follows chunk rows an upsert moves to another document", async () => {
    // A deduplicated embed artifact carries the first document's chunk ids, and
    // insertChunks upserts with `document_id = excluded.document_id`: the copy's
    // document takes over the rows (worker/src/stages/embed.ts).
    await mixedWorkspace();
    await doc("dedup-copy", { runId: "r-live", status: "completed", pages: 10 });
    await sql`
      insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, token_estimate, metadata)
      select id, 'dedup-copy', 'r-live', user_id, chunk_index, text, heading_path, token_estimate, metadata
      from document_chunks where document_id = 'complete' and chunk_index < 20
      on conflict (id) do update set document_id = excluded.document_id, run_id = excluded.run_id
    `;
    await sql`update document_chunks set document_id = 'complete', run_id = 'r-done' where id = 'complete-c0'`;
    await sql`update document_chunks set text = 'retitled' where document_id = 'dedup-copy'`;
    await expectSameAsLegacy(scopes);
  });

  it("backfills counters for rows written before the triggers existed", async () => {
    await mixedWorkspace();
    await sql`update documents set chunk_count = 0, stored_page_count = 0`;
    await sql`update documents set chunk_count = 99 where id = 'complete'`;
    const { readFileSync } = await import("node:fs");
    const migration = readFileSync(new URL("../../db/migrations/0063_document_chunk_page_counters.sql", import.meta.url), "utf8");
    await sql.begin(async (tx) => {
      for (const statement of migration.split("--> statement-breakpoint")) await tx.unsafe(statement);
    });
    await expectSameAsLegacy(scopes);
  });
});

describe("migration 0063 backfill", () => {
  it("counts chunks and pages that existed before the migration", async () => {
    const { createMigratedDatabase, applyRemainingMigrations } = await import("@docslurp/worker/testing");
    const db = await createMigratedDatabase({ stopBefore: "document_chunk_page_counters" });
    try {
      await db.exec(`
        insert into "user"(id, name, email) values ('u1', 'A', 'a@x');
        insert into organizations(id, name, slug, created_by_user_id) values ('o1', 'Org', 'org', 'u1');
        insert into workspaces(id, org_id, user_id, name) values ('w', 'o1', 'u1', 'W');
        insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline)
        values ('r', 'o1', 'u1', 'w', 'bulk-upload', 'completed', 'embed', '{}'::jsonb);
        insert into documents (id, org_id, user_id, workspace_id, run_id, filename, mime_type, source_key, status, page_count)
        values ('a', 'o1', 'u1', 'w', 'r', 'a.pdf', 'application/pdf', 'raw/a', 'completed', 3),
               ('b', 'o1', 'u1', 'w', 'r', 'b.pdf', 'application/pdf', 'raw/b', 'completed', 2),
               ('empty', 'o1', 'u1', 'w', 'r', 'e.pdf', 'application/pdf', 'raw/e', 'completed', 1);
        insert into document_pages (id, document_id, run_id, user_id, page_number, text)
        select 'a-p' || n, 'a', 'r', 'u1', n, 'p' from generate_series(1, 3) n;
        insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, token_estimate, metadata)
        select d || '-c' || n, d, 'r', 'u1', n, 't', '{}', 1, '{}'
        from (values ('a', 7), ('b', 2)) docs(d, total), generate_series(1, total) n;
      `);
      await applyRemainingMigrations(db, "document_chunk_page_counters");
      const { rows } = await db.query<{ id: string; chunk_count: number; stored_page_count: number }>(
        "select id, chunk_count, stored_page_count from documents order by id",
      );
      expect(rows).toEqual([
        { id: "a", chunk_count: 7, stored_page_count: 3 },
        { id: "b", chunk_count: 2, stored_page_count: 0 },
        { id: "empty", chunk_count: 0, stored_page_count: 0 },
      ]);
      // The triggers are live after the backfill.
      await db.exec("delete from document_chunks where id = 'a-c1'");
      const { rows: after } = await db.query<{ chunk_count: number }>("select chunk_count from documents where id = 'a'");
      expect(after[0]?.chunk_count).toBe(6);
    } finally {
      await db.close();
    }
  }, 120_000);
});

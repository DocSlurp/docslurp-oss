import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { startMigratedPostgres } from "@docslurp/worker/testing";

/**
 * Early lexical search against a database built from server/db/migrations: which
 * document versions keyword search serves before the index stage completes,
 * and what the search availability block reports while they process.
 */
let stop: () => Promise<void>;
let sql: postgres.Sql<Record<string, unknown>>;
let eligibility: typeof import("../search/eligibility.js");
let loadSearchAvailability: typeof import("../search/session-setup.js").loadSearchAvailability;
let deriveSearchAvailability: typeof import("../services/search.js").deriveSearchAvailability;

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
  ({ deriveSearchAvailability } = await import("../services/search.js"));
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

let clock = 0;

async function run(id: string, args: { status?: string; controlState?: string | null; workspaceId?: string } = {}) {
  await sql`
    insert into workspace_runs (id, org_id, user_id, workspace_id, kind, status, stage, pipeline, control_state, lease_expires_at)
    values (${id}, 'o1', 'u1', ${args.workspaceId ?? "w"}, 'bulk-upload', ${args.status ?? "processing"}, 'embed', '{}'::jsonb,
      ${args.controlState ?? null}, now() + interval '5 minutes')
  `;
}

/** Inserts a document (in creation order) with one chunk mentioning `word`. */
async function doc(id: string, args: {
  runId: string;
  status: string;
  word: string;
  canonicalId?: string;
  lexical?: boolean;
  pages?: number;
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
  await sql`
    insert into document_chunks (id, document_id, run_id, user_id, chunk_index, text, heading_path, token_estimate, metadata)
    values (${`${id}-c0`}, ${id}, ${args.runId}, 'u1', 0, ${`The ${args.word} clause applies.`}, '{}', 5, '{}'::jsonb)
  `;
}

async function keywordHits(word: string, enabled = true, workspaceId = "w"): Promise<string[]> {
  const rows = await sql<{ document_id: string }[]>`
    select c.document_id
    from document_chunks c
    join documents d on d.id = c.document_id
    where ${eligibility.lexicalSearchableDocument("d", enabled)}
      and d.workspace_id = ${workspaceId}
      and c.ts_content @@ websearch_to_tsquery('english', ${word})
    order by c.document_id
  `;
  return rows.map((row) => row.document_id);
}

describe("early lexical eligibility", () => {
  it("serves a first version's chunks once materialized, before completion", async () => {
    await run("r1");
    await doc("early", { runId: "r1", status: "graph-enrich", word: "indemnity", canonicalId: "c-early", lexical: true });
    await doc("embedding", { runId: "r1", status: "embed", word: "indemnity", canonicalId: "c-embedding" });

    expect(await keywordHits("indemnity")).toEqual(["early"]);
    // Flag off: only completed documents, as before.
    expect(await keywordHits("indemnity", false)).toEqual([]);
  });

  it("keeps serving the completed version while a replacement processes", async () => {
    await run("r-old", { status: "completed" });
    await doc("v1", { runId: "r-old", status: "completed", word: "warranty", canonicalId: "c1", lexical: true });
    await run("r-new");
    await doc("v2", { runId: "r-new", status: "page-index", word: "warranty", canonicalId: "c1", lexical: true });

    expect(await keywordHits("warranty")).toEqual(["v1"]);

    // The index stage's cutover: v2 completes and the trigger supersedes v1 atomically.
    await sql`update documents set status = 'completed' where id = 'v2'`;
    expect(await keywordHits("warranty")).toEqual(["v2"]);
  });

  it("serves only the newest of two in-progress versions of one source", async () => {
    await run("ra");
    await run("rb");
    await doc("older", { runId: "ra", status: "index", word: "escrow", canonicalId: "c2", lexical: true });
    await doc("newer", { runId: "rb", status: "graph-enrich", word: "escrow", canonicalId: "c2", lexical: true });

    expect(await keywordHits("escrow")).toEqual(["newer"]);

    // A newer version whose run was cancelled hands search back to the older one.
    await sql`update workspace_runs set control_state = 'cancelled' where id = 'rb'`;
    expect(await keywordHits("escrow")).toEqual(["older"]);
  });

  it("excludes failed, cancelled, PII-blocked, superseded and dead-run documents", async () => {
    await run("live");
    await run("failed-run", { status: "failed" });
    await run("dead", { controlState: "dead-letter" });
    await doc("failed", { runId: "live", status: "failed", word: "arbitration", lexical: true });
    await doc("cancelled", { runId: "live", status: "cancelled", word: "arbitration", lexical: true });
    await doc("pii", { runId: "live", status: "pii_blocked", word: "arbitration", lexical: true });
    await doc("superseded", { runId: "live", status: "embed", word: "arbitration", lexical: true });
    await sql`update documents set superseded_at = now() where id = 'superseded'`;
    await doc("orphan", { runId: "failed-run", status: "graph-enrich", word: "arbitration", lexical: true });
    await doc("dead-letter", { runId: "dead", status: "graph-enrich", word: "arbitration", lexical: true });
    await doc("ok", { runId: "live", status: "graph-enrich", word: "arbitration", lexical: true });

    expect(await keywordHits("arbitration")).toEqual(["ok"]);
  });

  it("keeps workspace scoping", async () => {
    await run("r-w");
    await run("r-w2", { workspaceId: "w2" });
    await doc("here", { runId: "r-w", status: "embed", word: "novation", lexical: true });
    await doc("there", { runId: "r-w2", status: "embed", word: "novation", lexical: true, workspaceId: "w2" });

    expect(await keywordHits("novation", true, "w")).toEqual(["here"]);
    expect(await keywordHits("novation", true, "w2")).toEqual(["there"]);
  });
});

describe("search availability while documents process", () => {
  it("counts what search serves, not index-stage checkpoints", async () => {
    await run("r-done", { status: "completed" });
    await doc("done", { runId: "r-done", status: "completed", word: "alpha", pages: 10 });
    await run("r-live");
    await doc("keyword", { runId: "r-live", status: "graph-enrich", word: "beta", lexical: true, pages: 6 });
    await doc("waiting", { runId: "r-live", status: "vision-extract", word: "gamma", pages: 8 });
    // A stale index-stage checkpoint must not make a non-completed document "indexed".
    await sql`
      insert into document_run_stage_states (run_id, document_id, stage_name, status)
      values ('r-live', 'waiting', 'index', 'completed')
    `;

    const row = await loadSearchAvailability({ workspaceId: "w" });
    expect(row).toMatchObject({
      total_documents: 3,
      indexed_documents: 1,
      keyword_only_documents: 1,
      searchable_documents: 2,
      in_progress_documents: 2,
      total_pages: 24,
      searchable_pages: 16,
      indexed_chunk_count: 2,
      processing_runs: 1,
    });

    const availability = deriveSearchAvailability(row, { workspaceId: "w" });
    expect(availability).toMatchObject({
      status: "partial",
      isPartial: true,
      keywordOnly: true,
      coverage: { keywordOnlyDocuments: 1, pageOnlyDocuments: 0, searchablePages: 16, totalPages: 24 },
      message: "Searching 16 of 24 pages (2 of 3 documents); 2 documents still processing, 1 keyword-only until vector indexing finishes.",
    });
  });

  it("does not report a replacement's early chunks as searchable", async () => {
    await run("r-old", { status: "completed" });
    await doc("v1", { runId: "r-old", status: "completed", word: "delta", canonicalId: "c9", pages: 5 });
    await run("r-new");
    await doc("v2", { runId: "r-new", status: "graph-enrich", word: "delta", canonicalId: "c9", lexical: true, pages: 5 });

    const row = await loadSearchAvailability({ workspaceId: "w", runId: "r-new" });
    expect(row).toMatchObject({ total_documents: 1, keyword_only_documents: 0, searchable_documents: 0, in_progress_documents: 1 });
  });

  it("counts page-only coverage only for versions progressive page search serves", async () => {
    await run("r-old", { status: "completed" });
    await doc("v1", { runId: "r-old", status: "completed", word: "omega", canonicalId: "c10", pages: 2 });
    await run("r-new");
    await doc("v2", { runId: "r-new", status: "page-index", word: "omega", canonicalId: "c10", pages: 2 });
    await doc("broken", { runId: "r-new", status: "failed", word: "omega", pages: 2 });
    await doc("fresh", { runId: "r-new", status: "page-index", word: "omega", pages: 2 });
    for (const id of ["v2", "broken", "fresh"]) {
      await sql`insert into document_run_stage_states (run_id, document_id, stage_name, status) values ('r-new', ${id}, 'page-index', 'completed')`;
      await sql`insert into document_pages (id, document_id, run_id, user_id, page_number, text) values (${`${id}-p1`}, ${id}, 'r-new', 'u1', 1, 'omega page')`;
    }

    const row = await loadSearchAvailability({ workspaceId: "w", runId: "r-new" });
    // The replacement (completed sibling serves) and the failed document are not served from pages.
    expect(row).toMatchObject({ total_documents: 3, page_only_documents: 1, searchable_documents: 1, searchable_pages: 1 });
  });
});

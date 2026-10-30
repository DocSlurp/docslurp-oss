import type { Sql } from "postgres";

import type { PageLedgerState } from "@docslurp/shared";

/** A failed page is retried until it has been claimed this many times. */
export const MAX_PAGE_ATTEMPTS = 3;

/** Inserts an `unseen` ledger row for every physical page (idempotent, one statement). */
export async function ensurePageRows(sql: Sql, documentId: string, pageCount: number): Promise<void> {
  const count = Math.floor(pageCount);
  if (!Number.isFinite(count) || count < 1) return;
  await sql`
    insert into document_page_states (document_id, page_number)
    select ${documentId}, n from generate_series(1, ${count}::int) as n
    on conflict (document_id, page_number) do nothing
  `;
}

export interface ClaimPagesResult {
  /** Pages this run now owns and must materialize. */
  claimed: number[];
  /** Pages another run holds under an unexpired claim; wait for them. */
  awaiting: number[];
  /** Pages already indexed. `blocked-pii` and exhausted pages appear in no list. */
  ready: number[];
}

/**
 * Claims pages for a run in two statements. (a) One UPDATE ... RETURNING decides `claimed`:
 * `unseen`, `failed` with fewer than {@link MAX_PAGE_ATTEMPTS} attempts, in-flight pages whose
 * claim expired, and pages this run already holds. Every claim increments `attempts`.
 * (b) A fresh SELECT, taken after the update (so it sees any concurrent claimer's commit),
 * classifies the other requested pages: `awaiting` = held by another run under an unexpired
 * claim, `ready` = already `indexed`. `blocked-pii` pages and `failed` pages with
 * attempts >= {@link MAX_PAGE_ATTEMPTS} appear in no list.
 */
export async function claimPages(
  sql: Sql,
  args: {
    documentId: string;
    pages: number[];
    runId: string;
    ttlSeconds: number;
    reason: "query" | "full-index" | "backfill";
  },
): Promise<ClaimPagesResult> {
  const pages = [...new Set(args.pages.filter((p) => Number.isInteger(p) && p >= 1))].sort((a, b) => a - b);
  if (pages.length === 0) return { claimed: [], awaiting: [], ready: [] };
  const claimedRows = await sql<{ page_number: number }[]>`
    update document_page_states s
    set state = 'claimed',
        claimed_by_run = ${args.runId},
        claim_expires_at = now() + make_interval(secs => ${args.ttlSeconds}::double precision),
        materialized_by = ${args.reason},
        attempts = s.attempts + 1,
        failure_reason = null,
        updated_at = now()
    where s.document_id = ${args.documentId}
      and s.page_number = any(${pages}::int[])
      and (
        s.state = 'unseen'
        or (s.state = 'failed' and s.attempts < ${MAX_PAGE_ATTEMPTS})
        or (s.state in ('claimed', 'parsed', 'pii-checked')
            and (s.claimed_by_run = ${args.runId} or s.claim_expires_at is null or s.claim_expires_at <= now()))
      )
    returning s.page_number
  `;
  const claimed = claimedRows.map((r) => r.page_number).sort((a, b) => a - b);
  const rest = pages.filter((p) => !claimed.includes(p));
  const result: ClaimPagesResult = { claimed, awaiting: [], ready: [] };
  if (rest.length === 0) return result;
  const rows = await sql<{ page_number: number; state: string; held: boolean }[]>`
    select page_number, state, (claim_expires_at > now()) as held
    from document_page_states
    where document_id = ${args.documentId} and page_number = any(${rest}::int[])
    order by page_number
  `;
  for (const row of rows) {
    if (row.state === "indexed") result.ready.push(row.page_number);
    else if (row.held && ["claimed", "parsed", "pii-checked"].includes(row.state)) result.awaiting.push(row.page_number);
  }
  return result;
}

/**
 * Moves pages to `state` in one statement; terminal states release the claim. Returns the pages it moved.
 *
 * `claimedBy` fences the write to pages that run still holds: a run that stalled past its claim TTL (another run
 * re-claimed the page) moves nothing, so it can neither index nor bill a page it no longer owns.
 */
export async function markPages(
  sql: Sql,
  documentId: string,
  pages: number[],
  state: PageLedgerState,
  extra: { costCredits?: number; failureReason?: string; embeddingModel?: string; claimedBy?: string } = {},
): Promise<number[]> {
  if (pages.length === 0) return [];
  const releases = state === "indexed" || state === "failed" || state === "blocked-pii" || state === "unseen";
  const rows = await sql<{ page_number: number }[]>`
    update document_page_states
    set state = ${state},
        cost_credits = coalesce(${extra.costCredits ?? null}::numeric, cost_credits),
        failure_reason = ${state === "failed" || state === "blocked-pii" ? (extra.failureReason ?? null) : null},
        embedding_model = case when ${state} = 'indexed' then coalesce(${extra.embeddingModel ?? null}, embedding_model) else embedding_model end,
        claimed_by_run = case when ${releases} then null else claimed_by_run end,
        claim_expires_at = case when ${releases} then null else claim_expires_at end,
        updated_at = now()
    where document_id = ${documentId} and page_number = any(${pages}::int[])
      ${extra.claimedBy === undefined ? sql`` : sql`and claimed_by_run = ${extra.claimedBy}`}
    returning page_number
  `;
  return rows.map((row) => row.page_number).sort((a, b) => a - b);
}

export interface PageStateCount {
  total: number;
  indexed: number;
  mapped: number;
  embedded: number;
}

export async function pageStateCounts(sql: Sql, documentIds: string[]): Promise<Map<string, PageStateCount>> {
  const counts = new Map<string, PageStateCount>(
    documentIds.map((id) => [id, { total: 0, indexed: 0, mapped: 0, embedded: 0 }]),
  );
  if (documentIds.length === 0) return counts;
  const rows = await sql<{ document_id: string; total: number; indexed: number; mapped: number; embedded: number }[]>`
    select document_id,
           count(*)::int as total,
           (count(*) filter (where state = 'indexed'))::int as indexed,
           (count(*) filter (where mapped))::int as mapped,
           (count(*) filter (where embedded_at is not null))::int as embedded
    from document_page_states
    where document_id = any(${documentIds}::text[])
    group by document_id
  `;
  for (const row of rows) {
    counts.set(row.document_id, { total: row.total, indexed: row.indexed, mapped: row.mapped, embedded: row.embedded });
  }
  return counts;
}

/** The subset of `pages` already indexed, ascending. */
export async function indexedPages(sql: Sql, documentId: string, pages: number[]): Promise<number[]> {
  if (pages.length === 0) return [];
  const rows = await sql<{ page_number: number }[]>`
    select page_number from document_page_states
    where document_id = ${documentId} and state = 'indexed' and page_number = any(${pages}::int[])
    order by page_number
  `;
  return rows.map((row) => row.page_number);
}

/** Stamps `embedded_at`/`embedding_model` on the given pages in one statement (leaves `state` untouched). */
export async function markPagesEmbedded(sql: Sql, documentId: string, pages: number[], model: string): Promise<void> {
  if (pages.length === 0) return;
  await sql`
    update document_page_states
    set embedded_at = now(), embedding_model = ${model}, updated_at = now()
    where document_id = ${documentId} and page_number = any(${pages}::int[])
  `;
}

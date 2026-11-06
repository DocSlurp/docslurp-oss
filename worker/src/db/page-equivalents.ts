import type { JSONValue, Sql } from "postgres";

import { DEFAULT_PAGE_EQUIVALENT_ALLOWANCE } from "@docslurp/shared";

/** One page's measured equivalents (shared page-equivalents.ts): from its extracted text, its rendered area, or both. */
export interface PageEquivalentRow { pageNumber: number; text?: number; area?: number }

/**
 * Records pages that measured above one page (document_page_facts.text_equivalents / area_equivalents, migration 0130; a
 * stored value is never lowered; the measurement is kept whole) and raises documents.billing_pages to page_count plus every
 * page's extra billed equivalents: its text above `allowance` (shared billedPageEquivalents: 1 up to the allowance, its full
 * volume above it; 1 for formats billed by the whole-document text rule) or its area, whichever is larger. The
 * page fee, feature charges and spend authorization all read billing_pages, so a stuffed page bills the pages it holds.
 * Monotone and idempotent: a retry or a second measurement of the same page changes nothing unless it measured more.
 * Scoped to the run's own document. Returns the document's billing_pages after the update (null when it is not the run's).
 */
export async function recordPageEquivalents(
  sql: Sql<Record<string, unknown>>,
  args: { runId: string; documentId: string; rows: readonly PageEquivalentRow[]; allowance?: number },
): Promise<number | null> {
  const allowance = Math.max(1, Math.floor(args.allowance ?? DEFAULT_PAGE_EQUIVALENT_ALLOWANCE) || 1);
  const rows = args.rows
    .filter((row) => Number.isSafeInteger(row.pageNumber) && row.pageNumber >= 1)
    .map((row) => ({
      page_number: row.pageNumber,
      text_equivalents: Number.isFinite(row.text) && row.text! > 1 ? Math.floor(row.text!) : null,
      area_equivalents: Number.isFinite(row.area) && row.area! > 1 ? Math.floor(row.area!) : null,
    }))
    .filter((row) => row.text_equivalents !== null || row.area_equivalents !== null);
  if (rows.length > 0) {
    await sql`
      insert into document_page_facts (document_id, page_number, run_id, text_equivalents, area_equivalents)
      select d.id, r.page_number, ${args.runId}, r.text_equivalents, r.area_equivalents
      from jsonb_to_recordset(${sql.json(rows as unknown as JSONValue)}::jsonb) as r(page_number integer, text_equivalents integer, area_equivalents integer)
      join documents d on d.id = ${args.documentId} and d.run_id = ${args.runId} and d.deduped_from_document_id is null
      on conflict (document_id, page_number) do update
      set text_equivalents = nullif(greatest(coalesce(document_page_facts.text_equivalents, 0), coalesce(excluded.text_equivalents, 0)), 0),
          area_equivalents = nullif(greatest(coalesce(document_page_facts.area_equivalents, 0), coalesce(excluded.area_equivalents, 0)), 0)`;
  }
  const [updated] = await sql<{ billing_pages: number | null }[]>`
    with extra as (
      select coalesce(sum(greatest(
        case when coalesce(f.text_equivalents, 1) > ${allowance} then f.text_equivalents else 1 end,
        coalesce(f.area_equivalents, 1)) - 1), 0)::int as pages
      from document_page_facts f join documents d on d.id = f.document_id
      where f.document_id = ${args.documentId} and f.page_number between 1 and greatest(d.page_count, 1)
    )
    update documents d
    set billing_pages = greatest(coalesce(d.billing_pages, 0), d.page_count + extra.pages),
        billing_pages_method = case when d.page_count + extra.pages > coalesce(d.billing_pages, 0) then 'page-equivalents' else d.billing_pages_method end,
        updated_at = now()
    from extra
    where d.id = ${args.documentId} and d.run_id = ${args.runId} and d.deduped_from_document_id is null
      -- Only a page that measured above one changes anything: an empty Office file's measured 0 stays 0.
      and extra.pages > 0
    returning d.billing_pages`;
  if (updated) return updated.billing_pages === null ? null : Number(updated.billing_pages);
  const [current] = await sql<{ billing_pages: number | null }[]>`
    select billing_pages from documents where id = ${args.documentId} and run_id = ${args.runId}`;
  return current ? (current.billing_pages === null ? null : Number(current.billing_pages)) : null;
}

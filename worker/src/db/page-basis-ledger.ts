import type { Sql } from "postgres";

import { PAGE_READ_METRICS } from "@docslurp/shared";

import type { CountedImageFrames, MeasuredRunDocument, PageBasisLedger, PageBasisRun, SpendOutcome } from "../pipeline/page-basis.js";
import { recordPageEquivalents, recordWholeDocumentPages, type PageEquivalentRow } from "./page-equivalents.js";
import { enforceRunSpendForCharge, largestFundedCharge, pauseRunForSpend, SpendCheckUnavailableError } from "./spend-check.js";

/**
 * The Postgres adapter of the page basis (pipeline/page-basis.ts): document page columns, the run-wide reads the spend check
 * sums, and the balance check (db/spend-check.ts). Every write is scoped to the run's own, non-deduplicated document.
 */
export class PostgresPageBasisLedger implements PageBasisLedger {
  constructor(private readonly sql: Sql<Record<string, unknown>>) {}

  /**
   * Records a counted page basis (documents.page_count, page_count_source 'counted'): the pages the text splits into, the page
   * rows, citations and the completion charge count.
   */
  async setPageCount(runId: string, documentId: string, pages: number): Promise<boolean> {
    const rows = await this.sql`
      update documents set page_count = ${pages}, page_count_source = 'counted', updated_at = now()
      where id = ${documentId} and run_id = ${runId} and deduped_from_document_id is null
      returning id
    `;
    return rows.length > 0;
  }

  /**
   * Records the pages the worker measured for an Office, slide, sheet or EPUB document (documents.billing_pages), so the completion
   * charge and the optional features bill what the file really holds. `page_count` is not touched: those formats' text has no
   * page breaks.
   */
  async setBillingPages(runId: string, documentId: string, pages: number, method: string): Promise<boolean> {
    const rows = await this.sql`
      update documents set billing_pages = ${pages}, billing_pages_method = ${method}, updated_at = now()
      where id = ${documentId} and run_id = ${runId} and deduped_from_document_id is null
      returning id
    `;
    return rows.length > 0;
  }

  async recordPageEquivalents(runId: string, documentId: string, rows: readonly PageEquivalentRow[], allowance: number): Promise<number | null> {
    return await recordPageEquivalents(this.sql, { runId, documentId, rows, allowance });
  }

  async recordWholeDocumentPages(runId: string, documentId: string, pages: number): Promise<number | null> {
    return await recordWholeDocumentPages(this.sql, { runId, documentId, pages });
  }

  /**
   * Fast pages of the run measured above what admission priced (durable: documents.intake_page_count, migration 0130), over
   * every paged document still in the run: none of them is charged before the run's completion fee. Images are excluded:
   * their frames bill as they are read (countedImageFrames).
   */
  async measuredPagesAboveIntake(runId: string): Promise<number> {
    const [row] = await this.sql<{ pages: number }[]>`
      select coalesce(sum(greatest(0, coalesce(billing_pages, page_count) - coalesce(intake_page_count, page_count))), 0)::int as pages
      from documents
      where run_id = ${runId} and deduped_from_document_id is null and status <> 'failed'
        and coalesce(mime_type, '') not like 'image/%' and coalesce(mime_type, '') not like 'audio/%' and coalesce(mime_type, '') not like 'video/%'`;
    return Number(row?.pages) || 0;
  }

  /** The run's own documents the worker measured (billing_pages set) that still bill at completion. */
  async measuredDocuments(runId: string): Promise<MeasuredRunDocument[]> {
    const rows = await this.sql<{ page_count: number; billing_pages: number; billing_pages_method: string | null }[]>`
      select page_count, billing_pages, billing_pages_method from documents
      where run_id = ${runId} and billing_pages is not null and deduped_from_document_id is null and status <> 'failed'
    `;
    return rows.map((row) => ({ pageCount: Number(row.page_count) || 0, billingPages: Number(row.billing_pages) || 0, method: row.billing_pages_method }));
  }

  /**
   * The run's multi-frame images (TIFF) whose counted frames raised their page count above intake's one page, with the distinct
   * pages a page-read charge of this run already covers (read through usage_attribution).
   */
  async countedImageFrames(runId: string): Promise<CountedImageFrames[]> {
    const rows = await this.sql<{ id: string; page_count: number; charged: number }[]>`
      select d.id, d.page_count,
        coalesce((select count(distinct (au.metadata ->> 'pageNumber')) from usage_attribution au
          where au.run_id = ${runId} and au.metric = any(${[...PAGE_READ_METRICS]}::text[]) and au.metadata ->> 'documentId' = d.id), 0)::int as charged
      from documents d
      where d.run_id = ${runId} and d.deduped_from_document_id is null and d.page_count > 1
        and lower(split_part(coalesce(d.mime_type, ''), ';', 1)) in ('image/tiff', 'image/tiff-fx')
    `;
    return rows.map((row) => ({ documentId: row.id, pageCount: Number(row.page_count) || 0, chargedPages: Number(row.charged) || 0 }));
  }

  async checkCharge(run: PageBasisRun, credits: number): Promise<SpendOutcome> {
    const result = await enforceRunSpendForCharge(this.sql, run, credits, "stage-boundary");
    return { paused: result.paused, blocked: result.blocked };
  }

  async largestFundedCharge(run: PageBasisRun, max: number, creditsFor: (n: number) => number): Promise<number> {
    return await largestFundedCharge(this.sql, run, max, creditsFor);
  }

  async pauseForFunds(run: PageBasisRun, reason: string): Promise<SpendOutcome> {
    const result = await pauseRunForSpend(this.sql, run, reason, "stage-boundary", Number.NaN);
    if (result.pauseFailed) throw new SpendCheckUnavailableError(`could not pause run ${run.id} for ${reason}`);
    return { paused: result.paused, blocked: result.blocked };
  }
}

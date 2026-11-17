import type { Sql } from "postgres";

import type { PageBasisLedger, PageBasisRun, RunMeasurements, SpendOutcome } from "../pipeline/page-basis.js";
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

  /** The one run-wide sum (migration 0187 run_measured_pages), shared with the spend-paused resume sweep. */
  async runMeasurements(runId: string, excludeDocumentId: string, readMetrics: readonly string[]): Promise<RunMeasurements> {
    const [row] = await this.sql<{ fast_pages: string | number; ocr_frames: string | number; document_charged_pages: number }[]>`
      select fast_pages, ocr_frames, document_charged_pages
      from run_measured_pages(${runId}, ${[...readMetrics]}::text[], ${excludeDocumentId})`;
    return {
      fastPages: Number(row?.fast_pages ?? 0),
      ocrFrames: Number(row?.ocr_frames ?? 0),
      documentChargedPages: Number(row?.document_charged_pages ?? 0),
    };
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

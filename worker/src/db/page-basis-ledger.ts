import type { Sql } from "postgres";

import type { PageBasisLedger, PageBasisRun, RunMeasurements, SpendOutcome } from "../pipeline/page-basis.js";
import { StaleExecutionError } from "./execution-ownership.js";
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
  async setPageCount(runId: string, documentId: string, pages: number, executionGeneration?: string | null): Promise<boolean> {
    // The first pass hands a file to another activity as soon as it is counted. That activity must see the new
    // denominator even if this shard never checkpoints. Lock the prior document value so retries add zero and
    // independent documents adjust the same run without replacing one another's measurements.
    const [result] = await this.sql<{ recorded: boolean }[]>`
      with owner as (
        select id from project_runs where id = ${runId}
          and execution_generation is not distinct from ${executionGeneration ?? null}
          and status in ('queued', 'processing')
          and coalesce(control_state, '') not in ('cancel_requested', 'cancelled', 'pause_requested', 'paused', 'dead-letter')
        for no key update
      ), prior as (
        select d.id, d.page_count from owner join documents d on d.run_id = owner.id
        where d.id = ${documentId}
        for no key update of d
      ), measured as (
        update documents d set page_count = ${pages}, page_count_source = 'counted', updated_at = now()
        from prior where d.id = prior.id
        returning d.id, d.page_count - prior.page_count as delta
      ), adjusted as (
        update project_runs r
        set pages_total = greatest(0, r.pages_total + m.delta),
          pages_processed = least(r.pages_processed, greatest(0, r.pages_total + m.delta)),
          updated_at = now()
        from measured m where r.id = ${runId} and m.delta <> 0
      )
      select exists(select 1 from measured) as recorded from owner
    `;
    if (!result) throw new StaleExecutionError();
    return result.recorded;
  }

  /**
   * Records the pages the worker measured for an Office, slide, sheet or EPUB document (documents.billing_pages), so the completion
   * charge and the optional features bill what the file really holds. `page_count` is not touched: those formats' text has no
   * page breaks.
   */
  async setBillingPages(runId: string, documentId: string, pages: number, method: string): Promise<boolean> {
    const rows = await this.sql`
      update documents set billing_pages = ${pages}, billing_pages_method = ${method}, updated_at = now()
      where id = ${documentId} and run_id = ${runId}
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

  /** The one run-wide sum (migration 0190 run_measured_pages), shared with the spend-paused resume sweep. */
  async runMeasurements(runId: string, excludeDocumentId: string | null, readMetrics: readonly string[]): Promise<RunMeasurements> {
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

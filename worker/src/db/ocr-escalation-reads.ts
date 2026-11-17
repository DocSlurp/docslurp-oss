import type { Sql } from "postgres";

import type { UsageEvent } from "../models.js";

/** One persisted OCR escalation call (ocr_escalation_reads, migration 0129). */
export interface OcrEscalationReadRow {
  attempt: number;
  status: "completed" | "failed";
  text: string | null;
  model: string;
  /** The call's usage events, under the ids they were buffered with. */
  usageEvents: UsageEvent[];
}

/** The OCR escalation read log port the hosted reader persists through (pipeline CheckpointStore.ocrEscalation). */
export type OcrEscalationLog = Pick<PostgresOcrEscalationReads, keyof PostgresOcrEscalationReads>;

/**
 * OCR escalation reads: every escalation call persisted as it returns, per run, document and page, so a retried activity
 * reuses a completed read and re-buffers each earlier call's usage under its own id instead of calling the provider again.
 */
export class PostgresOcrEscalationReads {
  constructor(private readonly sql: Sql<Record<string, unknown>>) {}

  /** This run's persisted OCR escalation reads of a page, oldest first. */
  async ocrEscalationReads(runId: string, documentId: string, pageNumber: number): Promise<OcrEscalationReadRow[]> {
    const rows = await this.sql<{ attempt: number; status: "completed" | "failed"; text: string | null; model: string; usage_events: unknown }[]>`
      select attempt, status, text, model, usage_events from ocr_escalation_reads
      where run_id = ${runId} and document_id = ${documentId} and page_number = ${pageNumber}
      order by attempt`;
    return rows.map((row) => ({
      attempt: Number(row.attempt), status: row.status, text: row.text, model: row.model,
      usageEvents: Array.isArray(row.usage_events) ? row.usage_events as UsageEvent[] : [],
    }));
  }

  /**
   * Persist one OCR escalation call as soon as it returns, under the next free attempt number (assigned atomically, so
   * concurrent calls of a page never share one); returns that number.
   */
  async recordOcrEscalationRead(row: Omit<OcrEscalationReadRow, "attempt"> & { runId: string; documentId: string; pageNumber: number }): Promise<number> {
    const events = this.sql.json(JSON.parse(JSON.stringify(row.usageEvents)));
    // The next attempt number in the same statement as the insert; a concurrent call that took it first makes this insert a
    // no-op, and the loop takes the one after. Each call's usage events carry their own unique ids, so none is lost either way.
    for (let tries = 0; tries < 16; tries += 1) {
      const inserted = await this.sql<{ attempt: number }[]>`
        insert into ocr_escalation_reads (run_id, document_id, page_number, attempt, status, text, model, usage_events)
        select ${row.runId}, ${row.documentId}, ${row.pageNumber},
          coalesce((select max(attempt) from ocr_escalation_reads where run_id = ${row.runId} and document_id = ${row.documentId} and page_number = ${row.pageNumber}), 0) + 1,
          ${row.status}, ${row.text}, ${row.model}, ${events}
        on conflict (run_id, document_id, page_number, attempt) do nothing
        returning attempt`;
      if (inserted.length > 0) return Number(inserted[0]!.attempt);
    }
    throw new Error(`could not persist an OCR escalation read for ${row.documentId} page ${row.pageNumber}: attempt numbers kept colliding`);
  }
}

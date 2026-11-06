import type { Sql } from "postgres";

import { pricing } from "@docslurp/shared";

import { recordPageEquivalents, type PageEquivalentRow } from "../db/page-equivalents.js";
import { authorizeMeasuredPages } from "../lib/measured-page-authorization.js";
import type { Document } from "../models.js";
import type { CheckpointStore, WorkflowState } from "./pipeline.js";

/**
 * Where rendered page areas go (pdf-asset-cache.ts): set once per worker process (stages/index.ts), so every raster cache
 * instance, whichever stage or deferred path built it, records the area equivalents of the pages it renders and authorizes
 * them. `record` raises the page's measured equivalents in the database (db/page-equivalents.ts) and returns the document's
 * billing_pages; `authorize` runs the measured-page authorization (lib/measured-page-authorization.ts) for the run, which
 * pauses an unfunded run (RunPolicyError) before any further work. Unset in tests and tools without a database; then nothing
 * is recorded.
 */
export interface PageAreaSink {
  record(args: { runId: string; documentId: string; rows: PageEquivalentRow[] }): Promise<number | null>;
  authorize(runId: string, document: Document): Promise<void>;
}
let sink: PageAreaSink | null = null;

/**
 * The worker's sink (stages/index.ts): rendered PDF pages are recorded under the installed pricing provider's dense-page
 * allowance (area always bills in full), then authorized exactly like every other measured page, for the run that rendered.
 */
export function createPageAreaSink(
  sql: Sql<Record<string, unknown>>,
  store: Pick<CheckpointStore, "enforceSpendForCharge" | "measuredPagesAboveIntake"> & { loadRun(runId: string): Promise<WorkflowState["run"]> },
): PageAreaSink {
  return {
    record: (args) => recordPageEquivalents(sql, { ...args, allowance: pricing().pageEquivalentAllowance }),
    authorize: async (runId, document) => {
      await authorizeMeasuredPages({ run: await store.loadRun(runId), store }, document);
    },
  };
}

export function configurePageAreaSink(next: PageAreaSink | null): void {
  sink = next;
}

/**
 * Record rendered pages that measured above one standard page, then authorize the document's measured pages. Called before
 * any of the pages' bytes are cached, so a failure here (or a refusal) leaves nothing cached and a retry measures again; the
 * in-memory document (the run's own Document object) is raised to the stored billing_pages. Authorization runs whenever such a
 * page is recorded, not only when this call raised billing_pages: a retry after a failed check finds the count already stored
 * and must still be authorized. Fails loudly.
 */
export async function recordRenderedPageAreas(runId: string | undefined, document: Document, rows: PageEquivalentRow[]): Promise<void> {
  const above = rows.filter((row) => (row.area ?? 1) > 1);
  if (!sink || !runId || above.length === 0) return;
  const billingPages = await sink.record({ runId, documentId: document.id, rows: above });
  if (billingPages !== null && billingPages > (Number(document.billingPages) || 0)) {
    document.billingPages = billingPages;
    document.billingPagesMethod = "page-equivalents";
  }
  await sink.authorize(runId, document);
}

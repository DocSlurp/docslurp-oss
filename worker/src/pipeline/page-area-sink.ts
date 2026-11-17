import { pricing } from "@docslurp/shared";

import type { PageEquivalentRow } from "../db/page-equivalents.js";
import type { Document, ProjectRun } from "../models.js";
import { PageBasis, type PageBasisLedger } from "./page-basis.js";

/**
 * Where rendered page areas go (pdf-asset-cache.ts): set once per worker process (stages/index.ts), so every raster cache
 * instance, whichever stage or deferred path built it, records the area equivalents of the pages it renders through the run's
 * page basis (pipeline/page-basis.ts), which raises billing_pages and authorizes the measured pages: an unfunded run is paused
 * (UnfundedPagesError) before any further work. Unset in tests and tools without a database; then nothing is recorded.
 */
export interface PageAreaSink {
  record(runId: string, document: Document, rows: PageEquivalentRow[]): Promise<void>;
}
let sink: PageAreaSink | null = null;

/**
 * The worker's sink (stages/index.ts): rendered PDF pages are recorded under the installed pricing provider's dense-page
 * allowance (area always bills in full), then authorized exactly like every other measured page, for the run that rendered.
 */
export function createPageAreaSink(store: { readonly pageBasisLedger: PageBasisLedger; loadRun(runId: string): Promise<ProjectRun> }): PageAreaSink {
  return {
    record: async (runId, document, rows) => {
      // Sizing and read checks are not made here, so no activity's buffered charges are counted.
      const pageBasis = new PageBasis({ run: await store.loadRun(runId), usageLedger: { pendingBillableCents: 0 } }, store.pageBasisLedger);
      await pageBasis.record(document, { kind: "page-equivalents", rows, allowance: pricing().pageEquivalentAllowance });
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
  await sink.record(runId, document, above);
}

import { ApplicationFailure } from "@temporalio/common";
import { runWithPerfContext } from "../lib/perf-context.js";
import { createHash } from "node:crypto";
import type { RenderDocumentPageInput } from "@docslurp/shared";
import { isPageImageWithheld, piiScanIncomplete, pageImagesOnSql, pageRenderSlot, pageRenderDpi, pageRenderWorkflowId, piiWithholding, isBillingEnforced } from "@docslurp/shared";
import type { Store } from "../db/store.js";
import { persistScopedUsageEvents } from "../db/usage-event-store.js";
import { orgSpendBlock } from "../db/spend-check.js";
import { PdfRasterCache, PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import { buildAllocatedResourceObservation, buildLocalComputeUsageEvent, resolveWorkerDeploymentProfile } from "../pipeline/local-compute-cost.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { assertParseSourceDecided } from "../lib/parse-source.js";

/**
 * A page is never rasterized from the source when the PII policy withholds it. Page-scoped withholding refuses only
 * the withheld pages; any other withholding with withheld artifacts (redaction, unpaged sections, a malformed outcome)
 * refuses every page, since its page attribution is unknown.
 */
export function pageRenderWithheld(row: { status: string | null; metadata: unknown; withheld: boolean }, pageNumber: number): boolean {
  const withholding = piiWithholding(row);
  // Page scope, or a redaction that recorded its pages: a page renders only when its pixels are known clean (a redacted
  // page's image still shows the value it redacted).
  // A scan in progress (deferred modes) never renders a page it has not scanned.
  if (piiScanIncomplete(withholding) && isPageImageWithheld(withholding, pageNumber)) return true;
  if (withholding.scope === "pages" || (withholding.scope === "none" && withholding.redactedPages)) return isPageImageWithheld(withholding, pageNumber);
  return withholding.scope === "document" || row.withheld;
}

/** Revalidate the live document before rendering and under the final write lock. */
export async function renderDocumentPage(deps: { store: Store; storage: ArtifactStore; runner: CommandRunner }, input: RenderDocumentPageInput, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { store } = deps;
  const quality = input.quality ?? "reader";
  if (quality !== "reader" && quality !== "export") throw new Error("Invalid page quality");
  const sql = store.stageSql;
  const document = await store.loadDocument(input.documentId, { runId: input.runId });
  if (document.runId !== input.runId || document.status !== "completed" || document.mimeType !== "application/pdf" || !Number.isInteger(input.pageNumber) || input.pageNumber < 1 || input.pageNumber > document.pageCount) throw new Error("Document page is not renderable");
  // Fail closed (council R7-H1): a document with no parse decision from this build's quarantine (one quarantined before it)
  // is never rasterized from its upload. Final: a retry cannot decide it; a reprocess re-quarantines it.
  try {
    assertParseSourceDecided(document);
  } catch (error) {
    throw ApplicationFailure.nonRetryable("Document page needs a fresh scan: reprocess the document", "ParseSourceUnscanned", error instanceof Error ? error.name : "refused");
  }
  const [row] = await sql<{ org_id: string; project_id: string; withheld: boolean; status: string | null; metadata: unknown; page_images: boolean; low: string | null; high: string | null }[]>`
    select d.org_id, d.project_id, d.status, d.metadata,
      coalesce(jsonb_array_length(d.metadata->'pii'->'withheldArtifactUris'), 0) > 0 as withheld,
      ${sql.unsafe(pageImagesOnSql("p"))} as page_images,
      r.artifacts->>${pageRenderSlot(input.documentId, input.pageNumber, quality, 120)} as low,
      r.artifacts->>${pageRenderSlot(input.documentId, input.pageNumber, quality, 250)} as high
    from documents d join project_runs r on r.id=d.run_id left join projects p on p.id=d.project_id
    where d.id=${document.id} and r.id=${input.runId}
  `;
  if (!row || pageRenderWithheld(row, input.pageNumber)) throw new Error("Document page is unavailable");
  // Page images off for the project (pipeline.pageImages: false): no viewer page image is rendered (fail closed).
  if (row.page_images === false) throw ApplicationFailure.nonRetryable("Page images are turned off for this project", "PageImagesDisabled");
  const dpi = input.dpi ?? pageRenderDpi(quality);
  if ((dpi !== 120 && dpi !== 250) || (dpi === 250 && quality !== "export")) throw ApplicationFailure.nonRetryable("Page render policy changed; request again", "PageRenderPolicyChanged");
  const slot = pageRenderSlot(input.documentId, input.pageNumber, quality, dpi);
  if (dpi === 250 ? row.high : row.low) {
    await sql`delete from document_page_renders where document_id=${document.id} and run_id=${input.runId} and page_number=${input.pageNumber} and quality=${quality} and dpi=${dpi}`;
    return;
  }
  if (isBillingEnforced()) {
    if (await orgSpendBlock(sql, { orgId: row.org_id, projectId: row.project_id })) throw new Error("Page rendering spend is blocked");
  }
  const started = Date.now();
  const sources = new PdfSourceCache(deps.storage);
  const cache = new PdfRasterCache(deps.runner, deps.storage, sources);
  // The render's parser commands carry this organization's run (one pooled VM for its commands, usage in its ledger).
  const [page] = await runWithPerfContext({ runId: input.runId, orgId: row.org_id, projectId: row.project_id, documentId: document.id,
    scope: "document", stageName: "page-render", pushPerformance: () => {} },
  () => cache.renderSelectedPages({ document, runId: input.runId, pageNumbers: [input.pageNumber], dpi, signal })).finally(() => sources.clear());
  if (!page) throw new Error("Requested page was not rendered");
  const ledger = new PipelineUsageEventLedger();
  const profile = resolveWorkerDeploymentProfile();
  const event = buildLocalComputeUsageEvent({ metric: "worker-page-render", profile,
    observation: buildAllocatedResourceObservation({ profile, wallTimeMs: Date.now() - started, pages: 1 }),
    costRollup: "authoritative", metadata: { documentId: document.id, pageNumber: input.pageNumber, runId: input.runId, quality, rasterVersion: 3, widthPx: page.widthPx ?? null, heightPx: page.heightPx ?? null, requestedDpi: dpi, cacheHit: page.cacheHit },
  });
  // UUID-shaped deterministic receipt: replaying a completed raster never debits twice.
  const hash = createHash("sha256").update(pageRenderWorkflowId({ ...input, quality, dpi })).digest("hex");
  event.id = `${hash.slice(0,8)}-${hash.slice(8,12)}-${hash.slice(12,16)}-${hash.slice(16,20)}-${hash.slice(20,32)}`;
  ledger.enqueue(event);
  const batch = ledger.checkpoint();
  signal?.throwIfAborted();
  await sql.begin(async tx => {
    const client = tx as unknown as typeof sql;
    const live = await client<{ status: string | null; metadata: unknown; withheld: boolean }[]>`select d.status, d.metadata,
      coalesce(jsonb_array_length(d.metadata->'pii'->'withheldArtifactUris'),0) > 0 as withheld
      from documents d
      where d.id=${document.id} and d.run_id=${input.runId} and d.status='completed' for update of d`;
    // Rechecked under the lock: a rescan that withheld this page between the read and the write wins.
    if (!live[0] || pageRenderWithheld(live[0], input.pageNumber)) throw new Error("Document page is unavailable");
    signal?.throwIfAborted();
    await client`update project_runs set artifacts=coalesce(artifacts,'{}'::jsonb) || ${client.json({ [slot]: page.artifactUri, ...(quality === "reader" ? { [`${document.id}:page-${input.pageNumber}`]: page.artifactUri } : {}) })}::jsonb where id=${input.runId}`;
    await client`delete from document_page_renders where document_id=${document.id} and run_id=${input.runId} and page_number=${input.pageNumber} and quality=${quality} and dpi=${dpi}`;
    await persistScopedUsageEvents({ client, userId: document.userId, scope: { orgId: row.org_id, projectId: row.project_id }, usageEvents: batch.events });
  });
  batch.commit();
}

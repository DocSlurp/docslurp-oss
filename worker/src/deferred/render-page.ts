import { ApplicationFailure } from "@temporalio/common";
import { createHash } from "node:crypto";
import type { RenderDocumentPageInput } from "@docslurp/shared";
import { pageRenderSlot, pageRenderDpi, pageRenderWorkflowId, isBillingEnforced } from "@docslurp/shared";
import type { Store } from "../db/store.js";
import { persistScopedUsageEvents } from "../db/usage-event-store.js";
import { spendBlockCode } from "../db/spend-check.js";
import { PdfRasterCache, PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import { buildAllocatedResourceObservation, buildLocalComputeUsageEvent, resolveWorkerDeploymentProfile } from "../pipeline/local-compute-cost.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";

/** Revalidate the live document before rendering and under the final write lock. */
export async function renderDocumentPage(deps: { store: Store; storage: ArtifactStore; runner: CommandRunner }, input: RenderDocumentPageInput, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { store } = deps;
  const quality = input.quality ?? "reader";
  if (quality !== "reader" && quality !== "export") throw new Error("Invalid page quality");
  const sql = store.stageSql;
  const document = await store.loadDocument(input.documentId);
  if (document.runId !== input.runId || document.status !== "completed" || document.mimeType !== "application/pdf" || !Number.isInteger(input.pageNumber) || input.pageNumber < 1 || input.pageNumber > document.pageCount) throw new Error("Document page is not renderable");
  const [row] = await sql<{ org_id: string; workspace_id: string; withheld: boolean; low: string | null; high: string | null }[]>`
    select d.org_id, d.workspace_id,
      coalesce(jsonb_array_length(d.metadata->'pii'->'withheldArtifactUris'), 0) > 0 as withheld,
      r.artifacts->>${pageRenderSlot(input.documentId, input.pageNumber, quality, 120)} as low,
      r.artifacts->>${pageRenderSlot(input.documentId, input.pageNumber, quality, 250)} as high
    from documents d join workspace_runs r on r.id=d.run_id
    where d.id=${document.id} and r.id=${input.runId}
  `;
  if (!row || row.withheld) throw new Error("Document page is unavailable");
  const dpi = input.dpi ?? pageRenderDpi(quality);
  if ((dpi !== 120 && dpi !== 250) || (dpi === 250 && quality !== "export")) throw ApplicationFailure.nonRetryable("Page render policy changed; request again", "PageRenderPolicyChanged");
  const slot = pageRenderSlot(input.documentId, input.pageNumber, quality, dpi);
  if (dpi === 250 ? row.high : row.low) {
    await sql`delete from document_page_renders where document_id=${document.id} and run_id=${input.runId} and page_number=${input.pageNumber} and quality=${quality} and dpi=${dpi}`;
    return;
  }
  if (isBillingEnforced()) {
    const [budget] = await sql<{ funded: boolean; available: number; workspace_budget_paused: boolean; org_budget_paused: boolean; workspace_in_org: boolean }[]>`select * from org_spend_status(${row.org_id}, ${row.workspace_id}::text, 0)`;
    if (spendBlockCode(budget ? { ...budget, org_id: row.org_id } : undefined)) throw new Error("Page rendering spend is blocked");
  }
  const started = Date.now();
  const sources = new PdfSourceCache(deps.storage);
  const cache = new PdfRasterCache(deps.runner, deps.storage, sources);
  const [page] = await cache.renderSelectedPages({ document, runId: input.runId, pageNumbers: [input.pageNumber], dpi, signal }).finally(() => sources.clear());
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
    const live = await client`select d.id from documents d
      where d.id=${document.id} and d.run_id=${input.runId} and d.status='completed'
      and coalesce(jsonb_array_length(d.metadata->'pii'->'withheldArtifactUris'),0)=0 for update of d`;
    if (!live.length) throw new Error("Document page is unavailable");
    signal?.throwIfAborted();
    await client`update workspace_runs set artifacts=coalesce(artifacts,'{}'::jsonb) || ${client.json({ [slot]: page.artifactUri, ...(quality === "reader" ? { [`${document.id}:page-${input.pageNumber}`]: page.artifactUri } : {}) })}::jsonb where id=${input.runId}`;
    await client`delete from document_page_renders where document_id=${document.id} and run_id=${input.runId} and page_number=${input.pageNumber} and quality=${quality} and dpi=${dpi}`;
    await persistScopedUsageEvents({ client, userId: document.userId, scope: { orgId: row.org_id, workspaceId: row.workspace_id }, usageEvents: batch.events });
  });
  batch.commit();
}

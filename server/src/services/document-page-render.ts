import { PII_BLOCKED_DOCUMENT_STATUS, type DataUnavailableReason, pageRenderSlot, pageRenderDpi, pageRenderCapabilities, parseSourceRescanRequired, type ParseSourceDecisionColumns } from "@docslurp/shared";
import { canEditProject, getProjectAccess } from "./organizations.js";
import { sql } from "../db.js";
import { startPageRenderWorkflow } from "../lib/temporal.js";
import { assertCanSpend } from "./billing/spend-guard.js";
import { getDocumentViewerPayload } from "./documents.js";

/** Authorization precedes both cached image reads and new rendering work. */
export async function requestDocumentPageRender(documentId: string, pageNumber: number, userId: string, start: boolean,
  authorize: (document: NonNullable<Awaited<ReturnType<typeof getDocumentViewerPayload>>>["document"]) => void, quality: "reader" | "export" = "reader") {
  const viewer = await getDocumentViewerPayload(documentId, userId);
  if (!viewer) return { status: "missing" as const };
  authorize(viewer.document);
  const doc = viewer.document;
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > doc.pageCount) return { status: "missing" as const };
  if (start) {
    const access = await getProjectAccess(doc.projectId, userId);
    if (!access || !canEditProject(access, userId)) return { status: "missing" as const };
  }
  const observation=doc.runId?{kind:"page-image" as const,documentId:doc.id,runId:doc.runId,pageNumber,quality}:undefined;
  const dpi = pageRenderDpi(quality);
  const capabilities = pageRenderCapabilities();
  const artifact = viewer.artifacts.find(item => item.slot === pageRenderSlot(documentId, pageNumber, quality, dpi));
  if (!artifact && quality === "reader") {
    const legacy = viewer.artifacts.find(item => item.slot === `${documentId}:page-${pageNumber}` || item.slot === `${documentId}:raster-v2-reader-page-${pageNumber}`);
    // Reusing already-authorized pixels is cheaper than a needless downgrade.
    // Their actual DPI is unknown; do not label them as 120 DPI.
    if (legacy) return { status: "ready" as const, capabilities, observation, artifact: { ...legacy, slot: `${documentId}:page-${pageNumber}` } };
  }
  if (artifact) return { status: "ready" as const, dpi, capabilities, observation, artifact: { ...artifact, slot: `${documentId}:page-${pageNumber}` } };
  // Withheld sources may never be recreated as unredacted page images.
  const unavailable = pageRenderUnavailableReason(doc, Boolean(viewer.source?.url));
  if (unavailable || !doc.runId) return { status: "unavailable" as const, reason: unavailable ?? "processing", document: doc };
  const runId = doc.runId;
  // Scan what we parse (PR #339): the worker refuses to render a document without a parse decision from the current scan
  // (one quarantined before it). Say so, stably, instead of queueing a render that can only fail and polling "pending".
  const [decision] = await sql<ParseSourceDecisionColumns[]>`
    select source_sha256, parse_source_key, parse_source_sha256, parse_source_scan_version from documents where id = ${doc.id}`;
  if (!decision) return { status: "missing" as const };
  if (parseSourceRescanRequired(decision)) {
    console.warn(`[page-render] status=rescan-required metric=page_render_rescan_required document=${doc.id} run=${doc.runId} page=${pageNumber}`);
    return { status: "rescan-required" as const, document: doc };
  }
  if (!start) return { status: "pending" as const, dpi, capabilities, observation };
  await assertCanSpend(doc.orgId, doc.projectId, { kind: "interactive" });
  const admitted = await sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtext(${`page-render:${doc.orgId}`}))`;
    const [capacity] = await tx<{ count: number; own: boolean }[]>`select count(*)::int as count,
      coalesce(bool_or(document_id=${doc.id} and run_id=${doc.runId} and page_number=${pageNumber} and quality=${quality} and dpi=${dpi}),false) as own
      from document_page_renders where org_id=${doc.orgId} and expires_at>now()`;
    if (capacity && capacity.count >= 8 && !capacity.own) return false;
    await tx`insert into document_page_renders (document_id,run_id,page_number,org_id,project_id,quality,dpi,expires_at)
      values (${doc.id},${doc.runId},${pageNumber},${doc.orgId},${doc.projectId},${quality},${dpi},now()+interval '10 minutes')
      on conflict (document_id,run_id,page_number,quality,dpi) do update
      set expires_at=excluded.expires_at`;
    return true;
  });
  if (!admitted) return { status: "busy" as const };
  await startPageRenderWorkflow({ documentId: doc.id, runId, pageNumber, quality, dpi });
  return { status: "pending" as const, dpi, capabilities, observation };
}

/**
 * Why no page image can be made for a document the caller may see, or null when one can. Checked in this order so the
 * most useful reason wins: a PII block before anything else, then the file type, the run state and a withheld source.
 */
export function pageRenderUnavailableReason(doc: { mimeType: string; status: string; runId: string | null }, hasSource: boolean): DataUnavailableReason | null {
  if (doc.status === PII_BLOCKED_DOCUMENT_STATUS) return "withheld";
  if (doc.mimeType !== "application/pdf") return "not-supported";
  // A failed or cancelled document produced nothing to render; any other non-completed status is a stage still running.
  if (doc.status === "failed" || doc.status === "cancelled") return "not-extracted";
  if (doc.status !== "completed" || !doc.runId) return "processing";
  if (!hasSource) return "withheld";
  return null;
}

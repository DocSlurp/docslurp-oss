import { pageRenderSlot, pageRenderDpi, pageRenderCapabilities } from "@docslurp/shared";
import { canEditWorkspace, getWorkspaceAccess } from "./organizations.js";
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
    const access = await getWorkspaceAccess(doc.workspaceId, userId);
    if (!access || !canEditWorkspace(access, userId)) return { status: "missing" as const };
  }
  const dpi = pageRenderDpi(quality);
  const capabilities = pageRenderCapabilities();
  const artifact = viewer.artifacts.find(item => item.slot === pageRenderSlot(documentId, pageNumber, quality, dpi));
  if (!artifact && quality === "reader") {
    const legacy = viewer.artifacts.find(item => item.slot === `${documentId}:page-${pageNumber}` || item.slot === `${documentId}:raster-v2-reader-page-${pageNumber}`);
    // Reusing already-authorized pixels is cheaper than a needless downgrade.
    // Their actual DPI is unknown; do not label them as 120 DPI.
    if (legacy) return { status: "ready" as const, capabilities, artifact: { ...legacy, slot: `${documentId}:page-${pageNumber}` } };
  }
  if (artifact) return { status: "ready" as const, dpi, capabilities, artifact: { ...artifact, slot: `${documentId}:page-${pageNumber}` } };
  // Withheld sources may never be recreated as unredacted page images.
  if (doc.mimeType !== "application/pdf" || doc.status !== "completed" || !doc.runId || !viewer.source?.url) return { status: "unavailable" as const };
  if (!start) return { status: "pending" as const, dpi, capabilities };
  await assertCanSpend(doc.orgId, doc.workspaceId, { kind: "interactive" });
  const admitted = await sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtext(${`page-render:${doc.orgId}`}))`;
    const [capacity] = await tx<{ count: number; own: boolean }[]>`select count(*)::int as count,
      coalesce(bool_or(document_id=${doc.id} and run_id=${doc.runId} and page_number=${pageNumber} and quality=${quality} and dpi=${dpi}),false) as own
      from document_page_renders where org_id=${doc.orgId} and expires_at>now()`;
    if (capacity && capacity.count >= 8 && !capacity.own) return false;
    await tx`insert into document_page_renders (document_id,run_id,page_number,org_id,workspace_id,quality,dpi,expires_at)
      values (${doc.id},${doc.runId},${pageNumber},${doc.orgId},${doc.workspaceId},${quality},${dpi},now()+interval '10 minutes')
      on conflict (document_id,run_id,page_number,quality,dpi) do update
      set expires_at=excluded.expires_at`;
    return true;
  });
  if (!admitted) return { status: "busy" as const };
  await startPageRenderWorkflow({ documentId: doc.id, runId: doc.runId, pageNumber, quality, dpi });
  return { status: "pending" as const, dpi, capabilities };
}

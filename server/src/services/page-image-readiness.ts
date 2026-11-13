import { isPageWithheld, piiWithholding, pageRenderDpi, pageRenderSlot, type RealtimePageImageResource } from "@docslurp/shared";
import { sql } from "../db.js";

/** Read-only readiness for one authorized page/version. Never signs URLs, loads
 * bytes, queues work, or returns artifact paths or document metadata. */
export async function readPageImageReadiness(userId:string,resource:RealtimePageImageResource) {
  const {documentId,runId,pageNumber,quality}=resource;
  const slots=[pageRenderSlot(documentId,pageNumber,quality,pageRenderDpi(quality)),
    ...(quality==="reader"?[`${documentId}:page-${pageNumber}`,`${documentId}:raster-v2-reader-page-${pageNumber}`]:[])];
  const [row]=await sql<{ready:boolean;available:boolean;status:string|null;pii:unknown}[]>`
    select d.status, d.metadata->'pii' as pii, d.status='completed' and exists (
      select 1 from unnest(${sql.array(slots)}::text[]) slot
      where jsonb_typeof(r.artifacts->slot)='string' and length(r.artifacts->>slot)>0
        and not coalesce((d.metadata->'pii'->'withheldArtifactUris') ? (r.artifacts->>slot),false)
    ) as ready,
    d.status='completed' and d.mime_type='application/pdf' and exists (
      select 1 from document_page_renders p where p.document_id=d.id and p.run_id=d.run_id
        and p.org_id=d.org_id and p.project_id=d.project_id and p.page_number=${pageNumber}
        and p.quality=${quality} and p.dpi=${pageRenderDpi(quality)} and p.expires_at>now()
    ) as available
    from documents d join project_runs r on r.id=d.run_id and r.project_id=d.project_id and r.org_id=d.org_id
    where d.id=${documentId} and d.run_id=${runId} and d.page_count>=${pageNumber} and ${pageNumber}>0
      and docslurp_project_access(d.project_id,${userId})`;
  if(!row)throw new Error("not_found");
  // Page-scoped PII: a withheld page reads as unavailable, never ready.
  if(isPageWithheld(piiWithholding({status:row.status,metadata:row.pii==null?{}:{pii:row.pii}}),pageNumber))return {resource,status:"unavailable" as const};
  return {resource,status:row.ready?"ready" as const:row.available?"pending" as const:"unavailable" as const};
}

import {
  quoteSettingsForPipeline,
  quoteStoredWork,
  type CostEstimate,
  type EstimateQuote,
  type PipelineFeatures,
  type QuoteFile,
  type QuoteSettings,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { orgWorkerSlots, type EstimateEnv } from "./config-change.js";

/*
 * Quotes for work on documents the server already holds (reprocess, full index, a config change): the same
 * `EstimateQuote` as `POST /v1/estimate`, built from what the worker measured (billing pages, stored size, type, the
 * pages a model read), never from a client profile. The work itself is priced stage by stage by the caller's estimate;
 * the quote adds the hosting and usage figures and the neutral lines.
 */

/** Documents to quote. Always org-scoped; `workspaceId`, `runId` and `documentIds` narrow it further. */
export type StoredQuoteScope = { orgId: string; workspaceId?: string; runId?: string; documentIds?: readonly string[] };

/**
 * The scoped documents as quote files, one per MIME type (hosting and the page mix are linear in pages and bytes, so a
 * type's documents add up): pages are the billed pages (`billing_pages`, else the counted pages), `measured.readPages`
 * the pages whose page facts record a model read. Superseded, purged and deduplicated copies are left out.
 */
export async function storedQuoteFiles(scope: StoredQuoteScope): Promise<QuoteFile[]> {
  if (scope.documentIds && scope.documentIds.length === 0) return [];
  const rows = await sql<{ mime_type: string; documents: number; bytes: string | number; pages: string | number; read_pages: string | number }[]>`
    select d.mime_type,
      count(*)::int as documents,
      coalesce(sum(d.file_size), 0)::bigint as bytes,
      coalesce(sum(greatest(coalesce(d.billing_pages, d.page_count), 0)), 0)::bigint as pages,
      coalesce(sum((select count(*) from document_page_facts f where f.document_id = d.id and f.vision_status = 'extracted')), 0)::bigint as read_pages
    from documents d
    where d.org_id = ${scope.orgId}
      ${scope.workspaceId ? sql`and d.workspace_id = ${scope.workspaceId}` : sql``}
      ${scope.runId ? sql`and d.run_id = ${scope.runId}` : sql``}
      ${scope.documentIds ? sql`and d.id = any(${sql.array([...scope.documentIds])})` : sql``}
      and d.superseded_at is null and d.purged_at is null and d.deduped_from_document_id is null
    group by d.mime_type
    order by d.mime_type
    limit 200`;
  return rows.map((row) => {
    const pages = Number(row.pages) || 0;
    return {
      name: `${row.documents} stored ${row.documents === 1 ? "document" : "documents"}`,
      size: Number(row.bytes) || 0,
      type: row.mime_type,
      ...(pages > 0 ? { pages, measured: { pages, readPages: Math.min(pages, Number(row.read_pages) || 0) } } : {}),
    };
  });
}

/**
 * Quote work on stored documents: `estimate` is the work's stage-precise estimate (null quotes ingesting them afresh),
 * `pipeline` the configuration the work runs with. Null when nothing is in scope.
 */
export async function quoteStoredDocuments(args: {
  scope: StoredQuoteScope;
  pipeline: PipelineFeatures;
  estimate: CostEstimate | null;
  settings?: Partial<QuoteSettings>;
  env?: EstimateEnv;
}): Promise<EstimateQuote | null> {
  const files = await storedQuoteFiles(args.scope);
  if (files.length === 0) return null;
  return quoteStoredWork({
    files,
    work: args.estimate ? { estimate: args.estimate, media: null } : null,
    base: quoteSettingsForPipeline(args.pipeline),
    ...(args.settings ? { settings: args.settings } : {}),
    workerSlots: await orgWorkerSlots(args.scope.orgId),
    env: args.env ?? process.env,
  });
}

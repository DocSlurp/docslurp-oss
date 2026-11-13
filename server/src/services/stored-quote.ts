import type { RunOrigin } from "@docslurp/shared";
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

/** Documents to quote. Always org-scoped; `projectId`, `runId` and `documentIds` narrow it further. */
export type StoredQuoteScope = { orgId: string; projectId?: string; runId?: string; documentIds?: readonly string[] };

/**
 * Where a stored document's page count stands for a quote: `measured` (the worker's `billing_pages`, else a `counted`
 * page_count), `empty` (measured at 0 pages: an empty Office file), or `assumed` (intake's guess, never measured).
 */
type StoredPageState = "measured" | "empty" | "assumed";

/**
 * The scoped documents as quote files, one per MIME type and page state (hosting and the page mix are linear in pages and
 * bytes, so a group's documents add up):
 * - measured: `pages` and `measured.pages` are the measured pages, `measured.readPages` the pages whose facts record a model read;
 * - empty: `measured.pages` 0, so the quote prices no pages for them (only their stored bytes);
 * - assumed: no page count at all, so the quote prices them as a range over their size, never as measured pages.
 * Superseded, purged and deduplicated copies are left out.
 */
export async function storedQuoteFiles(scope: StoredQuoteScope): Promise<QuoteFile[]> {
  if (scope.documentIds && scope.documentIds.length === 0) return [];
  const rows = await sql<{ mime_type: string; state: StoredPageState; documents: number; bytes: string | number; pages: string | number; read_pages: string | number }[]>`
    with scoped as (
      select d.id, d.mime_type, d.file_size,
        case
          when d.billing_pages is null and d.page_count_source is distinct from 'counted' then 'assumed'
          when greatest(coalesce(d.billing_pages, d.page_count), 0) = 0 then 'empty'
          else 'measured'
        end as state,
        greatest(coalesce(d.billing_pages, d.page_count), 0) as pages
      from documents d
      where d.org_id = ${scope.orgId}
        ${scope.projectId ? sql`and d.project_id = ${scope.projectId}` : sql``}
        ${scope.runId ? sql`and d.run_id = ${scope.runId}` : sql``}
        ${scope.documentIds ? sql`and d.id = any(${sql.array([...scope.documentIds])})` : sql``}
        and d.superseded_at is null and d.purged_at is null and d.deduped_from_document_id is null
    )
    select s.mime_type, s.state,
      count(*)::int as documents,
      coalesce(sum(s.file_size), 0)::bigint as bytes,
      coalesce(sum(case when s.state = 'measured' then s.pages else 0 end), 0)::bigint as pages,
      coalesce(sum(case when s.state = 'measured' then (select count(*) from document_page_facts f where f.document_id = s.id and f.vision_status = 'extracted') else 0 end), 0)::bigint as read_pages
    from scoped s
    group by s.mime_type, s.state
    order by s.mime_type, s.state
    limit 200`;
  return rows.map((row) => storedQuoteFile(row));
}

/** One group of stored documents as a quote file, keeping its page state explicit (storedQuoteFiles). */
export function storedQuoteFile(row: { mime_type: string; state: StoredPageState; documents: number; bytes: string | number; pages: string | number; read_pages: string | number }): QuoteFile {
  const file = {
    name: `${row.documents} stored ${row.documents === 1 ? "document" : "documents"} (${row.state === "assumed" ? "pages not measured" : row.state === "empty" ? "no pages" : "measured"})`,
    size: Number(row.bytes) || 0,
    type: row.mime_type,
  };
  if (row.state === "assumed") return file;
  if (row.state === "empty") return { ...file, measured: { pages: 0, readPages: 0 } };
  const pages = Math.max(1, Number(row.pages) || 0);
  return { ...file, pages, measured: { pages, readPages: Math.min(pages, Number(row.read_pages) || 0) } };
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
  /** The caller's origin, for a project with no chart tier (`runOriginOf`). */
  origin?: RunOrigin;
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
    ...(args.origin ? { origin: args.origin } : {}),
  });
}

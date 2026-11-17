/*
 * Read side of the page extract records (document_page_extracts, migration 0187; docs/extraction/page-extract-records.md):
 * how each page of a document got its text, as labels (method, pass, route, tags, quality signals). Every query is
 * filtered by the caller's organization (and project, when known); a document of another scope, or a purged one, reads
 * as missing (null), exactly like one that does not exist. There is no unscoped read.
 *
 * The rows hold no page text and no model id: the API shows them as stored. A page the project's PII policy withheld
 * (document_page_states `blocked-pii`) carries the `pii-withheld` tag.
 */
import {
  normalizePageExtractTags,
  type DocumentPageExtractsView,
  type PageExtractBilledClass,
  type PageExtractFinishReason,
  type PageExtractMethod,
  type PageExtractPass,
  type PageExtractRecordView,
} from "@docslurp/shared";

import { sql } from "../db.js";

export interface DocumentPageExtractScope {
  orgId: string;
  /** The document's project, when the caller already resolved it (an API key's project check). */
  projectId?: string;
  documentId: string;
}

export interface DocumentPageExtractPage {
  /** Pages per response, 1..2000 (default 500): records of pages afterPage+1 .. afterPage+limit. */
  limit?: number;
  /** Continue after this page (a previous response's `nextAfterPage`). */
  afterPage?: number;
  /** Only each page's final record. */
  finalOnly?: boolean;
}

export const DOCUMENT_PAGE_EXTRACTS_DEFAULT = 500;
export const DOCUMENT_PAGE_EXTRACTS_MAX = 2000;
const MAX_PAGE = 1_000_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** A request the route answers 400 to, with this fixed message. */
export class DocumentPageExtractQueryError extends Error {
  constructor() {
    super("Invalid page extract parameters");
    this.name = "DocumentPageExtractQueryError";
  }
}

function checked(page: DocumentPageExtractPage | undefined): { limit: number; after: number; finalOnly: boolean } {
  const limit = page?.limit ?? DOCUMENT_PAGE_EXTRACTS_DEFAULT;
  const after = page?.afterPage ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DOCUMENT_PAGE_EXTRACTS_MAX) throw new DocumentPageExtractQueryError();
  if (!Number.isSafeInteger(after) || after < 0 || after >= MAX_PAGE) throw new DocumentPageExtractQueryError();
  return { limit, after, finalOnly: page?.finalOnly === true };
}

type Row = {
  page_number: number; run_id: string; pass: PageExtractPass; method: PageExtractMethod; engine: string | null;
  member_id: string | null; region: string | null; billed_class: PageExtractBilledClass | null; tags: string[] | null;
  confidence: number | null; plausibility: number | null; text_bytes: number | null; finish_reason: PageExtractFinishReason | null;
  duration_ms: number | null; is_final: boolean; superseded_by_pass: PageExtractPass | null; created_at: string; pii_withheld: boolean;
};

function view(row: Row): PageExtractRecordView {
  const finite = (value: number | string | null) => (value === null ? null : Number(value));
  return {
    pageNumber: Number(row.page_number),
    runId: row.run_id,
    pass: row.pass,
    method: row.method,
    engine: row.engine,
    memberId: row.member_id,
    region: row.region,
    billedClass: row.billed_class,
    tags: normalizePageExtractTags([...(row.tags ?? []), ...(row.pii_withheld ? ["pii-withheld"] : [])]),
    confidence: finite(row.confidence),
    plausibility: finite(row.plausibility),
    textBytes: finite(row.text_bytes),
    finishReason: row.finish_reason,
    durationMs: finite(row.duration_ms),
    isFinal: row.is_final,
    supersededByPass: row.superseded_by_pass,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * The document's page extract records for one window of pages, or null when the document is not in this organization
 * (and project) or is purged. The scope is required: there is no unscoped read.
 */
export async function getDocumentPageExtracts(
  scope: DocumentPageExtractScope,
  page?: DocumentPageExtractPage,
): Promise<DocumentPageExtractsView | null> {
  if (!scope || typeof scope.orgId !== "string" || !ID.test(scope.orgId) || typeof scope.documentId !== "string" || !ID.test(scope.documentId)
      || (scope.projectId !== undefined && (typeof scope.projectId !== "string" || !ID.test(scope.projectId)))) {
    throw new Error("A page extract read needs an organization and a document id");
  }
  const { limit, after, finalOnly } = checked(page);
  const projectFilter = scope.projectId === undefined ? sql`` : sql`and d.project_id = ${scope.projectId}`;
  const [document] = await sql<{ id: string }[]>`
    select d.id from documents d
    where d.id = ${scope.documentId} and d.org_id = ${scope.orgId} ${projectFilter} and d.purged_at is null`;
  if (!document) return null;
  const last = after + limit;
  const rows = await sql<Row[]>`
    select e.page_number, e.run_id, e.pass, e.method, e.engine, e.member_id, e.region, e.billed_class, e.tags,
      e.confidence, e.plausibility, e.text_bytes, e.finish_reason, e.duration_ms, e.is_final, e.superseded_by_pass,
      e.created_at::text as created_at, coalesce(s.state = 'blocked-pii', false) as pii_withheld
    from document_page_extracts e
    left join document_page_states s on s.document_id = e.document_id and s.page_number = e.page_number
    where e.document_id = ${scope.documentId} and e.org_id = ${scope.orgId}
      and e.page_number > ${after} and e.page_number <= ${last}
      ${finalOnly ? sql`and e.is_final` : sql``}
    order by e.page_number, e.created_at, e.pass`;
  const [more] = await sql<{ more: boolean }[]>`
    select exists (select 1 from document_page_extracts
      where document_id = ${scope.documentId} and org_id = ${scope.orgId} and page_number > ${last}) as more`;
  return { documentId: document.id, records: rows.map(view), nextAfterPage: more?.more ? last : null };
}

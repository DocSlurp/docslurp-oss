/*
 * Read side of the page extract records (document_page_extracts, migration 0187; docs/extraction/page-extract-records.md):
 * how each page of a document got its text, as labels (method, pass, route, tags, quality signals). Every query is
 * filtered by the caller's organization (and project, when known); a document of another scope, or a purged one, reads
 * as missing (null), exactly like one that does not exist. There is no unscoped read.
 *
 * The rows hold no page text and no model id: the API shows them as stored. A page the project's PII policy withheld
 * (document_page_states `blocked-pii`) carries the `pii-withheld` tag and no text size.
 */
import {
  normalizePageExtractTags,
  PAGE_EXTRACT_PASSES,
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
  /** Records per response, 1..2000 (default 500). */
  limit?: number;
  /** Keyset cursor from a previous response's `nextCursor`. */
  after?: string;
  /** Only each page's final record. */
  finalOnly?: boolean;
  /**
   * Which runs: `current` (default) is the document's current run plus any page's final row (a query-time read of a later
   * run); `all` is every run; otherwise one run id of this document.
   */
  run?: string;
}

export const DOCUMENT_PAGE_EXTRACTS_DEFAULT = 500;
export const DOCUMENT_PAGE_EXTRACTS_MAX = 2000;
const MAX_PAGE = 1_000_000;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const PASSES: ReadonlySet<string> = new Set(PAGE_EXTRACT_PASSES);

/** A request the route answers 400 to, with this fixed message. */
export class DocumentPageExtractQueryError extends Error {
  constructor() {
    super("Invalid page extract parameters");
    this.name = "DocumentPageExtractQueryError";
  }
}

type Cursor = { page: number; runId: string; pass: string };

/** Opaque keyset cursor: base64url of `<page>:<pass>:<run id>`. */
export function encodePageExtractCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.page}:${cursor.pass}:${cursor.runId}`, "utf8").toString("base64url");
}

export function decodePageExtractCursor(raw: string): Cursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 256 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const match = /^([1-9][0-9]{0,6}):([a-z-]{1,16}):(.+)$/.exec(Buffer.from(raw, "base64url").toString("utf8"));
  if (!match || !PASSES.has(match[2]!) || !ID.test(match[3]!)) return null;
  const cursor = { page: Number(match[1]), pass: match[2]!, runId: match[3]! };
  if (cursor.page > MAX_PAGE || encodePageExtractCursor(cursor) !== raw) return null;
  return cursor;
}

function checked(page: DocumentPageExtractPage | undefined): { limit: number; after: Cursor | null; finalOnly: boolean; run: string } {
  const limit = page?.limit ?? DOCUMENT_PAGE_EXTRACTS_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DOCUMENT_PAGE_EXTRACTS_MAX) throw new DocumentPageExtractQueryError();
  const after = page?.after === undefined ? null : decodePageExtractCursor(page.after);
  if (page?.after !== undefined && !after) throw new DocumentPageExtractQueryError();
  const run = page?.run ?? "current";
  if (run !== "current" && run !== "all" && !ID.test(run)) throw new DocumentPageExtractQueryError();
  return { limit, after, finalOnly: page?.finalOnly === true, run };
}

type Row = {
  page_number: number; run_id: string; pass: PageExtractPass; method: PageExtractMethod; engine: string | null;
  billed_class: PageExtractBilledClass | null; tags: string[] | null;
  confidence: number | null; plausibility: number | null; text_bytes: number | null; finish_reason: PageExtractFinishReason | null;
  duration_ms: number | null; adopted: boolean; is_final: boolean; superseded_by_pass: PageExtractPass | null; created_at: string;
  pii_withheld: boolean;
};

function view(row: Row): PageExtractRecordView {
  const finite = (value: number | string | null) => (value === null ? null : Number(value));
  return {
    pageNumber: Number(row.page_number),
    runId: row.run_id,
    pass: row.pass,
    method: row.method,
    engine: row.engine,
    billedClass: row.billed_class,
    tags: normalizePageExtractTags([...(row.tags ?? []), ...(row.pii_withheld ? ["pii-withheld"] : [])]),
    confidence: finite(row.confidence),
    plausibility: finite(row.plausibility),
    // A withheld page's size says something about its content: never shown.
    textBytes: row.pii_withheld ? null : finite(row.text_bytes),
    finishReason: row.finish_reason,
    durationMs: finite(row.duration_ms),
    adopted: row.adopted,
    isFinal: row.is_final,
    supersededByPass: row.superseded_by_pass,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * The document's page extract records, one keyset page of them (ordered by page, run, pass: the primary key), or null when the document is
 * not in this organization (and project) or is purged. The scope is required: there is no unscoped read. The capability-pool
 * member and region are not served until they hold tier-safe values.
 */
export async function getDocumentPageExtracts(
  scope: DocumentPageExtractScope,
  page?: DocumentPageExtractPage,
): Promise<DocumentPageExtractsView | null> {
  if (!scope || typeof scope.orgId !== "string" || !ID.test(scope.orgId) || typeof scope.documentId !== "string" || !ID.test(scope.documentId)
      || (scope.projectId !== undefined && (typeof scope.projectId !== "string" || !ID.test(scope.projectId)))) {
    throw new Error("A page extract read needs an organization and a document id");
  }
  const { limit, after, finalOnly, run } = checked(page);
  const projectFilter = scope.projectId === undefined ? sql`` : sql`and d.project_id = ${scope.projectId}`;
  const [document] = await sql<{ id: string; run_id: string | null }[]>`
    select d.id, d.run_id from documents d
    where d.id = ${scope.documentId} and d.org_id = ${scope.orgId} ${projectFilter} and d.purged_at is null`;
  if (!document) return null;
  const runFilter = run === "all" ? sql``
    : run === "current" ? sql`and (e.run_id = ${document.run_id} or e.is_final)`
    : sql`and e.run_id = ${run}`;
  const rows = await sql<Row[]>`
    select e.page_number, e.run_id, e.pass, e.method, e.engine, e.billed_class, e.tags,
      e.confidence, e.plausibility, e.text_bytes, e.finish_reason, e.duration_ms, e.adopted, e.is_final, e.superseded_by_pass,
      e.created_at::text as created_at, coalesce(s.state = 'blocked-pii', false) as pii_withheld
    from document_page_extracts e
    left join document_page_states s on s.document_id = e.document_id and s.page_number = e.page_number
    where e.document_id = ${scope.documentId} and e.org_id = ${scope.orgId}
      ${runFilter}
      ${finalOnly ? sql`and e.is_final` : sql``}
      ${after === null ? sql`` : sql`and (e.page_number, e.run_id, e.pass) > (${after.page}, ${after.runId}, ${after.pass})`}
    -- The primary key's order (document, page, run, pass): the keyset walks its index.
    order by e.page_number, e.run_id, e.pass
    limit ${limit + 1}`;
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    documentId: document.id,
    records: pageRows.map(view),
    nextCursor: rows.length > limit && last ? encodePageExtractCursor({ page: Number(last.page_number), pass: last.pass, runId: last.run_id }) : null,
  };
}

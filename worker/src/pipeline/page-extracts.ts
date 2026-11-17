/**
 * Page extract records (document_page_extracts, migration 0187; docs/extraction/page-extract-records.md): one labelled
 * row per (document, page, run, pass) saying how the page's text was produced. Stages queue records on the workflow state
 * (`recordPageExtracts`, `tagPageExtracts`); the next progress checkpoint writes them in its own pipelined transaction
 * (`pageExtractStatements`): one multi-row upsert and at most one tag merge per checkpoint, never a statement per page.
 *
 * Labels only: no page text, document-supplied value or model id is ever recorded. Every value is checked against the
 * closed vocabularies in @docslurp/shared (and again by the database's CHECK constraints). A run without an organization
 * records nothing: a row is always scoped to its organization.
 *
 * Idempotent: the primary key is (document, page, run, pass) and the write is an upsert, so a retried stage or checkpoint
 * rewrites the same rows. A final record clears `is_final` on the page's other passes (of any run) and names itself in
 * their `superseded_by_pass`.
 */
import {
  normalizePageExtractTags,
  PAGE_EXTRACT_ENGINE_PATTERN,
  PAGE_EXTRACT_FINISH_REASONS,
  PAGE_EXTRACT_MEMBER_PATTERN,
  PAGE_EXTRACT_REGION_PATTERN,
  type PageExtractBilledClass,
  type PageExtractFinishReason,
  type PageExtractMethod,
  type PageExtractPass,
  type PageExtractTag,
} from "@docslurp/shared";
import { recordPipelineTelemetry } from "@docslurp/shared/observability";
import type { PendingQuery, Sql } from "postgres";

/** What a stage knows about one page's pass. Unknown signals stay unset (null in the row). */
export interface PageExtractInput {
  pageNumber: number;
  pass: PageExtractPass;
  method: PageExtractMethod;
  /** Engine route token (an extractor id or a route word); never a model id. Anything else is stored as `other`. */
  engine?: string | null;
  /** Capability-pool member that served the page, and its region. */
  memberId?: string | null;
  region?: string | null;
  billedClass?: PageExtractBilledClass | null;
  tags?: Iterable<PageExtractTag>;
  confidence?: number | null;
  plausibility?: number | null;
  textBytes?: number | null;
  finishReason?: string | null;
  durationMs?: number | null;
  /** This pass's text is what the page is indexed with (default true). */
  isFinal?: boolean;
}

export interface PageExtractRow {
  document_id: string;
  org_id: string;
  project_id: string;
  run_id: string;
  page_number: number;
  pass: PageExtractPass;
  method: PageExtractMethod;
  engine: string | null;
  member_id: string | null;
  region: string | null;
  billed_class: PageExtractBilledClass | null;
  tags: PageExtractTag[];
  confidence: number | null;
  plausibility: number | null;
  text_bytes: number | null;
  finish_reason: PageExtractFinishReason | null;
  duration_ms: number | null;
  is_final: boolean;
  superseded_by_pass: PageExtractPass | null;
}

export interface PageExtractTagMerge {
  document_id: string;
  org_id: string;
  run_id: string;
  page_number: number;
  tags: PageExtractTag[];
}

/** The part of the workflow state these helpers use. */
export interface PageExtractState {
  run: { id: string; orgId: string | null; projectId?: string };
  pendingPageExtracts: PageExtractRow[];
  pendingPageExtractTags: PageExtractTagMerge[];
}

const MAX_PAGE = 1_000_000;
const MAX_DURATION_MS = 86_400_000;
const MAX_TEXT_BYTES = 268_435_456;
const FINISH = new Set<string>(PAGE_EXTRACT_FINISH_REASONS);

function unit(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}
function bounded(value: number | null | undefined, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(max, Math.round(value)) : null;
}
function token(value: string | null | undefined, pattern: RegExp, fallback: string | null): string | null {
  if (value === null || value === undefined || value === "") return null;
  return pattern.test(value) ? value : fallback;
}
/** Provider finish reasons, mapped onto the closed set. */
export function pageExtractFinishReason(value: string | null | undefined): PageExtractFinishReason | null {
  if (!value) return null;
  const lower = value.toLowerCase();
  if (FINISH.has(lower)) return lower as PageExtractFinishReason;
  if (lower === "end_turn" || lower === "stop_sequence" || lower === "eos") return "stop";
  if (lower === "max_tokens" || lower === "max_output_tokens") return "length";
  if (lower === "content_filter" || lower === "refusal" || lower === "safety") return "refused";
  return "other";
}

function scope(state: PageExtractState, document: { id: string; projectId?: string }): { orgId: string; projectId: string } | null {
  const orgId = state.run.orgId;
  const projectId = document.projectId ?? state.run.projectId;
  return orgId && projectId ? { orgId, projectId } : null;
}

/**
 * Queues one document's records for the next checkpoint. A record for a key already queued replaces it (a stage that
 * revises a page in the same attempt); a final record clears `is_final` on the page's other queued passes.
 */
export function recordPageExtracts(
  state: PageExtractState,
  document: { id: string; projectId?: string },
  inputs: readonly PageExtractInput[],
): void {
  const owner = scope(state, document);
  if (!owner || inputs.length === 0) return;
  const pending = state.pendingPageExtracts;
  const index = new Map<string, number>();
  pending.forEach((row, at) => index.set(`${row.document_id}\u0000${row.page_number}\u0000${row.run_id}\u0000${row.pass}`, at));
  for (const input of inputs) {
    if (!Number.isSafeInteger(input.pageNumber) || input.pageNumber < 1 || input.pageNumber > MAX_PAGE) continue;
    const row: PageExtractRow = {
      document_id: document.id,
      org_id: owner.orgId,
      project_id: owner.projectId,
      run_id: state.run.id,
      page_number: input.pageNumber,
      pass: input.pass,
      method: input.method,
      engine: token(input.engine, PAGE_EXTRACT_ENGINE_PATTERN, "other"),
      member_id: token(input.memberId, PAGE_EXTRACT_MEMBER_PATTERN, null),
      region: token(input.region, PAGE_EXTRACT_REGION_PATTERN, null),
      billed_class: input.billedClass ?? null,
      tags: normalizePageExtractTags(input.tags ?? []),
      confidence: unit(input.confidence),
      plausibility: unit(input.plausibility),
      text_bytes: bounded(input.textBytes, MAX_TEXT_BYTES),
      finish_reason: pageExtractFinishReason(input.finishReason),
      duration_ms: bounded(input.durationMs, MAX_DURATION_MS),
      is_final: input.isFinal ?? true,
      superseded_by_pass: null,
    };
    if (row.is_final) {
      for (const other of pending) {
        if (other.document_id === row.document_id && other.page_number === row.page_number && other.is_final
            && (other.pass !== row.pass || other.run_id !== row.run_id)) {
          other.is_final = false;
          other.superseded_by_pass = row.pass;
        }
      }
    }
    const key = `${row.document_id}\u0000${row.page_number}\u0000${row.run_id}\u0000${row.pass}`;
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, pending.length);
      pending.push(row);
    } else {
      pending[at] = row;
    }
    recordPageExtractTelemetry(row);
  }
}

/**
 * Queues tags for pages a stage learned about after their text was recorded (routing: tables, a garbled layer, drawn
 * content). They merge into every pass of the page in this run, queued or already written.
 */
export function tagPageExtracts(
  state: PageExtractState,
  document: { id: string; projectId?: string },
  pageTags: ReadonlyMap<number, Iterable<PageExtractTag>>,
): void {
  const owner = scope(state, document);
  if (!owner) return;
  for (const [pageNumber, raw] of pageTags) {
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > MAX_PAGE) continue;
    const tags = normalizePageExtractTags(raw);
    if (tags.length === 0) continue;
    state.pendingPageExtractTags.push({ document_id: document.id, org_id: owner.orgId, run_id: state.run.id, page_number: pageNumber, tags });
    for (const tag of tags) recordPipelineTelemetry("pages.extract_tags", 1, { tag, source: "routing" });
  }
}

/** `docslurp.pages.extracts` and `docslurp.pages.extract_tags`: bounded labels only (no organization, project or document). */
function recordPageExtractTelemetry(row: PageExtractRow): void {
  recordPipelineTelemetry("pages.extracts", 1, {
    method: row.method, pass: row.pass, final: row.is_final ? "true" : "false", member: row.member_id ? "pool" : "none",
    ...(row.billed_class ? { class: row.billed_class } : {}),
  });
  for (const tag of row.tags) recordPipelineTelemetry("pages.extract_tags", 1, { tag, method: row.method });
}

/** Rows per statement: well under the 65,535 bind limit (the payload is one jsonb parameter anyway). */
const ROWS_PER_STATEMENT = 2_000;

/**
 * The checkpoint's statements for the queued records and tag merges (none when nothing is queued). Each upsert clears
 * `is_final` on the same page's other passes it supersedes; rows of the same batch were already resolved in memory and are
 * left alone (a row is never updated twice by one statement). Every write is filtered by organization.
 */
export function pageExtractStatements(
  client: Sql<Record<string, unknown>>,
  rows: readonly PageExtractRow[],
  tagMerges: readonly PageExtractTagMerge[],
): PendingQuery<any>[] {
  const statements: PendingQuery<any>[] = [];
  for (let start = 0; start < rows.length; start += ROWS_PER_STATEMENT) {
    const batch = rows.slice(start, start + ROWS_PER_STATEMENT);
    statements.push(client`
      with r as (
        select * from jsonb_to_recordset(${client.json(batch as never)}::jsonb) as r(
          document_id text, org_id text, project_id text, run_id text, page_number integer, pass text, method text,
          engine text, member_id text, region text, billed_class text, tags text[], confidence real, plausibility real,
          text_bytes integer, finish_reason text, duration_ms integer, is_final boolean, superseded_by_pass text)
      ),
      ins as (
        insert into document_page_extracts as t (document_id, org_id, project_id, run_id, page_number, pass, method, engine,
          member_id, region, billed_class, tags, confidence, plausibility, text_bytes, finish_reason, duration_ms, is_final,
          superseded_by_pass)
        select document_id, org_id, project_id, run_id, page_number, pass, method, engine, member_id, region, billed_class,
          array(select distinct x from unnest(coalesce(tags, '{}')) as x order by x), confidence, plausibility, text_bytes, finish_reason, duration_ms, is_final, superseded_by_pass
        from r
        on conflict (document_id, page_number, run_id, pass) do update set
          method = excluded.method, engine = excluded.engine, member_id = excluded.member_id, region = excluded.region,
          billed_class = excluded.billed_class,
          -- Tags merged by a later stage (routing) survive a retried write of the same pass.
          tags = array(select distinct x from unnest(t.tags || excluded.tags) as x order by x),
          confidence = excluded.confidence, plausibility = excluded.plausibility, text_bytes = excluded.text_bytes,
          finish_reason = excluded.finish_reason, duration_ms = excluded.duration_ms, is_final = excluded.is_final,
          superseded_by_pass = excluded.superseded_by_pass, updated_at = now()
        where t.org_id = excluded.org_id
        returning t.document_id, t.org_id, t.page_number, t.run_id, t.pass, t.is_final
      )
      update document_page_extracts o
      set is_final = false, superseded_by_pass = ins.pass, updated_at = now()
      from ins
      where ins.is_final and o.is_final
        and o.document_id = ins.document_id and o.page_number = ins.page_number and o.org_id = ins.org_id
        and (o.run_id <> ins.run_id or o.pass <> ins.pass)
        and not exists (select 1 from r where r.document_id = o.document_id and r.page_number = o.page_number
          and r.run_id = o.run_id and r.pass = o.pass)
    `);
  }
  for (let start = 0; start < tagMerges.length; start += ROWS_PER_STATEMENT) {
    const batch = tagMerges.slice(start, start + ROWS_PER_STATEMENT);
    statements.push(client`
      update document_page_extracts t
      set tags = array(select distinct x from unnest(t.tags || m.tags) as x order by x), updated_at = now()
      from (
        select document_id, org_id, run_id, page_number, array_agg(distinct tag) as tags
        from jsonb_to_recordset(${client.json(batch as never)}::jsonb) as r(
          document_id text, org_id text, run_id text, page_number integer, tags text[])
        cross join lateral unnest(r.tags) as tag
        group by document_id, org_id, run_id, page_number
      ) m
      where t.document_id = m.document_id and t.page_number = m.page_number and t.run_id = m.run_id and t.org_id = m.org_id
        and not (t.tags @> m.tags)
    `);
  }
  return statements;
}

/** OCR reader labels (ocr/read-document.ts `reader`) as a method and route. Model ids after the prefix are never kept. */
export function ocrReaderProvenance(reader: string): { method: PageExtractMethod; engine: string } {
  if (reader.startsWith("page-reader:")) return { method: "ocr-second-read", engine: "gpu-page-reader" };
  if (reader.startsWith("escalated:")) return { method: "ocr-second-read", engine: "ocr-escalation" };
  if (reader.startsWith("hosted:")) return { method: "ocr", engine: "hosted-ocr" };
  return { method: "ocr", engine: "page-ocr" };
}

/** Plain UTF-8 bytes of a page's text (a size label, never the text). */
export function pageTextBytes(text: string | null | undefined): number | null {
  return typeof text === "string" ? Buffer.byteLength(text, "utf8") : null;
}

/** One page the extraction's scan-fill OCR read (extract-markdown ocrScannedPdfPages). */
export interface ScanFillPageRead {
  reader: string;
  confidence: number | null;
  durationMs: number | null;
  escalationHeld?: "capped" | "unfunded";
}

/** Below this OCR mean confidence a page is tagged `low-confidence` (the recogniser's own escalation threshold). */
export const LOW_CONFIDENCE_BELOW = 0.8;

const HAS_WORDS = /[\p{L}\p{N}]/u;

function ocrClass(ocrPageClass: boolean): PageExtractBilledClass {
  return ocrPageClass ? "ocr" : "rich";
}

function ocrTags(read: { confidence: number | null; escalationHeld?: "capped" | "unfunded" }): PageExtractTag[] {
  const tags: PageExtractTag[] = ["scanned"];
  if (read.confidence !== null && read.confidence < LOW_CONFIDENCE_BELOW) tags.push("low-confidence");
  if (read.escalationHeld === "capped") tags.push("escalation-capped");
  if (read.escalationHeld === "unfunded") tags.push("escalation-unfunded");
  return tags;
}

/**
 * The records the extraction stage writes for one document, from what it already knows (pure; no text is kept):
 * - `extract`: every page, as the winning extractor produced it: `text-layer`, `ocr` when the winner read the page with
 *   OCR (an image, or the PDF pages it reports OCR'd), or `none` when the page had no words;
 * - `scan-ocr`: the pages without words the OCR engine then read (`ocr`, or `ocr-second-read` when the page reader or an
 *   escalation read replaced the first read), superseding `extract`;
 * - `critique`: the pages self-critique corrected (`correction`), superseding the pass before it.
 * Records come in pass order per page; recordPageExtracts leaves exactly one final, naming the superseding pass.
 */
export function extractionPageRecords(args: {
  pageCount: number;
  /** The final text per page (after scan-fill, critique and normalization), or null when it has no reliable page breaks. */
  finalPages: readonly string[] | null;
  extractor: string;
  /** Every page was read by the OCR engine (an image document). */
  imageOcr: boolean;
  winnerOcrPages: Iterable<number>;
  scanFill: ReadonlyMap<number, ScanFillPageRead> | null;
  ocrFailedPages: ReadonlySet<number>;
  critiquePages: Iterable<number>;
  ocrPageClass: boolean;
  plausibility: number | null;
  extractMs: number | null;
}): PageExtractInput[] {
  const pageCount = Math.min(MAX_PAGE, Math.max(1, Math.trunc(args.pageCount) || 1));
  const winnerOcr = new Set(args.winnerOcrPages);
  const critique = new Set(args.critiquePages);
  const perPageMs = args.extractMs !== null && args.extractMs >= 0 ? Math.round(args.extractMs / pageCount) : null;
  const records: PageExtractInput[] = [];
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const text = args.finalPages?.[pageNumber - 1];
    const textBytes = text === undefined ? null : pageTextBytes(text);
    const scan = args.scanFill?.get(pageNumber) ?? null;
    const corrected = critique.has(pageNumber);
    const failed = args.ocrFailedPages.has(pageNumber);
    const ocrByWinner = args.imageOcr || winnerOcr.has(pageNumber);
    const empty = text !== undefined && !HAS_WORDS.test(text);
    // The extract pass: what the winner gave this page before any later pass replaced it.
    const keptAsImage = args.extractor === "image-textless";
    const extractMethod: PageExtractMethod = keptAsImage ? "kept-as-image" : scan ? "none" : ocrByWinner ? "ocr" : empty ? "none" : "text-layer";
    const extractTags: PageExtractTag[] = keptAsImage ? ["image-only"] : [];
    if (scan || ocrByWinner || failed) extractTags.push("scanned");
    if (failed) extractTags.push("failed");
    if (args.imageOcr) extractTags.push("image-only");
    const extractFinal = !scan && !corrected;
    records.push({
      pageNumber, pass: "extract", method: extractMethod, engine: args.extractor,
      billedClass: extractMethod === "ocr" ? ocrClass(args.ocrPageClass) : extractMethod === "text-layer" ? "fast" : null,
      // Written final; a later pass of this page supersedes it in recordPageExtracts (superseded_by_pass).
      tags: extractTags, plausibility: args.plausibility, durationMs: perPageMs, isFinal: true,
      // Only the final pass's size is the page's text; an earlier pass is not re-measured.
      textBytes: extractFinal ? textBytes : null,
    });
    if (scan) {
      const route = ocrReaderProvenance(scan.reader);
      const scanFinal = !corrected;
      records.push({
        pageNumber, pass: "scan-ocr", method: route.method, engine: route.engine,
        billedClass: route.method === "ocr" ? ocrClass(args.ocrPageClass) : "rich",
        tags: ocrTags(scan), confidence: scan.confidence, durationMs: scan.durationMs, isFinal: true,
        textBytes: scanFinal ? textBytes : null,
      });
    }
    if (corrected) {
      records.push({
        pageNumber, pass: "critique", method: "correction", engine: "self-critique",
        tags: scan ? ["scanned"] : [], plausibility: args.plausibility, isFinal: true, textBytes,
      });
    }
  }
  return records;
}

/** Vision stage page outcomes that keep a page's earlier text, as tags. */
const VISION_SKIP_TAGS: Partial<Record<string, PageExtractTag>> = {
  rejected: "rejected",
  "ladder-capped": "ladder-capped",
  "document-page-limit": "escalation-capped",
  "document-attempt-limit": "escalation-capped",
  "blank-render": "blank",
};

/**
 * The records the vision stage writes for one document (pure; no text is kept). A page vision read is `vision`
 * (`ocr` when the stage read a scan beside native text with the OCR engine), final when reconciliation accepted it, or
 * when no reconciliation ran; a rejected read stays non-final and tagged. A selected page with no output is recorded
 * non-final with why (`failed`, `rejected`, `ladder-capped`, ...), so the earlier pass stays the page's source.
 */
export function visionPageRecords(args: {
  outputs: ReadonlyArray<{ pageNumber: number; runtime: string; text: string; latencyMs: number; finishReason?: string | null }>;
  skips: ReadonlyArray<{ pageNumber: number; outcome: string }>;
  reconciliation: { changedPages: readonly number[]; decisions: ReadonlyArray<{ pageNumber: number; outcome: string }> };
  ocrPageClass: boolean;
}): PageExtractInput[] {
  const reconciled = args.reconciliation.decisions.length > 0;
  const accepted = new Set(args.reconciliation.changedPages);
  const records: PageExtractInput[] = [];
  const seen = new Set<number>();
  for (const output of args.outputs) {
    if (seen.has(output.pageNumber)) continue;
    seen.add(output.pageNumber);
    const final = !reconciled || accepted.has(output.pageNumber);
    const ocr = output.runtime === "ocr-vm";
    const engine = ocr ? "page-ocr" : output.runtime === "page-reader" ? "gpu-page-reader"
      : output.runtime === "chart-export" ? "chart-export" : "vision-model";
    const tags: PageExtractTag[] = ocr ? ["scanned"] : [];
    if (!final) tags.push("rejected");
    if (pageExtractFinishReason(output.finishReason) === "length") tags.push("truncated");
    records.push({
      pageNumber: output.pageNumber, pass: "vision", method: ocr ? "ocr" : "vision", engine,
      billedClass: ocr ? ocrClass(args.ocrPageClass) : "rich", tags,
      finishReason: output.finishReason ?? (output.text.trim() ? null : "empty"),
      durationMs: output.latencyMs, textBytes: final ? pageTextBytes(output.text) : null, isFinal: final,
    });
  }
  for (const skip of args.skips) {
    if (seen.has(skip.pageNumber)) continue;
    seen.add(skip.pageNumber);
    const tag = VISION_SKIP_TAGS[skip.outcome] ?? "failed";
    records.push({ pageNumber: skip.pageNumber, pass: "vision", method: "none", engine: "vision-model", tags: [tag], isFinal: false });
  }
  return records;
}

/**
 * Tags routing learned for each page (classify-route's decision surface): tables, math, a garbled text layer, drawn
 * content, a structured-text yield deficit, a raster page sent to a read, a blank page. Pure; signals are routing tokens.
 */
export function routingPageTags(
  pages: ReadonlyArray<{
    pageNumber: number;
    route: string;
    signals: readonly string[];
    specializedContent?: ReadonlyArray<{ kind: string }>;
    ocrDecision?: { authorized: boolean; signals: readonly string[] } | undefined;
  }>,
  readReason: (signals: readonly string[]) => string,
  blankSignal: string,
): Map<number, PageExtractTag[]> {
  const out = new Map<number, PageExtractTag[]>();
  for (const page of pages) {
    const tags: PageExtractTag[] = [];
    if (page.route === "table-heavy") tags.push("table");
    if (page.route === "formula-heavy" || page.specializedContent?.some((entry) => entry.kind === "formula")) tags.push("math");
    if (page.signals.includes("garbled-text")) tags.push("garbled-text-layer");
    if (page.ocrDecision?.authorized) {
      const reason = readReason(page.ocrDecision.signals);
      if (reason === "garbled") tags.push("garbled-text-layer");
      else if (reason === "drawn") tags.push("drawn");
      else if (reason === "yield-deficit") tags.push("yield-deficit");
      else if (reason === "raster") tags.push("scanned");
    } else if (page.ocrDecision?.signals.includes(blankSignal)) {
      tags.push("blank");
    }
    if (tags.length) out.set(page.pageNumber, tags);
  }
  return out;
}

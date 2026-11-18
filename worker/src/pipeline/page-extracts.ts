/**
 * Page extract records (document_page_extracts, migration 0188; docs/extraction/page-extract-records.md): one labelled
 * row per (document, page, run, pass) saying how the page's text was produced. Stages queue records on the workflow state
 * (`recordPageExtracts`, `tagPageExtracts`); the next progress checkpoint writes them in its own pipelined transaction
 * (`pageExtractStatements`): one multi-row upsert and at most one tag merge per checkpoint, never a statement per page.
 *
 * Labels only: no page text, document-supplied value or model id is ever recorded. Every value is checked against the
 * closed vocabularies in @docslurp/shared (and again by the database's CHECK constraints). A run without an organization
 * records nothing: a row is always scoped to its organization.
 *
 * Idempotent: the primary key is (document, page, run, pass) and the write is an upsert, so a retried stage or checkpoint
 * rewrites the same rows. Stages record which passes they adopted; the one final row per page is set only when the
 * document completes in its current run (finalizePageExtracts), never by a stale run.
 */
import {
  modelClassLabel,
  modelRecordUri,
  normalizePageExtractTags,
  PAGE_EXTRACT_PASSES,
  PAGE_EXTRACT_ENGINE_PATTERN,
  PAGE_EXTRACT_FINISH_REASONS,
  PAGE_EXTRACT_MEMBER_PATTERN,
  PAGE_EXTRACT_REGION_PATTERN,
  type ModelCallClass,
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
  /** This pass's text was taken for the page in this run (default true); false records a pass that gave nothing usable. */
  adopted?: boolean;
  /** The model that served this pass, as an `llm://` URI (shared model-provenance.ts); unset when no model did. */
  modelUri?: string | null;
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
  adopted: boolean;
  model_uri: string | null;
  /** The run's levels (quality, profiles) at the time, when a model served the pass. */
  model_class: string | null;
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
  /** The run's levels as the usage ledger records them (pipeline.ts runModelClass); optional for callers without a ledger. */
  usageLedger?: { modelClass: ModelCallClass | null };
  pendingPageExtracts: PageExtractRow[];
  pendingPageExtractTags: PageExtractTagMerge[];
}

/** A stored model URI, or null: the column's own check, so one odd value never fails a checkpoint. */
function modelUri(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length <= 400 && /^llm:\/\/[a-z0-9][a-z0-9.-]*\//.test(value) ? value : null;
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
 * Queues one document's records for the next checkpoint: O(1) per record (a 20,000-page document queues in
 * milliseconds; nothing here scans the queue). A record for a key queued twice is written once, the later one winning
 * (pageExtractStatements). `adopted` says the pass's text was taken for the page in this run; which row is final is
 * decided only when the document completes (finalizePageExtracts).
 */
export function recordPageExtracts(
  state: PageExtractState,
  document: { id: string; projectId?: string },
  inputs: readonly PageExtractInput[],
): void {
  const owner = scope(state, document);
  if (!owner || inputs.length === 0) return;
  const pending = state.pendingPageExtracts;
  const modelClass = modelClassLabel(state.usageLedger?.modelClass);
  const counts = new Map<string, { labels: Record<string, string>; n: number }>();
  const count = (name: string, labels: Record<string, string>) => {
    const key = `${name}\u0000${Object.values(labels).join("\u0000")}`;
    const entry = counts.get(key);
    if (entry) entry.n += 1;
    else counts.set(key, { labels: { ...labels, metric: name }, n: 1 });
  };
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
      adopted: input.adopted ?? true,
      model_uri: modelUri(input.modelUri),
      model_class: modelUri(input.modelUri) ? modelClass : null,
    };
    pending.push(row);
    count("pages.extracts", { method: row.method, pass: row.pass, adopted: row.adopted ? "true" : "false",
      member: row.member_id ? "pool" : "none", class: row.billed_class ?? "none" });
    for (const tag of row.tags) count("pages.extract_tags", { tag, method: row.method });
  }
  // One counter add per label set, not per page.
  for (const { labels: { metric, ...labels }, n } of counts.values()) recordPipelineTelemetry(metric!, n, labels);
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
  const counts = new Map<string, number>();
  for (const [pageNumber, raw] of pageTags) {
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > MAX_PAGE) continue;
    const tags = normalizePageExtractTags(raw);
    if (tags.length === 0) continue;
    state.pendingPageExtractTags.push({ document_id: document.id, org_id: owner.orgId, run_id: state.run.id, page_number: pageNumber, tags });
    for (const tag of tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  for (const [tag, n] of counts) recordPipelineTelemetry("pages.extract_tags", n, { tag, source: "routing" });
}

/** Rows per statement: well under the 65,535 bind limit (the payload is one jsonb parameter anyway). */
const ROWS_PER_STATEMENT = 2_000;

function documentIdsOf(rows: ReadonlyArray<{ document_id: string }>): string[] {
  return [...new Set(rows.map((row) => row.document_id))].sort();
}

function rowKey(row: { document_id: string; page_number: number; run_id: string; pass: string }): string {
  return `${row.document_id}\u0000${row.page_number}\u0000${row.run_id}\u0000${row.pass}`;
}

/**
 * The checkpoint's statements for the queued records and tag merges (none when nothing is queued): one upsert per 2,000
 * records (a key queued twice is written once, the later record winning, so no statement updates a row twice) and one
 * tag merge per 2,000 merges. Every write is filtered by organization. These never touch `is_final`.
 */
export function pageExtractStatements(
  client: Sql<Record<string, unknown>>,
  queued: readonly PageExtractRow[],
  tagMerges: readonly PageExtractTagMerge[],
): PendingQuery<any>[] {
  const latest = new Map<string, PageExtractRow>();
  for (const row of queued) {
    const key = rowKey(row);
    latest.delete(key);
    latest.set(key, row);
  }
  const rows = [...latest.values()];
  const statements: PendingQuery<any>[] = [];
  for (let start = 0; start < rows.length; start += ROWS_PER_STATEMENT) {
    const batch = rows.slice(start, start + ROWS_PER_STATEMENT);
    statements.push(client`
      insert into document_page_extracts as t (document_id, org_id, project_id, run_id, page_number, pass, method, engine,
        member_id, region, billed_class, tags, confidence, plausibility, text_bytes, finish_reason, duration_ms, adopted,
        model_uri, model_class)
      select document_id, org_id, project_id, run_id, page_number, pass, method, engine, member_id, region, billed_class,
        array(select distinct x from unnest(coalesce(tags, '{}')) as x order by x), confidence, plausibility, text_bytes,
        finish_reason, duration_ms, adopted, model_uri, model_class
      from jsonb_to_recordset(${client.json(batch as never)}::jsonb) as r(
        document_id text, org_id text, project_id text, run_id text, page_number integer, pass text, method text,
        engine text, member_id text, region text, billed_class text, tags text[], confidence real, plausibility real,
        text_bytes integer, finish_reason text, duration_ms integer, adopted boolean, model_uri text, model_class text)
      -- Lock order: the documents' rows first (an init plan, in id order), then extract rows, as finalization does.
      where (select count(*) from (select 1 from documents where id = any(${client.array(documentIdsOf(batch))}::text[])
        order by id for no key update) locked) >= 0
      on conflict (document_id, page_number, run_id, pass) do update set
        method = excluded.method, engine = excluded.engine, member_id = excluded.member_id, region = excluded.region,
        billed_class = excluded.billed_class,
        -- Tags merged by a later stage (routing) survive a retried write of the same pass.
        tags = array(select distinct x from unnest(t.tags || excluded.tags) as x order by x),
        confidence = excluded.confidence, plausibility = excluded.plausibility, text_bytes = excluded.text_bytes,
        finish_reason = excluded.finish_reason, duration_ms = excluded.duration_ms, adopted = excluded.adopted,
        model_uri = excluded.model_uri, model_class = excluded.model_class,
        -- A withdrawn pass (a retry that rejected it) can no longer be final; finalization picks the next adopted one.
        is_final = t.is_final and excluded.adopted, updated_at = now()
      where t.org_id = excluded.org_id
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
        -- Lock order: the documents' rows first (an init plan, in id order), then extract rows.
        and (select count(*) from (select 1 from documents where id = any(${client.array(documentIdsOf(batch))}::text[])
          order by id for no key update) locked) >= 0
    `);
  }
  return statements;
}

/** Pass order within a run is PAGE_EXTRACT_PASSES order: a later pass that adopted a page's text replaces an earlier one. */
/**
 * Sets each page's one final row for documents that completed in `runId` (`pages` absent), or for the pages a query-time
 * materialization of `runId` just published (`pages` given):
 * - the page's final is the highest-ranked adopted pass of `runId` (so a retry that withdrew a pass restores the one
 *   before it), and every other row of the page, of any run, stops being final, naming that pass as its replacement;
 * - completing a document clears older runs' finals on pages `runId` has no adopted row for (past a shorter reprocess's
 *   page count, or never read); a query-time read leaves them, except on pages it found PII on (`pii-withheld`);
 * - nothing changes on a page a newer run (by creation time) already finalized: an older run's late or retried
 *   completion never overrides it;
 * - for whole documents, only documents whose current run is `runId` (documents.run_id): a failed or stale run never
 *   finalizes, so a failed reprocess leaves the previous run's finals in place.
 *
 * Two statements, demotions first, so the partial unique index (one final row per page) never sees two finals mid-update.
 * Lock order: callers hold the documents' row locks (FOR NO KEY UPDATE, or the UPDATE of a completion) before these touch
 * extract rows; every other writer of extract rows takes the same documents locks first (pageExtractStatements), so two
 * finalizations of one document serialize and nothing inverts. The second statement returns `run_found` (0 when the run
 * is not in the organization) and `changed`; pass its rows to logFinalizeOutcome.
 */
export function finalizePageExtracts(
  client: Sql<Record<string, unknown>>,
  scope: { orgId: string; runId: string; documentIds: readonly string[] | "completed-in-run"; pages?: readonly number[] },
): [PendingQuery<any>, PendingQuery<{ run_found: number; changed: number }[]>] {
  // "completed-in-run": every completed, current document of the run (run completion sends this beside the statement
  // that completes them, so it needs no round trip of its own).
  const inRun = scope.documentIds === "completed-in-run";
  const documentFilter = inRun
    ? client`and d.status = 'completed' and d.superseded_at is null`
    : client`and e.document_id = any(${client.array([...(scope.documentIds as readonly string[])])}::text[])`;
  const pagesOnly = scope.pages !== undefined;
  const pages = [...(scope.pages ?? [])];
  const passes = client.array([...PAGE_EXTRACT_PASSES]);
  // One pass over the document's rows (window functions per page, no join between derived row sets), then a primary-key
  // update of the rows that change: linear in the document's rows, whatever its page count.
  const target = () => client`
    me as (select created_at from project_runs where id = ${scope.runId} and org_id = ${scope.orgId}),
    ranked as (
      select e.document_id, e.page_number, e.run_id, e.pass, e.adopted, e.is_final, e.superseded_by_pass,
        array_position(${passes}::text[], e.pass) as rank,
        max(case when e.run_id = ${scope.runId} and e.adopted and e.page_number <= greatest(d.page_count, 1)
          then array_position(${passes}::text[], e.pass) end) over page as final_rank,
        bool_or(e.is_final and e.run_id <> ${scope.runId} and coalesce(nr.created_at > me.created_at, false)) over page as held,
        bool_or(e.run_id = ${scope.runId} and 'pii-withheld' = any(e.tags)) over page as withheld
      from document_page_extracts e
      join documents d on d.id = e.document_id and d.org_id = ${scope.orgId}
        ${pagesOnly ? client`` : client`and d.run_id = ${scope.runId}`}
      cross join me
      left join project_runs nr on nr.id = e.run_id
      where e.org_id = ${scope.orgId} ${documentFilter}
        ${pagesOnly ? client`and e.page_number = any(${pages}::int[])` : client``}
      window page as (partition by e.document_id, e.page_number)
    ),
    target as (
      select document_id, page_number, run_id, pass,
        (final_rank is not null and run_id = ${scope.runId} and rank = final_rank) as next_final,
        case when final_rank is not null and adopted and not (run_id = ${scope.runId} and rank = final_rank)
          then (${passes}::text[])[final_rank] end as next_superseded,
        is_final, superseded_by_pass
      from ranked
      where not held and (final_rank is not null ${pagesOnly ? client`or withheld` : client`or true`})
    )`;
  const demote = client`
    with ${target()}
    update document_page_extracts t
    set is_final = false, superseded_by_pass = x.next_superseded, updated_at = now()
    from target x
    where t.document_id = x.document_id and t.page_number = x.page_number and t.run_id = x.run_id and t.pass = x.pass
      and t.org_id = ${scope.orgId} and t.is_final and not x.next_final`;
  const promote = client<{ run_found: number; changed: number }[]>`
    with ${target()},
    changed as (
      update document_page_extracts t
      set is_final = x.next_final, superseded_by_pass = x.next_superseded, updated_at = now()
      from target x
      where t.document_id = x.document_id and t.page_number = x.page_number and t.run_id = x.run_id and t.pass = x.pass
        and t.org_id = ${scope.orgId}
        and (t.is_final is distinct from x.next_final or t.superseded_by_pass is distinct from x.next_superseded)
      returning 1
    )
    select (select count(*) from me)::int as run_found, (select count(*) from changed)::int as changed`;
  return [demote, promote];
}

/** Says loudly when a finalization found no run row in the organization (it then changed nothing). */
export function logFinalizeOutcome(rows: ReadonlyArray<{ run_found: number; changed: number }> | undefined, scope: { runId: string; documentIds: readonly string[] | "completed-in-run" }): void {
  const row = rows?.[0];
  if (!row || row.run_found === 0) {
    const documents = typeof scope.documentIds === "string" ? scope.documentIds : String(scope.documentIds.length);
    console.error(`[page-extracts] finalize-skipped run=${scope.runId} documents=${documents} reason=run-not-in-organization`);
  }
}

/**
 * OCR reader labels (ocr/read-document.ts `reader`) as a method and route. The engine stays a route word; the model
 * id after a prefix is kept only as the read's `modelUri` (the operator-facing column), never in `engine`.
 */
export function ocrReaderProvenance(reader: string): { method: PageExtractMethod; engine: string; modelUri: string | null } {
  const named = (engine: string, prefix: string) => modelRecordUri({ provider: engine, model: reader.slice(prefix.length) });
  if (reader.startsWith("page-reader:")) return { method: "ocr-second-read", engine: "gpu-page-reader", modelUri: named("gpu-page-reader", "page-reader:") };
  if (reader.startsWith("escalated:")) return { method: "ocr-second-read", engine: "ocr-escalation", modelUri: named("ocr-escalation", "escalated:") };
  if (reader.startsWith("hosted:")) return { method: "ocr", engine: "hosted-ocr", modelUri: named("hosted-ocr", "hosted:") };
  // The local recogniser set (`latin`, `multi`, …) of the OCR engine; `none` is an empty frame nothing read.
  return { method: "ocr", engine: "page-ocr", modelUri: reader === "none" ? null : modelRecordUri({ provider: "page-ocr", model: reader }) };
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
 * Every pass that gave the page its text is adopted; finalization keeps the highest-ranked one per page.
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
  /** The run's quality reads pages without a text layer; false (Fast) keeps them as page images. */
  readsPages?: boolean;
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
    const keptAsImage = args.extractor === "image-textless" || (args.readsPages === false && empty && !scan && !ocrByWinner);
    const extractMethod: PageExtractMethod = keptAsImage ? "kept-as-image" : scan ? "none" : ocrByWinner ? "ocr" : empty ? "none" : "text-layer";
    const extractTags: PageExtractTag[] = keptAsImage ? ["image-only"] : [];
    if (scan || ocrByWinner || failed) extractTags.push("scanned");
    if (failed) extractTags.push("failed");
    if (args.imageOcr) extractTags.push("image-only");
    const extractFinal = !scan && !corrected;
    records.push({
      pageNumber, pass: "extract", method: extractMethod, engine: args.extractor,
      billedClass: extractMethod === "ocr" ? ocrClass(args.ocrPageClass) : extractMethod === "text-layer" ? "fast" : null,
      // Adopted; a later adopted pass of this page outranks it when the document is finalized.
      tags: extractTags, plausibility: args.plausibility, durationMs: perPageMs, adopted: true,
      // Only the final pass's size is the page's text; an earlier pass is not re-measured.
      textBytes: extractFinal ? textBytes : null,
    });
    if (scan) {
      const route = ocrReaderProvenance(scan.reader);
      const scanFinal = !corrected;
      records.push({
        pageNumber, pass: "scan-ocr", method: route.method, engine: route.engine,
        billedClass: route.method === "ocr" ? ocrClass(args.ocrPageClass) : "rich",
        tags: ocrTags(scan), confidence: scan.confidence, durationMs: scan.durationMs, adopted: true,
        textBytes: scanFinal ? textBytes : null, modelUri: route.modelUri,
      });
    }
    if (corrected) {
      records.push({
        pageNumber, pass: "critique", method: "correction", engine: "self-critique",
        tags: scan ? ["scanned"] : [], plausibility: args.plausibility, adopted: true, textBytes,
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
  outputs: ReadonlyArray<{ pageNumber: number; runtime: string; text: string; latencyMs: number; finishReason?: string | null;
    model?: string; provider?: string; reader?: string }>;
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
      durationMs: output.latencyMs, textBytes: final ? pageTextBytes(output.text) : null, adopted: final,
      // The same provider and model as the read's usage row; an OCR read is named by its reader. Unknown stays unset.
      modelUri: output.reader ? ocrReaderProvenance(output.reader).modelUri
        : output.provider && !ocr ? modelRecordUri({ provider: output.provider, model: output.model }) : null,
    });
  }
  for (const skip of args.skips) {
    if (seen.has(skip.pageNumber)) continue;
    seen.add(skip.pageNumber);
    const tag = VISION_SKIP_TAGS[skip.outcome] ?? "failed";
    records.push({ pageNumber: skip.pageNumber, pass: "vision", method: "none", engine: "vision-model", tags: [tag], adopted: false });
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

/**
 * The records a query-time materialization writes for the pages it held (deferred/materialize-pages.ts): a published page
 * is its text layer (`extract`) or a model read (`vision`), a page Fast keeps unread is `kept-as-image`; pages the PII
 * policy blocked and pages that failed are recorded, not adopted.
 */
export function materializedPageRecords(args: {
  published: readonly number[];
  modelRead: (page: number) => boolean;
  blocked: readonly number[];
  failed: ReadonlyArray<readonly [number, string]>;
  keptAsImageReason: string;
  /** The model that read a page in this materialization (its usage row's provider and model); unknown stays unset. */
  readModelUri?: (page: number) => string | null | undefined;
}): PageExtractInput[] {
  const records: PageExtractInput[] = [];
  for (const page of args.published) {
    records.push(args.modelRead(page)
      ? { pageNumber: page, pass: "vision", method: "vision", engine: "vision-model", billedClass: "rich", modelUri: args.readModelUri?.(page) ?? null }
      : { pageNumber: page, pass: "extract", method: "text-layer", engine: "page-text", billedClass: "fast" });
  }
  for (const page of args.blocked) records.push({ pageNumber: page, pass: "extract", method: "none", tags: ["pii-withheld"], adopted: false });
  for (const [page, reason] of args.failed) {
    records.push(reason === args.keptAsImageReason
      ? { pageNumber: page, pass: "extract", method: "kept-as-image", tags: ["image-only"] }
      : { pageNumber: page, pass: "extract", method: "none", tags: ["failed"], adopted: false });
  }
  return records;
}

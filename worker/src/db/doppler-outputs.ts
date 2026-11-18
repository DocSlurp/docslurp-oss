/*
 * The Doppler output record (migration 0190): one `document_doppler_outputs` row per document whose Markdown Doppler
 * wrote, saying where each output of that run is stored and the key fields Doppler measured. The figure files, their
 * manifests and the images level stay in the asset ledger (document-asset-ledger.ts); this record covers the rest
 * (Markdown, page facts, layout facts, Doppler's build and its run line) so every Doppler document has one auditable
 * row, including why an output is missing.
 *
 * Rules:
 * - Queued on the run's state and written after the checkpoint that commits the document's Markdown (Store.writeProgress),
 *   never before, like the asset ledger: the record only describes objects a committed checkpoint references.
 * - Scope: the organization and project are the run's and must be the document's own; the run must be the document's
 *   current run, never older than the run that wrote the existing record (`stale-write`). Every key is compared exactly
 *   to the key derived from the run's artifact root (`key-mismatch`), so a record can never point outside the document's
 *   own tenant-scoped prefix. Fail closed: a refused write stores nothing and is logged with a fixed rule.
 * - Values are validated integers, hashes, fixed vocabularies and Doppler's own build strings. Nothing from the document
 *   (no text, no producer, creator, title, /Count or version the PDF carries) is stored.
 * - Never fails the document: a refused or failed write is logged, the stage result stands.
 * - Reads never fail as a whole: a row that does not validate is skipped and logged (readDopplerOutputs).
 */
import type { Sql } from "postgres";
import { DOPPLER_BUILD, dopplerDocumentPrefix, DOPPLER_STORE_LAYOUT } from "@docslurp/shared";

export const DOPPLER_PAGE_FACTS_STATUSES = ["stored", "absent", "off", "refused", "failed"] as const;
export type DopplerPageFactsStatus = (typeof DOPPLER_PAGE_FACTS_STATUSES)[number];
export const DOPPLER_SERVED_BY = ["vm", "first-pass"] as const;
export type DopplerServedBy = (typeof DOPPLER_SERVED_BY)[number];

export const DOPPLER_VERSION = /^[0-9]+(\.[0-9]+){0,3}$/;
export const DOPPLER_COMMIT = /^[0-9a-f]{7,40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const EXTRACTOR = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DOCUMENT_ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_KEY = 1024;
const MAX_INT = 2_147_483_647;

export interface DopplerOutputsScope {
  orgId: string;
  projectId: string;
  documentId: string;
  runId: string;
}

/** What a stage knows about one document's Doppler outputs (keys relative to the bucket, as stored). */
export interface DopplerOutputsRecord {
  extractor: string;
  servedBy: DopplerServedBy;
  build: { reported: string | null; version: string | null; commit: string | null };
  markdown: { key: string; sha256: string; bytes: number };
  pageFacts:
    | { status: "stored"; key: string; sha256: string; bytes: number; pagesKnown: number; pagesFailed: number; linesDropped: number; complete: boolean }
    | { status: Exclude<DopplerPageFactsStatus, "stored">; pagesKnown?: number; pagesFailed?: number; linesDropped?: number; complete?: boolean };
  layoutFacts: { key: string; pages: number } | null;
  engine: { pagesEmitted: number | null; pagesFailed: number | null; ms: number | null; peakRssKiB: number | null };
  ocrPages: number;
}

export type DopplerOutputsRule = "invalid-scope" | "invalid-record" | "scope-mismatch" | "stale-write" | "key-mismatch" | "write-mismatch";

export class DopplerOutputsError extends Error {
  constructor(readonly rule: DopplerOutputsRule) {
    super(`Doppler output record refused: ${rule}`);
    this.name = "DopplerOutputsError";
  }
}

const isCount = (value: unknown, max = MAX_INT): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;
const optCount = (value: unknown, max = MAX_INT): number | null => (isCount(value, max) ? value : null);
const isKey = (key: unknown): key is string => typeof key === "string" && key.length > 0 && key.length <= MAX_KEY &&
  !key.startsWith("/") && !key.includes("..") && !key.includes("//") && !/[\u0000-\u001f\u007f]/.test(key);

function assertScope(scope: DopplerOutputsScope): void {
  if (!scope || typeof scope.orgId !== "string" || !ID.test(scope.orgId) || typeof scope.projectId !== "string" || !ID.test(scope.projectId) ||
      typeof scope.documentId !== "string" || !DOCUMENT_ID.test(scope.documentId) || typeof scope.runId !== "string" || !ID.test(scope.runId)) {
    throw new DopplerOutputsError("invalid-scope");
  }
}

/** The keys a record may name, derived from the run's artifact root (the asset ledger's rule). */
export function dopplerOutputKeys(root: string, documentId: string, extractor: string): { markdown: string; pageFacts: string; layoutFacts: string } {
  return {
    markdown: `${root}/markdown/${documentId}.${extractor}.md`,
    pageFacts: `${dopplerDocumentPrefix(root, documentId)}${DOPPLER_STORE_LAYOUT.imagesFolder}${DOPPLER_STORE_LAYOUT.pageFacts}`,
    layoutFacts: `${root}/page-layout-facts/${documentId}.json`,
  };
}

/** The record re-validated value by value (a caller cannot write free text or an out-of-vocabulary value). */
export function checkedDopplerOutputs(record: DopplerOutputsRecord): DopplerOutputsRecord {
  const r = record as Partial<DopplerOutputsRecord> | null | undefined;
  if (!r || typeof r !== "object") throw new DopplerOutputsError("invalid-record");
  if (typeof r.extractor !== "string" || !EXTRACTOR.test(r.extractor)) throw new DopplerOutputsError("invalid-record");
  if (!(DOPPLER_SERVED_BY as readonly string[]).includes(r.servedBy as string)) throw new DopplerOutputsError("invalid-record");
  const build = r.build ?? { reported: null, version: null, commit: null };
  const reported = build.reported ?? null;
  const version = build.version ?? null;
  const commit = build.commit ?? null;
  if ((reported !== null && !(typeof reported === "string" && DOPPLER_BUILD.test(reported))) ||
      (version !== null && !(typeof version === "string" && DOPPLER_VERSION.test(version))) ||
      (commit !== null && !(typeof commit === "string" && DOPPLER_COMMIT.test(commit)))) {
    throw new DopplerOutputsError("invalid-record");
  }
  const md = r.markdown;
  if (!md || !isKey(md.key) || typeof md.sha256 !== "string" || !SHA256.test(md.sha256) || !isCount(md.bytes, Number.MAX_SAFE_INTEGER)) {
    throw new DopplerOutputsError("invalid-record");
  }
  const pf = r.pageFacts;
  if (!pf || !(DOPPLER_PAGE_FACTS_STATUSES as readonly string[]).includes(pf.status)) throw new DopplerOutputsError("invalid-record");
  if (pf.status === "stored") {
    if (!isKey(pf.key) || typeof pf.sha256 !== "string" || !SHA256.test(pf.sha256) || !isCount(pf.bytes, Number.MAX_SAFE_INTEGER) ||
        !isCount(pf.pagesKnown) || !isCount(pf.pagesFailed) || !isCount(pf.linesDropped) || typeof pf.complete !== "boolean") {
      throw new DopplerOutputsError("invalid-record");
    }
  } else if ("key" in pf || "sha256" in pf) {
    throw new DopplerOutputsError("invalid-record");
  }
  const layout = r.layoutFacts ?? null;
  if (layout !== null && (!isKey(layout.key) || !isCount(layout.pages))) throw new DopplerOutputsError("invalid-record");
  const engine = r.engine ?? { pagesEmitted: null, pagesFailed: null, ms: null, peakRssKiB: null };
  if (!isCount(r.ocrPages)) throw new DopplerOutputsError("invalid-record");
  return {
    extractor: r.extractor, servedBy: r.servedBy as DopplerServedBy,
    build: { reported, version, commit },
    markdown: { key: md.key, sha256: md.sha256, bytes: md.bytes },
    pageFacts: pf.status === "stored"
      ? { status: "stored", key: pf.key, sha256: pf.sha256, bytes: pf.bytes, pagesKnown: pf.pagesKnown, pagesFailed: pf.pagesFailed, linesDropped: pf.linesDropped, complete: pf.complete }
      : { status: pf.status, ...(isCount(pf.pagesKnown) ? { pagesKnown: pf.pagesKnown } : {}), ...(isCount(pf.pagesFailed) ? { pagesFailed: pf.pagesFailed } : {}),
          ...(isCount(pf.linesDropped) ? { linesDropped: pf.linesDropped } : {}), ...(typeof pf.complete === "boolean" ? { complete: pf.complete } : {}) },
    layoutFacts: layout ? { key: layout.key, pages: layout.pages } : null,
    engine: {
      pagesEmitted: optCount(engine.pagesEmitted), pagesFailed: optCount(engine.pagesFailed),
      ms: optCount(engine.ms, Number.MAX_SAFE_INTEGER), peakRssKiB: optCount(engine.peakRssKiB, Number.MAX_SAFE_INTEGER),
    },
    ocrPages: r.ocrPages,
  };
}

/**
 * Write one document's record: one transaction under the document's ledger lock (the asset ledger's), after checking the
 * scope against the document and its current run and every key against the run's artifact root. Upserts by document; a
 * newer run's record is never overwritten by an older one.
 */
export async function writeDopplerOutputs(sql: Sql<Record<string, unknown>>, scope: DopplerOutputsScope, input: DopplerOutputsRecord): Promise<void> {
  assertScope(scope);
  const record = checkedDopplerOutputs(input);
  const { orgId, projectId, documentId, runId } = scope;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`document-assets:${documentId}`}))`;
    const [document] = await tx<{ user_id: string; run_id: string | null }[]>`
      select user_id, run_id from documents where id = ${documentId} and org_id = ${orgId} and project_id = ${projectId} for key share`;
    if (!document) throw new DopplerOutputsError("scope-mismatch");
    const [run] = await tx<{ storage_prefix: string | null }[]>`
      select storage_prefix from project_runs where id = ${runId} and org_id = ${orgId} and project_id = ${projectId}`;
    if (!run) throw new DopplerOutputsError("scope-mismatch");
    if (document.run_id !== runId) throw new DopplerOutputsError("stale-write");
    const [existing] = await tx<{ newer: boolean }[]>`
      select coalesce(o.run_id <> ${runId} and r.created_at > (select created_at from project_runs where id = ${runId}), false) as newer
      from document_doppler_outputs o left join project_runs r on r.id = o.run_id
      where o.document_id = ${documentId} and o.org_id = ${orgId} and o.project_id = ${projectId}`;
    if (existing?.newer) throw new DopplerOutputsError("stale-write");
    const root = run.storage_prefix ?? `${document.user_id}/${runId}`;
    let expected: ReturnType<typeof dopplerOutputKeys>;
    try {
      expected = dopplerOutputKeys(root, documentId, record.extractor);
    } catch {
      throw new DopplerOutputsError("key-mismatch");
    }
    if (record.markdown.key !== expected.markdown) throw new DopplerOutputsError("key-mismatch");
    if (record.pageFacts.status === "stored" && record.pageFacts.key !== expected.pageFacts) throw new DopplerOutputsError("key-mismatch");
    if (record.layoutFacts && record.layoutFacts.key !== expected.layoutFacts) throw new DopplerOutputsError("key-mismatch");
    const pf = record.pageFacts;
    const stored = pf.status === "stored" ? pf : null;
    const written = await tx`
      insert into document_doppler_outputs (document_id, org_id, project_id, run_id, extractor, served_by, doppler_build, doppler_version,
        doppler_commit, markdown_key, markdown_sha256, markdown_bytes, page_facts_status, page_facts_key, page_facts_sha256, page_facts_bytes,
        page_facts_pages_known, page_facts_pages_failed, page_facts_lines_dropped, page_facts_complete, layout_facts_key, layout_facts_pages,
        engine_pages_emitted, engine_pages_failed, engine_ms, engine_peak_rss_kib, ocr_pages, updated_at)
      values (${documentId}, ${orgId}, ${projectId}, ${runId}, ${record.extractor}, ${record.servedBy}, ${record.build.reported},
        ${record.build.version}, ${record.build.commit}, ${record.markdown.key}, ${record.markdown.sha256}, ${record.markdown.bytes},
        ${pf.status}, ${stored?.key ?? null}, ${stored?.sha256 ?? null}, ${stored?.bytes ?? null}, ${pf.pagesKnown ?? null},
        ${pf.pagesFailed ?? null}, ${pf.linesDropped ?? null}, ${pf.complete ?? null}, ${record.layoutFacts?.key ?? null},
        ${record.layoutFacts?.pages ?? null}, ${record.engine.pagesEmitted}, ${record.engine.pagesFailed}, ${record.engine.ms},
        ${record.engine.peakRssKiB}, ${record.ocrPages}, now())
      on conflict (document_id) do update set
        run_id = excluded.run_id, extractor = excluded.extractor, served_by = excluded.served_by, doppler_build = excluded.doppler_build,
        doppler_version = excluded.doppler_version, doppler_commit = excluded.doppler_commit, markdown_key = excluded.markdown_key,
        markdown_sha256 = excluded.markdown_sha256, markdown_bytes = excluded.markdown_bytes, page_facts_status = excluded.page_facts_status,
        page_facts_key = excluded.page_facts_key, page_facts_sha256 = excluded.page_facts_sha256, page_facts_bytes = excluded.page_facts_bytes,
        page_facts_pages_known = excluded.page_facts_pages_known, page_facts_pages_failed = excluded.page_facts_pages_failed,
        page_facts_lines_dropped = excluded.page_facts_lines_dropped, page_facts_complete = excluded.page_facts_complete,
        layout_facts_key = excluded.layout_facts_key, layout_facts_pages = excluded.layout_facts_pages,
        engine_pages_emitted = excluded.engine_pages_emitted, engine_pages_failed = excluded.engine_pages_failed,
        engine_ms = excluded.engine_ms, engine_peak_rss_kib = excluded.engine_peak_rss_kib, ocr_pages = excluded.ocr_pages, updated_at = now()
      where document_doppler_outputs.org_id = excluded.org_id and document_doppler_outputs.project_id = excluded.project_id
      returning 1`;
    if (written.length !== 1) throw new DopplerOutputsError("write-mismatch");
  });
}

/** A record waiting for its checkpoint (WorkflowState.pendingDopplerOutputs). */
export interface DopplerOutputsState {
  run: { id: string; orgId?: string | null; projectId?: string | null };
  /** Markdown slots the run's committed checkpoints hold: a record is written only for a document whose Markdown committed. */
  artifactLedger: { readDocument(documentId: string, slot: string): string | undefined };
  pendingDopplerOutputs: Map<string, DopplerOutputsRecord>;
}

export type DopplerOutputsFlushStatus = "written" | "no-scope" | "no-markdown" | "refused" | "stale-write" | "failed";

/**
 * Write every queued record after its checkpoint committed. Never fails the run: a run without an organization or project,
 * a document whose Markdown slot is not committed, a refused or stale write and a database error are each logged with a
 * fixed reason.
 */
export async function flushDopplerOutputs(
  state: DopplerOutputsState,
  write: (scope: DopplerOutputsScope, record: DopplerOutputsRecord) => Promise<unknown>,
): Promise<Map<string, DopplerOutputsFlushStatus>> {
  const outcomes = new Map<string, DopplerOutputsFlushStatus>();
  const pending = [...state.pendingDopplerOutputs.entries()];
  state.pendingDopplerOutputs.clear();
  for (const [documentId, record] of pending) {
    if (!state.run.orgId || !state.run.projectId) {
      console.warn(`[doppler-outputs] document=${documentId} status=no-scope`);
      outcomes.set(documentId, "no-scope");
      continue;
    }
    if (!state.artifactLedger.readDocument(documentId, "markdown")) {
      console.warn(`[doppler-outputs] document=${documentId} status=no-markdown`);
      outcomes.set(documentId, "no-markdown");
      continue;
    }
    try {
      await write({ orgId: state.run.orgId, projectId: state.run.projectId, documentId, runId: state.run.id }, record);
      outcomes.set(documentId, "written");
    } catch (error) {
      if (error instanceof DopplerOutputsError) {
        const status = error.rule === "stale-write" ? "stale-write" : "refused";
        console.warn(`[doppler-outputs] document=${documentId} status=${status} rule=${error.rule}`);
        outcomes.set(documentId, status);
        continue;
      }
      const code = (error as { code?: unknown } | null)?.code;
      console.warn(`[doppler-outputs] document=${documentId} status=failed error=${error instanceof Error ? error.name : typeof error}${typeof code === "string" ? ` code=${code}` : ""}`);
      outcomes.set(documentId, "failed");
    }
  }
  return outcomes;
}

/** A stored record as the reader returns it. Storage keys stay server-side (never an API field). */
export interface DopplerOutputsRow extends DopplerOutputsRecord {
  documentId: string;
  runId: string | null;
  updatedAt: Date;
}

/**
 * One organization's records, a page at a time (keyset by document id). A row that does not validate (a hand edit, a
 * newer writer's vocabulary) is skipped and logged, never failing the page.
 */
export async function readDopplerOutputs(
  sql: Sql<Record<string, unknown>>,
  args: { orgId: string; projectId?: string; documentIds?: readonly string[]; after?: string; limit?: number },
): Promise<{ rows: DopplerOutputsRow[]; skipped: number; nextCursor: string | null }> {
  if (typeof args.orgId !== "string" || !ID.test(args.orgId) || (args.projectId !== undefined && !ID.test(args.projectId))) {
    throw new DopplerOutputsError("invalid-scope");
  }
  const limit = Math.max(1, Math.min(1000, Math.trunc(args.limit ?? 500)));
  const ids = args.documentIds ? [...args.documentIds].filter((id) => DOCUMENT_ID.test(id)).slice(0, 1000) : null;
  const raw = await sql<Array<Record<string, unknown>>>`
    select * from document_doppler_outputs
    where org_id = ${args.orgId}
      ${args.projectId ? sql`and project_id = ${args.projectId}` : sql``}
      ${ids ? sql`and document_id = any(${sql.array(ids)}::text[])` : sql``}
      ${args.after ? sql`and document_id > ${args.after}` : sql``}
    order by document_id limit ${limit}`;
  const rows: DopplerOutputsRow[] = [];
  let skipped = 0;
  for (const row of raw) {
    try {
      rows.push(rowToRecord(row));
    } catch {
      skipped += 1;
      console.warn(`[doppler-outputs] read skipped document=${typeof row.document_id === "string" ? row.document_id.slice(0, 64) : "?"} reason=invalid-row`);
    }
  }
  return { rows, skipped, nextCursor: raw.length === limit ? String(raw[raw.length - 1]!.document_id) : null };
}

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new DopplerOutputsError("invalid-record");
  return n;
}

function rowToRecord(row: Record<string, unknown>): DopplerOutputsRow {
  if (typeof row.document_id !== "string") throw new DopplerOutputsError("invalid-record");
  const status = row.page_facts_status as DopplerPageFactsStatus;
  const pageFacts = status === "stored"
    ? { status, key: row.page_facts_key as string, sha256: row.page_facts_sha256 as string, bytes: num(row.page_facts_bytes)!,
        pagesKnown: num(row.page_facts_pages_known)!, pagesFailed: num(row.page_facts_pages_failed)!,
        linesDropped: num(row.page_facts_lines_dropped)!, complete: row.page_facts_complete as boolean }
    : { status, ...(row.page_facts_pages_known != null ? { pagesKnown: num(row.page_facts_pages_known)! } : {}),
        ...(row.page_facts_pages_failed != null ? { pagesFailed: num(row.page_facts_pages_failed)! } : {}),
        ...(row.page_facts_lines_dropped != null ? { linesDropped: num(row.page_facts_lines_dropped)! } : {}),
        ...(typeof row.page_facts_complete === "boolean" ? { complete: row.page_facts_complete } : {}) };
  const record = checkedDopplerOutputs({
    extractor: row.extractor as string,
    servedBy: row.served_by as DopplerServedBy,
    build: { reported: (row.doppler_build as string | null) ?? null, version: (row.doppler_version as string | null) ?? null, commit: (row.doppler_commit as string | null) ?? null },
    markdown: { key: row.markdown_key as string, sha256: row.markdown_sha256 as string, bytes: num(row.markdown_bytes)! },
    pageFacts: pageFacts as DopplerOutputsRecord["pageFacts"],
    layoutFacts: row.layout_facts_key == null ? null : { key: row.layout_facts_key as string, pages: num(row.layout_facts_pages)! },
    engine: { pagesEmitted: num(row.engine_pages_emitted), pagesFailed: num(row.engine_pages_failed), ms: num(row.engine_ms), peakRssKiB: num(row.engine_peak_rss_kib) },
    ocrPages: num(row.ocr_pages)!,
  });
  return {
    ...record, documentId: row.document_id, runId: typeof row.run_id === "string" ? row.run_id : null,
    updatedAt: row.updated_at instanceof Date ? row.updated_at : new Date(String(row.updated_at)),
  };
}

/**
 * Build a record from what extract-markdown holds for the winning Doppler candidate. Doppler's build comes from the
 * provider (validated against DOPPLER_BUILD when accepted) and from the facts run line (kept by the strict reader only as a
 * dotted version and a hex commit); the engine figures from the same run line.
 */
export function dopplerOutputsRecordFrom(args: {
  extractor: string;
  servedBy: DopplerServedBy;
  reportedBuild: string | undefined;
  markdown: { key: string; sha256: string; bytes: number };
  pageFacts: { status: DopplerPageFactsStatus; key?: string; sha256?: string; bytes?: number; facts?: {
    run: { version?: string; commit?: string; totalMs?: number; peakRssKiB?: number; pagesEmitted: number; pagesFailed: number } | null;
    summary: { pagesKnown: number; pagesFailed: number; linesDropped: number; complete: boolean };
  } };
  layoutFacts: { key: string; pages: number } | null;
  ocrPages: number;
}): DopplerOutputsRecord {
  const facts = args.pageFacts.facts;
  const run = facts?.run ?? null;
  const summary = facts?.summary;
  const pageFacts: DopplerOutputsRecord["pageFacts"] = args.pageFacts.status === "stored" && args.pageFacts.key && args.pageFacts.sha256 && summary
    ? { status: "stored", key: args.pageFacts.key, sha256: args.pageFacts.sha256, bytes: args.pageFacts.bytes ?? 0,
        pagesKnown: summary.pagesKnown, pagesFailed: summary.pagesFailed, linesDropped: summary.linesDropped, complete: summary.complete }
    : { status: args.pageFacts.status === "stored" ? "failed" : args.pageFacts.status,
        ...(summary ? { pagesKnown: summary.pagesKnown, pagesFailed: summary.pagesFailed, linesDropped: summary.linesDropped, complete: summary.complete } : {}) };
  return {
    extractor: args.extractor,
    servedBy: args.servedBy,
    build: {
      reported: args.reportedBuild && DOPPLER_BUILD.test(args.reportedBuild) ? args.reportedBuild : null,
      version: run?.version && DOPPLER_VERSION.test(run.version) ? run.version : null,
      commit: run?.commit && DOPPLER_COMMIT.test(run.commit) ? run.commit : null,
    },
    markdown: args.markdown,
    pageFacts,
    layoutFacts: args.layoutFacts,
    engine: {
      pagesEmitted: run ? optCount(run.pagesEmitted) : null, pagesFailed: run ? optCount(run.pagesFailed) : null,
      ms: run ? optCount(run.totalMs, Number.MAX_SAFE_INTEGER) : null, peakRssKiB: run ? optCount(run.peakRssKiB, Number.MAX_SAFE_INTEGER) : null,
    },
    ocrPages: args.ocrPages,
  };
}

/** The build to record on the extraction level when the figure answer named none: the provider's, else Doppler's commit. */
export function dopplerLevelBuild(record: Pick<DopplerOutputsRecord, "build"> | null | undefined): string | null {
  return record?.build.reported ?? record?.build.commit ?? null;
}

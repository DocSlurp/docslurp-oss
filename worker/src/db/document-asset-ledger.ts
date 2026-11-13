/*
 * The document asset ledger (migration 0140): one `document_assets` row per image Doppler reports for a document and one
 * `document_extraction_levels` row per document, written together in one transaction with an explicit organization and
 * project scope. Re-runs and resumes update rows in place; images a new manifest no longer lists are removed.
 *
 * Only validated values reach the database: ledger rows come from the strict manifest schemas
 * (packages/shared/src/doppler-assets.ts) and are checked again here, so a caller cannot write free text, an
 * out-of-vocabulary value, or a storage key outside the document's own folder. A scope that does not match the document
 * (another organization, another project, a document without an organization) writes nothing and throws.
 *
 * Design: docs/extraction/doppler-figures.md ("Asset ledger").
 */
import { rm } from "node:fs/promises";
import path from "node:path";
import type { JSONValue, Sql } from "postgres";
import {
  DOCUMENT_IMAGES_STATUSES, DOPPLER_BUILD, DOPPLER_MANIFEST_V2_LIMITS, DOPPLER_MANIFEST_V3_FILE, DOPPLER_STORE_LAYOUT,
  addDocumentAssetCount, dopplerAssetStorageKey, emptyDocumentAssetCounts, isDocumentAssetRow, dopplerDocumentPrefix,
  parseDopplerFigureId, type DocumentAsset, type DocumentImagesStatus, type DopplerManifestRunFacts,
} from "@docslurp/shared";

import { readLedgerSpill, type DopplerFigureSet } from "../extractors/doppler-figures.js";

/** Who the rows belong to. Every query is filtered by `orgId` (and `projectId`), never by the document id alone. */
export interface DocumentAssetLedgerScope {
  orgId: string;
  projectId: string;
  documentId: string;
  /** The run that wrote them: it must be the document's current run, of the same organization and project. */
  runId: string;
}

export interface DocumentExtractionLevelInput {
  /** The checkpoint that recorded the document's Markdown committed (set by the flush, never by a stage). */
  markdownComplete: boolean;
  imagesStatus: DocumentImagesStatus;
  imagesExitCode: number | null;
  manifestVersion: 1 | 2 | 3 | null;
  dopplerBuild: string | null;
  run: DopplerManifestRunFacts | null;
  /** The stored manifest (`<root>/doppler/<document>/images/manifest.json`) and its SHA-256. */
  manifest: { key: string; sha256: string } | null;
}

export type LedgerAsset = DocumentAsset & { storageKey: string | null };

/**
 * The rows of a write: given in memory (each owned file with its storage key, compared exactly), or the spill file the
 * figure reader wrote (rows in id order; each owned file's key is the one derived from the document's artifact root).
 */
export type LedgerAssets = readonly LedgerAsset[] | { spill: string; rows: number };

export interface DocumentAssetLedgerWrite {
  scope: DocumentAssetLedgerScope;
  level: DocumentExtractionLevelInput;
  assets: LedgerAssets;
  /** A resume's write (`--images-resume`): the host counts it, previous + 1, and refuses one past the cap. */
  resume?: boolean;
}

/** Resumes a document may have before the resume queue leaves it alone (counted by the host, not the manifest). */
export const DOCUMENT_ASSET_RESUME_CAP = 3;

export type DocumentAssetLedgerRule =
  | "invalid-scope" | "invalid-assets" | "invalid-level" | "scope-mismatch" | "key-mismatch" | "stale-write" | "resume-cap" | "write-mismatch";

/** A write refused before anything reached the database, or one the database state refused. Fixed messages. */
export class DocumentAssetLedgerError extends Error {
  constructor(readonly rule: DocumentAssetLedgerRule) {
    super(`Document asset ledger refused: ${rule}`);
    this.name = "DocumentAssetLedgerError";
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DOCUMENT_ID = /^[A-Za-z0-9-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BATCH = 1000;

function assertScope(scope: DocumentAssetLedgerScope): void {
  if (!scope || typeof scope.orgId !== "string" || !ID.test(scope.orgId) || typeof scope.projectId !== "string" || !ID.test(scope.projectId) ||
      typeof scope.documentId !== "string" || !DOCUMENT_ID.test(scope.documentId) || typeof scope.runId !== "string" || !ID.test(scope.runId)) {
    throw new DocumentAssetLedgerError("invalid-scope");
  }
}

/** One row re-validated: the closed vocabulary, the status rules, and a key only where a file is owned. */
function checkedRow(asset: LedgerAsset | DocumentAsset, spilled: boolean): LedgerAsset {
  const { storageKey, ...row } = (asset ?? {}) as LedgerAsset;
  if (!isDocumentAssetRow(row)) throw new DocumentAssetLedgerError("invalid-assets");
  if (spilled) {
    if (storageKey !== undefined) throw new DocumentAssetLedgerError("invalid-assets");
    return { ...row, storageKey: null };
  }
  const owns = row.status === "extracted";
  if (owns !== (storageKey !== null) || (storageKey !== null && (typeof storageKey !== "string" || storageKey.length > 512))) {
    throw new DocumentAssetLedgerError("invalid-assets");
  }
  return { ...row, storageKey };
}

/** id order: page, pictures before figures, index (the order a manifest lists images in). */
function idKey(id: string): [number, number, number] {
  const parsed = parseDopplerFigureId(id)!;
  return [parsed.pageNumber, parsed.vector ? 1 : 0, parsed.index];
}
function idBefore(a: [number, number, number], b: [number, number, number]): boolean {
  return a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
}

/** The rows in id order: a spill as it was written, an in-memory list sorted. Each row is re-validated. */
async function* orderedRows(assets: LedgerAssets): AsyncGenerator<LedgerAsset> {
  if (Array.isArray(assets)) {
    if (assets.length > DOPPLER_MANIFEST_V2_LIMITS.maxEntries) throw new DocumentAssetLedgerError("invalid-assets");
    const rows = (assets as readonly LedgerAsset[]).map((asset) => checkedRow(asset, false));
    rows.sort((a, b) => (idBefore(idKey(a.assetId), idKey(b.assetId)) ? -1 : idBefore(idKey(b.assetId), idKey(a.assetId)) ? 1 : 0));
    yield* rows;
    return;
  }
  const spill = assets as { spill: string; rows: number };
  for await (const row of readLedgerSpill(spill.spill)) yield checkedRow(row, true);
}

function checkedLevel(level: DocumentExtractionLevelInput, resumable: number): void {
  const ok = level && typeof level.markdownComplete === "boolean" && DOCUMENT_IMAGES_STATUSES.includes(level.imagesStatus) &&
    (level.imagesExitCode === null || (Number.isSafeInteger(level.imagesExitCode) && level.imagesExitCode >= 0 && level.imagesExitCode <= 255)) &&
    (level.manifestVersion === null || level.manifestVersion === 1 || level.manifestVersion === 2 || level.manifestVersion === 3) &&
    (level.dopplerBuild === null || (typeof level.dopplerBuild === "string" && DOPPLER_BUILD.test(level.dopplerBuild))) &&
    (level.manifest === null || (typeof level.manifest?.key === "string" && level.manifest.key.length <= 512 &&
      typeof level.manifest.sha256 === "string" && SHA256.test(level.manifest.sha256))) &&
    resumable >= 0;
  const run = level?.run;
  const hex = (v: unknown) => v === null || (typeof v === "string" && SHA256.test(v));
  const int = (v: unknown, min: number, max: number) => v === null || (Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max);
  if (!ok || (run !== null && !(hex(run.sourceSha256) && hex(run.settingsSha256) && int(run.manifestResumes, 0, 1_000_000) &&
      int(run.lastCutPage, 1, 1_000_000_000) && int(run.deadlineMs, 0, 2_000_000_000)))) {
    throw new DocumentAssetLedgerError("invalid-level");
  }
}

/** One writer row as jsonb_to_recordset reads it. */
function assetPayload(asset: LedgerAsset) {
  return {
    asset_id: asset.assetId, page_number: asset.pageNumber, kind: asset.kind, fate: asset.fate, status: asset.status,
    reason: asset.reason, resumable: asset.resumable, source: asset.source, format: asset.format, bytes: asset.bytes,
    sha256: asset.sha256, width: asset.width, height: asset.height, repeat_of: asset.repeatOf, fallback: asset.fallback,
    link_path: asset.linkPath, file_of: asset.fileOf, storage_key: asset.storageKey,
    obj_num: asset.obj?.[0] ?? null, obj_gen: asset.obj?.[1] ?? null, bbox: asset.bbox,
  };
}

/** What a write did, for stage stats and tests: rows changed (unchanged rows are skipped) and removed. */
export interface DocumentAssetLedgerResult { upserted: number; removed: number; resumes: number }

/**
 * Upsert the document's ledger rows and extraction level in one transaction, scoped to the document's organization and
 * project. Validates everything first (a refusal writes nothing). Inside the transaction:
 * - the document must exist with exactly this organization and project (else `scope-mismatch`);
 * - the run must be the document's current run (`documents.run_id`), of the same organization and project, and not
 *   older than the run that wrote the current level (else `stale-write`): a superseded run or one finishing late writes
 *   nothing;
 * - every storage key must be exactly the key derived from the document's artifact root, its id and the image's id and
 *   format, and the manifest key the folder's `images/manifest.json` (else `key-mismatch`);
 * - a resume write is counted by the host (previous + 1) and refused at DOCUMENT_ASSET_RESUME_CAP (`resume-cap`).
 * Rows of images the write does not list are removed, so the table is always the full map of the latest manifest; rows
 * that did not change are not rewritten.
 */
export async function writeDocumentAssetLedger(sql: Sql<Record<string, unknown>>, write: DocumentAssetLedgerWrite): Promise<DocumentAssetLedgerResult> {
  assertScope(write.scope);
  // The level is checked before the transaction; its counts against the rows once they have streamed through.
  checkedLevel(write.level, write.level.imagesStatus === "resumable" ? 1 : 0);
  const { orgId, projectId, documentId, runId } = write.scope;

  return await sql.begin(async (tx) => {
    // Serialize writers of one document (a re-run racing a resume), then check the scope against the document itself.
    await tx`select pg_advisory_xact_lock(hashtext(${`document-assets:${documentId}`}))`;
    const [document] = await tx<{ user_id: string; run_id: string | null }[]>`
      select user_id, run_id from documents where id = ${documentId} and org_id = ${orgId} and project_id = ${projectId} for key share`;
    if (!document) throw new DocumentAssetLedgerError("scope-mismatch");
    const [run] = await tx<{ storage_prefix: string | null }[]>`
      select storage_prefix from project_runs where id = ${runId} and org_id = ${orgId} and project_id = ${projectId}`;
    if (!run) throw new DocumentAssetLedgerError("scope-mismatch");
    if (document.run_id !== runId) throw new DocumentAssetLedgerError("stale-write");
    const [previous] = await tx<{ resumes: number; newer: boolean }[]>`
      select l.resumes,
        -- Compared in the database (a timestamp round trip through JavaScript loses microseconds).
        coalesce(l.run_id <> ${runId} and r.created_at > (select created_at from project_runs where id = ${runId}), false) as newer
      from document_extraction_levels l left join project_runs r on r.id = l.run_id
      where l.document_id = ${documentId} and l.org_id = ${orgId} and l.project_id = ${projectId}`;
    if (previous?.newer) throw new DocumentAssetLedgerError("stale-write");

    // Exact keys: the document's artifact root (documentArtifactRoot: the run's own prefix, else <user>/<run>).
    const root = run.storage_prefix ?? `${document.user_id}/${runId}`;
    let prefix: string;
    try {
      prefix = dopplerDocumentPrefix(root, documentId);
    } catch {
      throw new DocumentAssetLedgerError("key-mismatch");
    }
    const manifestKeys = [DOPPLER_STORE_LAYOUT.manifest, DOPPLER_MANIFEST_V3_FILE].map((name) => `${prefix}${DOPPLER_STORE_LAYOUT.imagesFolder}${name}`);
    if (write.level.manifest && !manifestKeys.includes(write.level.manifest.key)) throw new DocumentAssetLedgerError("key-mismatch");
    const priorResumes = previous?.resumes ?? 0;
    if (write.resume && priorResumes >= DOCUMENT_ASSET_RESUME_CAP) throw new DocumentAssetLedgerError("resume-cap");
    const resumes = write.resume ? priorResumes + 1 : 0;

    // Defense in depth behind the composite foreign key: no row of this document may carry another scope.
    const [foreign] = await tx<{ n: number }[]>`
      select count(*)::int as n from document_assets where document_id = ${documentId} and (org_id <> ${orgId} or project_id <> ${projectId})`;
    if ((foreign?.n ?? 0) > 0) throw new DocumentAssetLedgerError("write-mismatch");

    // Rows stream in id order (so page order): upserted in batches; each finished page range is pruned of the rows the
    // write no longer lists, by an anti-join on that range's ids. Held at once: one batch and the ids of open pages.
    const counts = emptyDocumentAssetCounts();
    let upserted = 0;
    let removed = 0;
    let batch: LedgerAsset[] = [];
    let keepIds: string[] = [];
    let pruneFrom = 1;
    let pruneTo = 0;
    let currentPage = 0;
    let last: [number, number, number] | null = null;
    const upsert = async () => {
      if (batch.length === 0) return;
      const payload = batch.map(assetPayload);
      batch = [];
      const written = await tx`
        insert into document_assets (document_id, org_id, project_id, run_id, asset_id, page_number, kind, fate, status, reason,
          resumable, source, format, bytes, sha256, width, height, repeat_of, fallback, link_path, file_of, storage_key, obj_num,
          obj_gen, bbox)
        select ${documentId}, ${orgId}, ${projectId}, ${runId}, r.asset_id, r.page_number, r.kind, r.fate, r.status, r.reason,
          r.resumable, r.source, r.format, r.bytes, r.sha256, r.width, r.height, r.repeat_of, r.fallback, r.link_path, r.file_of,
          r.storage_key, r.obj_num, r.obj_gen, r.bbox
        from jsonb_to_recordset(${tx.json(payload as unknown as JSONValue)}::jsonb) as r(
          asset_id text, page_number integer, kind text, fate text, status text, reason text, resumable boolean, source text,
          format text, bytes integer, sha256 text, width integer, height integer, repeat_of text, fallback text, link_path text,
          file_of text, storage_key text, obj_num integer, obj_gen integer, bbox double precision[])
        on conflict (document_id, asset_id) do update
        set run_id = excluded.run_id, page_number = excluded.page_number, kind = excluded.kind, fate = excluded.fate,
            status = excluded.status, reason = excluded.reason, resumable = excluded.resumable, source = excluded.source,
            format = excluded.format, bytes = excluded.bytes, sha256 = excluded.sha256, width = excluded.width,
            height = excluded.height, repeat_of = excluded.repeat_of, fallback = excluded.fallback, link_path = excluded.link_path,
            file_of = excluded.file_of, storage_key = excluded.storage_key, obj_num = excluded.obj_num, obj_gen = excluded.obj_gen,
            bbox = excluded.bbox, updated_at = now()
        where document_assets.org_id = excluded.org_id and document_assets.project_id = excluded.project_id
          and (document_assets.run_id, document_assets.page_number, document_assets.kind, document_assets.fate, document_assets.status,
            document_assets.reason, document_assets.resumable, document_assets.source, document_assets.format, document_assets.bytes,
            document_assets.sha256, document_assets.width, document_assets.height, document_assets.repeat_of, document_assets.fallback,
            document_assets.link_path, document_assets.file_of, document_assets.storage_key, document_assets.obj_num,
            document_assets.obj_gen, document_assets.bbox)
          is distinct from (excluded.run_id, excluded.page_number, excluded.kind, excluded.fate, excluded.status, excluded.reason,
            excluded.resumable, excluded.source, excluded.format, excluded.bytes, excluded.sha256, excluded.width, excluded.height,
            excluded.repeat_of, excluded.fallback, excluded.link_path, excluded.file_of, excluded.storage_key, excluded.obj_num,
            excluded.obj_gen, excluded.bbox)
        returning 1`;
      upserted += written.length;
    };
    // Rows of pages pruneFrom..pruneTo (null: to the end) that the write does not list. An anti-join, never `<> ALL`.
    const prune = async (to: number | null) => {
      if (to !== null && to < pruneFrom) return;
      const gone = await tx`
        delete from document_assets a
        where a.org_id = ${orgId} and a.project_id = ${projectId} and a.document_id = ${documentId}
          and a.page_number >= ${pruneFrom} ${to === null ? tx`` : tx`and a.page_number <= ${to}`}
          and not exists (select 1 from unnest(${tx.array(keepIds)}::text[]) as keep(id) where keep.id = a.asset_id)
        returning 1`;
      removed += gone.length;
      keepIds = [];
      if (to !== null) pruneFrom = to + 1;
    };
    let pageIds: string[] = [];
    for await (const asset of orderedRows(write.assets)) {
      const key = idKey(asset.assetId);
      // Strictly in id order: a repeated id or a reordered spill is refused (and needs no set of every id).
      if (last && !idBefore(last, key)) throw new DocumentAssetLedgerError("invalid-assets");
      last = key;
      if (counts.total >= DOPPLER_MANIFEST_V2_LIMITS.maxEntries) throw new DocumentAssetLedgerError("invalid-assets");
      let storageKey: string;
      try {
        storageKey = asset.status === "extracted" ? dopplerAssetStorageKey(root, documentId, asset.assetId, asset.format!) : "";
      } catch {
        throw new DocumentAssetLedgerError("invalid-assets");
      }
      if (asset.status === "extracted") {
        if (asset.storageKey !== null && asset.storageKey !== storageKey) throw new DocumentAssetLedgerError("key-mismatch");
        asset.storageKey = storageKey;
      }
      if (asset.pageNumber !== currentPage) {
        // The page before is complete: its ids join the prune set, and pages up to this one's are done.
        keepIds.push(...pageIds);
        pageIds = [];
        pruneTo = asset.pageNumber - 1;
        currentPage = asset.pageNumber;
      }
      pageIds.push(asset.assetId);
      addDocumentAssetCount(counts, asset);
      batch.push(asset);
      if (batch.length >= BATCH) {
        await upsert();
        await prune(pruneTo);
      }
    }
    await upsert();
    keepIds.push(...pageIds);
    await prune(null);

    if ((write.level.imagesStatus === "resumable") !== (counts.resumable > 0)) throw new DocumentAssetLedgerError("invalid-level");
    const level = write.level;
    const facts = level.run;
    const leveled = await tx`
      insert into document_extraction_levels (document_id, org_id, project_id, run_id, markdown_complete, images_status,
        images_exit_code, manifest_version, doppler_build, manifest_key, manifest_sha256, source_sha256, settings_sha256, resumes,
        last_cut_page, deadline_ms, assets_total, assets_extracted, assets_not_extracted, assets_unlinked, assets_resumable,
        source_copy, source_decode, source_render, asset_bytes)
      values (${documentId}, ${orgId}, ${projectId}, ${runId}, ${level.markdownComplete}, ${level.imagesStatus},
        ${level.imagesExitCode}, ${level.manifestVersion}, ${level.dopplerBuild}, ${level.manifest?.key ?? null},
        ${level.manifest?.sha256 ?? null}, ${facts?.sourceSha256 ?? null}, ${facts?.settingsSha256 ?? null}, ${resumes},
        ${facts?.lastCutPage ?? null}, ${facts?.deadlineMs ?? null}, ${counts.total}, ${counts.extracted}, ${counts.notExtracted},
        ${counts.unlinked}, ${counts.resumable}, ${counts.sourceCopy}, ${counts.sourceDecode}, ${counts.sourceRender}, ${counts.bytes})
      on conflict (document_id) do update
      set run_id = excluded.run_id, markdown_complete = excluded.markdown_complete, images_status = excluded.images_status,
          images_exit_code = excluded.images_exit_code, manifest_version = excluded.manifest_version,
          doppler_build = excluded.doppler_build, manifest_key = excluded.manifest_key, manifest_sha256 = excluded.manifest_sha256,
          source_sha256 = excluded.source_sha256, settings_sha256 = excluded.settings_sha256, resumes = excluded.resumes,
          last_cut_page = excluded.last_cut_page, deadline_ms = excluded.deadline_ms, assets_total = excluded.assets_total,
          assets_extracted = excluded.assets_extracted, assets_not_extracted = excluded.assets_not_extracted,
          assets_unlinked = excluded.assets_unlinked, assets_resumable = excluded.assets_resumable,
          source_copy = excluded.source_copy, source_decode = excluded.source_decode, source_render = excluded.source_render,
          asset_bytes = excluded.asset_bytes, updated_at = now()
      where document_extraction_levels.org_id = excluded.org_id and document_extraction_levels.project_id = excluded.project_id
      returning 1`;
    if (leveled.length !== 1) throw new DocumentAssetLedgerError("write-mismatch");
    return { upserted, removed, resumes };
  });
}

// ---- Building a write from the figure step ----

export interface FigureStepOutcome {
  /** extracted (exit 0), partial (exit 5 with a kept folder), failed (no folder to trust, or it was refused). */
  status: "extracted" | "partial" | "failed";
  exitCode?: number;
  build?: string;
}

/** The images status a read folder means: complete, resumable (a resume would retry some) or partial. */
export function imagesStatusOf(set: Pick<DopplerFigureSet, "complete" | "ledger">): DocumentImagesStatus {
  if (set.complete) return "complete";
  return set.ledger.counts.resumable > 0 ? "resumable" : "partial";
}

/** A ledger write waiting for the stage checkpoint (WorkflowState.pendingAssetLedger); the flush adds scope and markdownComplete. */
export interface PendingAssetLedgerWrite {
  level: Omit<DocumentExtractionLevelInput, "markdownComplete">;
  assets: LedgerAssets;
  resume?: boolean;
}

/** The ledger write for a stored figure set: every image, streamed back from the reader's spill. */
export function ledgerWriteForStoredFigures(args: {
  set: Pick<DopplerFigureSet, "version" | "complete" | "ledger" | "run">;
  /** The stored manifest's key and SHA-256. */
  storedManifest: { key: string; sha256: string };
  outcome: FigureStepOutcome;
}): PendingAssetLedgerWrite {
  return {
    level: {
      imagesStatus: imagesStatusOf(args.set), imagesExitCode: args.outcome.exitCode ?? null, manifestVersion: args.set.version,
      dopplerBuild: args.outcome.build ?? null, run: args.set.run, manifest: args.storedManifest,
    },
    assets: { spill: args.set.ledger.spill, rows: args.set.ledger.rows },
  };
}

/** Remove a pending write's spill (written, dropped or replaced). */
export async function disposePendingAssetLedger(write: PendingAssetLedgerWrite | undefined): Promise<void> {
  if (write && !Array.isArray(write.assets)) {
    await rm(path.dirname((write.assets as { spill: string }).spill), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** The ledger write for a figure step that stored nothing: no asset rows (older ones go), images failed. */
export function ledgerWriteForFailedFigures(args: { outcome: Omit<FigureStepOutcome, "status"> }): PendingAssetLedgerWrite {
  return {
    level: {
      imagesStatus: "failed", imagesExitCode: args.outcome.exitCode ?? null, manifestVersion: null, dopplerBuild: args.outcome.build ?? null,
      run: null, manifest: null,
    },
    assets: [],
  };
}

/**
 * The level for committed Markdown whose figure step did not run: `disabled` (figures off for the run) or `none` (another
 * extractor won, the document is not a PDF, or no VM). No assets: older rows (and a stale resumable state) go.
 */
export function ledgerWriteForNoFigures(status: "none" | "disabled"): PendingAssetLedgerWrite {
  return { level: { imagesStatus: status, imagesExitCode: null, manifestVersion: null, dopplerBuild: null, run: null, manifest: null }, assets: [] };
}

// ---- Reading: the resume queue ----

export interface ResumableDocument {
  documentId: string;
  projectId: string;
  runId: string | null;
  sourceSha256: string | null;
  settingsSha256: string | null;
  /** The stored manifest's SHA-256: what downloadDopplerImagesDir checks before it rebuilds the DIR. */
  manifestSha256: string | null;
  resumes: number;
  assetsResumable: number;
  lastCutPage: number | null;
  updatedAt: string;
}

/**
 * Documents of one organization (optionally one project) whose images a Doppler resume would retry, oldest first, with a
 * keyset cursor. Only live documents (not superseded, archived or purged), with a stored manifest, and below the host's
 * resume cap (a manifest that never finishes is dropped after DOCUMENT_ASSET_RESUME_CAP resumes, whatever it reports).
 * For a later resume worker; nothing here resumes anything.
 */
export async function listResumableDocuments(
  sql: Sql<Record<string, unknown>>,
  args: { orgId: string; projectId?: string; limit?: number; after?: { updatedAt: string; documentId: string } },
): Promise<ResumableDocument[]> {
  if (typeof args.orgId !== "string" || !ID.test(args.orgId) || (args.projectId !== undefined && (typeof args.projectId !== "string" || !ID.test(args.projectId)))) {
    throw new DocumentAssetLedgerError("invalid-scope");
  }
  const limit = Math.min(Math.max(Math.floor(args.limit ?? 100) || 100, 1), 1000);
  const rows = await sql<Array<{
    document_id: string; project_id: string; run_id: string | null; source_sha256: string | null; settings_sha256: string | null;
    manifest_sha256: string | null; resumes: number; assets_resumable: number; last_cut_page: number | null; updated_at: string;
  }>>`
    select l.document_id, l.project_id, l.run_id, l.source_sha256, l.settings_sha256, l.manifest_sha256, l.resumes, l.assets_resumable,
      l.last_cut_page, to_char(l.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
    from document_extraction_levels l
    join documents d on d.id = l.document_id and d.org_id = l.org_id and d.project_id = l.project_id
    where l.org_id = ${args.orgId} and l.images_status = 'resumable' and l.resumes < ${DOCUMENT_ASSET_RESUME_CAP}
      and l.manifest_key is not null
      ${args.projectId === undefined ? sql`` : sql`and l.project_id = ${args.projectId}`}
      ${args.after ? sql`and (l.updated_at, l.document_id) > (${args.after.updatedAt}::timestamptz, ${args.after.documentId})` : sql``}
      and d.superseded_at is null and d.archived_at is null and d.purged_at is null
    order by l.updated_at, l.document_id
    limit ${limit}`;
  return rows.map((row) => ({
    documentId: row.document_id, projectId: row.project_id, runId: row.run_id, sourceSha256: row.source_sha256,
    settingsSha256: row.settings_sha256, manifestSha256: row.manifest_sha256, resumes: row.resumes, assetsResumable: row.assets_resumable,
    lastCutPage: row.last_cut_page, updatedAt: row.updated_at,
  }));
}

// ---- The stage's call: buffered until the checkpoint commits ----

/** What happened to a document's ledger write, for logs and stats (fixed values, no error text). */
export type LedgerRecordStatus = "written" | "unsupported" | "no-scope" | "refused" | "stale-write" | "failed";

/** The part of WorkflowState the ledger buffer needs. */
export interface AssetLedgerState {
  run: { id: string; orgId: string | null; projectId?: string | null };
  pendingAssetLedger: Map<string, PendingAssetLedgerWrite>;
  artifactLedger: { readDocument(documentId: string, name: string): string | undefined };
}

/**
 * Queue the document's ledger write for the stage checkpoint: the store writes it only after the checkpoint that records
 * the document's Markdown and figure slots commits (Store.flushAssetLedger), never before. A later write for the same
 * document in the same checkpoint replaces an earlier one.
 */
export function queueAssetLedger(state: Pick<AssetLedgerState, "pendingAssetLedger">, documentId: string, write: PendingAssetLedgerWrite): "queued" {
  const replaced = state.pendingAssetLedger.get(documentId);
  if (replaced && replaced !== write) void disposePendingAssetLedger(replaced);
  state.pendingAssetLedger.set(documentId, write);
  return "queued";
}

/**
 * Write every queued ledger entry of the state, after its checkpoint committed. Never fails the run: a run without an
 * organization or project (nothing is written: there is no scope), a refused or stale write and a database error are
 * each logged with a fixed reason. `markdownComplete` is whether the committed checkpoint holds the document's Markdown.
 */
export async function flushAssetLedger(
  state: AssetLedgerState,
  write: (write: DocumentAssetLedgerWrite) => Promise<unknown>,
): Promise<Map<string, LedgerRecordStatus>> {
  const outcomes = new Map<string, LedgerRecordStatus>();
  const pending = [...state.pendingAssetLedger.entries()];
  state.pendingAssetLedger.clear();
  for (const [documentId, entry] of pending) {
    try {
      outcomes.set(documentId, await flushOne(state, documentId, entry, write));
    } finally {
      await disposePendingAssetLedger(entry);
    }
  }
  return outcomes;
}

async function flushOne(
  state: AssetLedgerState, documentId: string, entry: PendingAssetLedgerWrite, write: (write: DocumentAssetLedgerWrite) => Promise<unknown>,
): Promise<LedgerRecordStatus> {
  if (!state.run.orgId || !state.run.projectId) {
    console.warn(`[asset-ledger] document=${documentId} status=no-scope (run without organization or project; nothing written)`);
    return "no-scope";
  }
  try {
    await write({
      scope: { orgId: state.run.orgId, projectId: state.run.projectId, documentId, runId: state.run.id },
      level: { ...entry.level, markdownComplete: !!state.artifactLedger.readDocument(documentId, "markdown") },
      assets: entry.assets,
      ...(entry.resume ? { resume: true } : {}),
    });
    return "written";
  } catch (error) {
    if (error instanceof DocumentAssetLedgerError) {
      const status = error.rule === "stale-write" ? "stale-write" : "refused";
      console.warn(`[asset-ledger] document=${documentId} status=${status} rule=${error.rule}`);
      return status;
    }
    const code = (error as { code?: unknown } | null)?.code;
    console.warn(`[asset-ledger] document=${documentId} status=failed error=${error instanceof Error ? error.name : typeof error}${typeof code === "string" ? ` code=${code}` : ""}`);
    return "failed";
  }
}

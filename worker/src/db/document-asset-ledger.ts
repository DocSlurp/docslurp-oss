/*
 * The document asset ledger (migration 0141): one `document_assets` row per image Doppler reports for a document and one
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
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import type { JSONValue, Sql } from "postgres";
import {
  DOCUMENT_IMAGES_STATUSES, DOPPLER_BUILD, DOPPLER_MANIFEST_V2_LIMITS, DOPPLER_MANIFEST_V3_FILE, DOPPLER_STORE_LAYOUT,
  DOPPLER_FIGURE_MAX_GAPS, checkedDopplerFigureGaps, dopplerAssetStorageKey, dopplerRangeManifestKey, isDocumentAssetRow,
  dopplerDocumentPrefix, parseDopplerFigureId, type DocumentAsset, type DocumentImagesStatus, type DopplerFigureGap,
  type DopplerFigureRange, type DopplerManifestRunFacts,
} from "@docslurp/shared";

import { readLedgerSpill, type DopplerFigureLedgerHooks, type DopplerFigureSet } from "../extractors/doppler-figures.js";

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
  /** The stored canonical manifest (`<root>/doppler/<document>/images/manifest.jsonl`) and its SHA-256. */
  manifest: { key: string; sha256: string } | null;
  /** Bytes of the stored canonical manifest and index.json (counted in asset_bytes, billed as storage). */
  manifestBytes?: number;
  indexBytes?: number;
  /** Page ranges a shard returned nothing for (resumable like a resumable image); at most 128. */
  gaps?: readonly DopplerFigureGap[];
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
  /**
   * A resume's write (`--images-resume`): the host counts it, previous + 1, and refuses one past the cap. It must name
   * the figures generation it claimed (`generation`): a fresh pass that landed since makes it `stale-generation`. It only
   * adds: images a resume may retry (resumable, or pending from a crashed upload) and images the ledger never had gain
   * their result; an extracted image keeps its file (another file for it is `resume-rewrite`) and nothing is pruned.
   */
  resume?: boolean;
  generation?: number;
  /**
   * The level only (writeFigureLevel): `markdown_complete`, and the status when no delivery recorded anything. Never
   * touches or deletes a row: the failure and no-figure writes and the checkpoint after per-range deliveries.
   */
  levelOnly?: boolean;
}

/** Resumes a document may have before the resume queue leaves it alone (counted by the host, not the manifest). */
export const DOCUMENT_ASSET_RESUME_CAP = 3;

export type DocumentAssetLedgerRule =
  | "invalid-scope" | "invalid-assets" | "invalid-level" | "scope-mismatch" | "key-mismatch" | "stale-write" | "resume-cap" | "write-mismatch"
  | "stale-generation" | "resume-rewrite" | "resume-mismatch" | "invalid-gaps";

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
    storage_state: asset.status === "extracted" ? "stored" : "none",
  };
}

/** What a write did, for stage stats and tests: rows changed (unchanged rows are skipped) and removed. */
export interface DocumentAssetLedgerResult { upserted: number; removed: number; resumes: number; generation: number }

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
  if (write.levelOnly) {
    await writeFigureLevel(sql, {
      scope: write.scope, markdownComplete: write.level.markdownComplete,
      imagesStatus: write.level.imagesStatus === "resumable" ? "partial" : write.level.imagesStatus,
      exitCode: write.level.imagesExitCode, build: write.level.dopplerBuild,
      ...(write.level.indexBytes !== undefined ? { indexBytes: write.level.indexBytes } : {}),
    });
    return { upserted: 0, removed: 0, resumes: 0, generation: 0 };
  }
  // The level is checked before the transaction; its counts against the rows once they have streamed through.
  checkedLevel(write.level, write.level.imagesStatus === "resumable" ? 1 : 0);
  const resume = write.resume === true;
  if (resume && !(Number.isSafeInteger(write.generation) && write.generation! >= 1)) throw new DocumentAssetLedgerError("stale-generation");
  const { orgId, projectId, documentId, runId } = write.scope;

  return await sql.begin(async (tx) => {
    const checked = await lockAndCheck(tx, write.scope);
    const { root, previous } = checked;
    const gaps = checkedDopplerFigureGaps(write.level.gaps ?? [], checked.pageCount);
    if (!gaps) throw new DocumentAssetLedgerError("invalid-gaps");
    let prefix: string;
    try {
      prefix = dopplerDocumentPrefix(root, documentId);
    } catch {
      throw new DocumentAssetLedgerError("key-mismatch");
    }
    const manifestKeys = [DOPPLER_STORE_LAYOUT.manifest, DOPPLER_MANIFEST_V3_FILE].map((name) => `${prefix}${DOPPLER_STORE_LAYOUT.imagesFolder}${name}`);
    if (write.level.manifest && !manifestKeys.includes(write.level.manifest.key) &&
        !(write.level.manifest.key.startsWith(`${prefix}${DOPPLER_STORE_LAYOUT.imagesFolder}manifests/`) &&
          /\/manifests\/[1-9][0-9]{0,8}-[1-9][0-9]{0,8}\.[0-9a-f]{16}\.jsonl?$/.test(write.level.manifest.key))) {
      throw new DocumentAssetLedgerError("key-mismatch");
    }
    const priorResumes = previous?.resumes ?? 0;
    if (resume) {
      // A resume continues exactly the generation it claimed, of the same PDF and settings: never a new version.
      if (!previous || Number(previous.figures_generation) !== write.generation) throw new DocumentAssetLedgerError("stale-generation");
      if (priorResumes >= DOCUMENT_ASSET_RESUME_CAP) throw new DocumentAssetLedgerError("resume-cap");
      const facts = write.level.run;
      if (!facts || facts.sourceSha256 !== previous.source_sha256 || facts.settingsSha256 !== previous.settings_sha256) {
        throw new DocumentAssetLedgerError("resume-mismatch");
      }
    }
    const resumes = resume ? priorResumes + 1 : 0;
    // Every fresh pass starts a new generation; a resume keeps the one it claimed.
    const generation = resume ? write.generation! : Number(previous?.figures_generation ?? 0) + 1;

    // Defense in depth behind the composite foreign key: no row of this document may carry another scope.
    const [foreign] = await tx<{ n: number }[]>`
      select count(*)::int as n from document_assets where document_id = ${documentId} and (org_id <> ${orgId} or project_id <> ${projectId})`;
    if ((foreign?.n ?? 0) > 0) throw new DocumentAssetLedgerError("write-mismatch");

    // Rows stream in id order (so page order): upserted in batches; on a fresh pass each finished page range is pruned of
    // the rows the write no longer lists, by an anti-join on that range's ids. A resume never prunes. Held at once: one
    // batch and the ids of open pages.
    let upserted = 0;
    let removed = 0;
    let batch: LedgerAsset[] = [];
    let keepIds: string[] = [];
    let pruneFrom = 1;
    let pruneTo = 0;
    let currentPage = 0;
    let rows = 0;
    let last: [number, number, number] | null = null;
    const upsert = async () => {
      if (batch.length === 0) return;
      let rowsToWrite = batch;
      batch = [];
      if (resume) rowsToWrite = await resumeRows(tx, write.scope, rowsToWrite);
      if (rowsToWrite.length === 0) return;
      const payload = rowsToWrite.map(assetPayload);
      const written = await tx`
        insert into document_assets (document_id, org_id, project_id, run_id, asset_id, page_number, kind, fate, status, reason,
          resumable, source, format, bytes, sha256, width, height, repeat_of, fallback, link_path, file_of, storage_key, obj_num,
          obj_gen, bbox, storage_state)
        select ${documentId}, ${orgId}, ${projectId}, ${runId}, r.asset_id, r.page_number, r.kind, r.fate, r.status, r.reason,
          r.resumable, r.source, r.format, r.bytes, r.sha256, r.width, r.height, r.repeat_of, r.fallback, r.link_path, r.file_of,
          r.storage_key, r.obj_num, r.obj_gen, r.bbox, r.storage_state
        from jsonb_to_recordset(${tx.json(payload as unknown as JSONValue)}::jsonb) as r(
          asset_id text, page_number integer, kind text, fate text, status text, reason text, resumable boolean, source text,
          format text, bytes integer, sha256 text, width integer, height integer, repeat_of text, fallback text, link_path text,
          file_of text, storage_key text, obj_num integer, obj_gen integer, bbox double precision[], storage_state text)
        on conflict (document_id, asset_id) do update
        set run_id = excluded.run_id, page_number = excluded.page_number, kind = excluded.kind, fate = excluded.fate,
            status = excluded.status, reason = excluded.reason, resumable = excluded.resumable, source = excluded.source,
            format = excluded.format, bytes = excluded.bytes, sha256 = excluded.sha256, width = excluded.width,
            height = excluded.height, repeat_of = excluded.repeat_of, fallback = excluded.fallback, link_path = excluded.link_path,
            file_of = excluded.file_of, storage_key = excluded.storage_key, obj_num = excluded.obj_num, obj_gen = excluded.obj_gen,
            bbox = excluded.bbox, storage_state = excluded.storage_state, updated_at = now()
        where document_assets.org_id = excluded.org_id and document_assets.project_id = excluded.project_id
          and (document_assets.run_id, document_assets.page_number, document_assets.kind, document_assets.fate, document_assets.status,
            document_assets.reason, document_assets.resumable, document_assets.source, document_assets.format, document_assets.bytes,
            document_assets.sha256, document_assets.width, document_assets.height, document_assets.repeat_of, document_assets.fallback,
            document_assets.link_path, document_assets.file_of, document_assets.storage_key, document_assets.obj_num,
            document_assets.obj_gen, document_assets.bbox, document_assets.storage_state)
          is distinct from (excluded.run_id, excluded.page_number, excluded.kind, excluded.fate, excluded.status, excluded.reason,
            excluded.resumable, excluded.source, excluded.format, excluded.bytes, excluded.sha256, excluded.width, excluded.height,
            excluded.repeat_of, excluded.fallback, excluded.link_path, excluded.file_of, excluded.storage_key, excluded.obj_num,
            excluded.obj_gen, excluded.bbox, excluded.storage_state)
        returning 1`;
      upserted += written.length;
    };
    // Rows of pages pruneFrom..pruneTo (null: to the end) that the write does not list. An anti-join, never `<> ALL`.
    const prune = async (to: number | null) => {
      if (resume) { keepIds = []; return; }
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
      if (rows >= DOPPLER_MANIFEST_V2_LIMITS.maxEntries) throw new DocumentAssetLedgerError("invalid-assets");
      rows += 1;
      if (asset.status === "extracted") {
        let storageKey: string;
        try {
          storageKey = dopplerAssetStorageKey(root, documentId, asset.assetId, asset.format!, asset.sha256!);
        } catch {
          throw new DocumentAssetLedgerError("invalid-assets");
        }
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
      batch.push(asset);
      if (batch.length >= BATCH) {
        await upsert();
        await prune(pruneTo);
      }
    }
    await upsert();
    keepIds.push(...pageIds);
    await prune(null);

    // Counts and bytes are derived from the committed rows, never from the write (a resume keeps rows it does not list).
    const counts = await rowCounts(tx, write.scope);
    const resumable = counts.resumable > 0 || gaps.length > 0;
    let imagesStatus = write.level.imagesStatus;
    if (resume) {
      imagesStatus = resumable ? "resumable" : imagesStatus === "resumable" ? "partial" : imagesStatus;
    } else if ((imagesStatus === "resumable") !== resumable) {
      throw new DocumentAssetLedgerError("invalid-level");
    }
    const level = write.level;
    const facts = level.run;
    const indexBytes = byteCount(level.indexBytes);
    const manifestBytes = byteCount(level.manifestBytes);
    const leveled = await tx`
      insert into document_extraction_levels (document_id, org_id, project_id, run_id, markdown_complete, images_status,
        images_exit_code, manifest_version, doppler_build, manifest_key, manifest_sha256, source_sha256, settings_sha256, resumes,
        last_cut_page, deadline_ms, assets_total, assets_extracted, assets_not_extracted, assets_unlinked, assets_resumable,
        source_copy, source_decode, source_render, asset_bytes, figures_generation, gaps, index_bytes, manifest_bytes)
      values (${documentId}, ${orgId}, ${projectId}, ${runId}, ${level.markdownComplete}, ${imagesStatus},
        ${level.imagesExitCode}, ${level.manifestVersion}, ${level.dopplerBuild}, ${level.manifest?.key ?? null},
        ${level.manifest?.sha256 ?? null}, ${facts?.sourceSha256 ?? null}, ${facts?.settingsSha256 ?? null}, ${resumes},
        ${facts?.lastCutPage ?? null}, ${facts?.deadlineMs ?? null}, ${counts.total}, ${counts.extracted}, ${counts.notExtracted},
        ${counts.unlinked}, ${counts.resumable}, ${counts.sourceCopy}, ${counts.sourceDecode}, ${counts.sourceRender},
        ${counts.storedBytes + indexBytes + manifestBytes}, ${generation}, ${tx.json(gaps as unknown as JSONValue)}, ${indexBytes},
        ${manifestBytes})
      on conflict (document_id) do update
      set run_id = excluded.run_id, markdown_complete = excluded.markdown_complete, images_status = excluded.images_status,
          images_exit_code = excluded.images_exit_code, manifest_version = excluded.manifest_version,
          doppler_build = excluded.doppler_build, manifest_key = excluded.manifest_key, manifest_sha256 = excluded.manifest_sha256,
          source_sha256 = excluded.source_sha256, settings_sha256 = excluded.settings_sha256, resumes = excluded.resumes,
          last_cut_page = excluded.last_cut_page, deadline_ms = excluded.deadline_ms, assets_total = excluded.assets_total,
          assets_extracted = excluded.assets_extracted, assets_not_extracted = excluded.assets_not_extracted,
          assets_unlinked = excluded.assets_unlinked, assets_resumable = excluded.assets_resumable,
          source_copy = excluded.source_copy, source_decode = excluded.source_decode, source_render = excluded.source_render,
          asset_bytes = excluded.asset_bytes, figures_generation = excluded.figures_generation, gaps = excluded.gaps,
          index_bytes = excluded.index_bytes, manifest_bytes = excluded.manifest_bytes, updated_at = now()
      where document_extraction_levels.org_id = excluded.org_id and document_extraction_levels.project_id = excluded.project_id
        ${resume ? tx`and document_extraction_levels.figures_generation = ${generation}` : tx``}
      returning 1`;
    if (leveled.length !== 1) throw new DocumentAssetLedgerError(resume ? "stale-generation" : "write-mismatch");
    return { upserted, removed, resumes, generation };
  });
}

function byteCount(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || value < 0) throw new DocumentAssetLedgerError("invalid-level");
  return value;
}

type Tx = import("postgres").TransactionSql<Record<string, unknown>>;

interface LevelRow {
  resumes: number; newer: boolean; figures_generation: string | number; source_sha256: string | null; settings_sha256: string | null;
}

/**
 * Inside a transaction: serialize writers of one document (a re-run racing a resume), then check the scope against the
 * document itself (else `scope-mismatch`) and the run against the document's current run, not older than the run that
 * wrote the level (else `stale-write`). Returns the document's artifact root, page count and current level.
 */
async function lockAndCheck(tx: Tx, scope: DocumentAssetLedgerScope): Promise<{ root: string; pageCount: number; previous: LevelRow | undefined }> {
  const { orgId, projectId, documentId, runId } = scope;
  await tx`select pg_advisory_xact_lock(hashtext(${`document-assets:${documentId}`}))`;
  const [document] = await tx<{ user_id: string; run_id: string | null; page_count: number | null }[]>`
    select user_id, run_id, page_count from documents where id = ${documentId} and org_id = ${orgId} and project_id = ${projectId} for key share`;
  if (!document) throw new DocumentAssetLedgerError("scope-mismatch");
  const [run] = await tx<{ storage_prefix: string | null }[]>`
    select storage_prefix from project_runs where id = ${runId} and org_id = ${orgId} and project_id = ${projectId}`;
  if (!run) throw new DocumentAssetLedgerError("scope-mismatch");
  if (document.run_id !== runId) throw new DocumentAssetLedgerError("stale-write");
  const [previous] = await tx<LevelRow[]>`
    select l.resumes, l.figures_generation, l.source_sha256, l.settings_sha256,
      -- Compared in the database (a timestamp round trip through JavaScript loses microseconds).
      coalesce(l.run_id <> ${runId} and r.created_at > (select created_at from project_runs where id = ${runId}), false) as newer
    from document_extraction_levels l left join project_runs r on r.id = l.run_id
    where l.document_id = ${documentId} and l.org_id = ${orgId} and l.project_id = ${projectId}`;
  if (previous?.newer) throw new DocumentAssetLedgerError("stale-write");
  // Exact keys: the document's artifact root (documentArtifactRoot: the run's own prefix, else <user>/<run>).
  return { root: run.storage_prefix ?? `${document.user_id}/${runId}`, pageCount: Math.max(1, Number(document.page_count ?? 1)), previous };
}

/**
 * A resume's batch: the rows it may write. Images a resume may retry (resumable, or pending from a crashed upload) and
 * images the ledger never had are written; every other image must come back exactly as it is (an extracted image with the
 * same file, any other with the same status and reason) and is left alone; anything else is `resume-rewrite`.
 */
async function resumeRows(tx: Tx, scope: DocumentAssetLedgerScope, rows: LedgerAsset[]): Promise<LedgerAsset[]> {
  const existing = await tx<Array<{ asset_id: string; status: string; reason: string | null; resumable: boolean; storage_state: string; sha256: string | null; format: string | null }>>`
    select asset_id, status, reason, resumable, storage_state, sha256, format from document_assets
    where org_id = ${scope.orgId} and project_id = ${scope.projectId} and document_id = ${scope.documentId}
      and asset_id = any(${tx.array(rows.map((row) => row.assetId))}::text[])`;
  const byId = new Map(existing.map((row) => [row.asset_id, row]));
  const out: LedgerAsset[] = [];
  for (const row of rows) {
    const old = byId.get(row.assetId);
    if (!old || old.resumable || old.storage_state === "pending") { out.push(row); continue; }
    const same = old.status === "extracted"
      ? row.status === "extracted" && row.sha256 === old.sha256 && row.format === old.format
      : row.status === old.status && row.reason === old.reason;
    if (!same) throw new DocumentAssetLedgerError("resume-rewrite");
  }
  return out;
}

interface RowCounts {
  total: number; extracted: number; notExtracted: number; unlinked: number; resumable: number;
  sourceCopy: number; sourceDecode: number; sourceRender: number; storedBytes: number;
}

/** The document's counts from its committed rows; bytes only of stored files. */
async function rowCounts(tx: Tx, scope: DocumentAssetLedgerScope): Promise<RowCounts> {
  const [row] = await tx<Array<Record<keyof RowCounts, string | number>>>`
    select count(*)::int as total,
      count(*) filter (where status = 'extracted')::int as extracted,
      count(*) filter (where status = 'not-extracted')::int as "notExtracted",
      count(*) filter (where status = 'unlinked')::int as unlinked,
      count(*) filter (where resumable)::int as resumable,
      count(*) filter (where source = 'copy')::int as "sourceCopy",
      count(*) filter (where source = 'decode')::int as "sourceDecode",
      count(*) filter (where source = 'render')::int as "sourceRender",
      coalesce(sum(bytes) filter (where storage_state = 'stored'), 0)::text as "storedBytes"
    from document_assets where org_id = ${scope.orgId} and project_id = ${scope.projectId} and document_id = ${scope.documentId}`;
  const n = (key: keyof RowCounts) => Number(row?.[key] ?? 0);
  return {
    total: n("total"), extracted: n("extracted"), notExtracted: n("notExtracted"), unlinked: n("unlinked"), resumable: n("resumable"),
    sourceCopy: n("sourceCopy"), sourceDecode: n("sourceDecode"), sourceRender: n("sourceRender"), storedBytes: n("storedBytes"),
  };
}

/** Recount an existing level from its rows (and its index and manifest bytes); the status follows what is still resumable. */
async function recountLevel(tx: Tx, scope: DocumentAssetLedgerScope): Promise<void> {
  const counts = await rowCounts(tx, scope);
  await tx`
    update document_extraction_levels set
      assets_total = ${counts.total}, assets_extracted = ${counts.extracted}, assets_not_extracted = ${counts.notExtracted},
      assets_unlinked = ${counts.unlinked}, assets_resumable = ${counts.resumable}, source_copy = ${counts.sourceCopy},
      source_decode = ${counts.sourceDecode}, source_render = ${counts.sourceRender},
      asset_bytes = ${counts.storedBytes} + index_bytes + manifest_bytes,
      images_status = case
        when ${counts.resumable} > 0 or jsonb_array_length(gaps) > 0 then 'resumable'
        when images_status = 'resumable' then 'partial' else images_status end,
      updated_at = now()
    where document_id = ${scope.documentId} and org_id = ${scope.orgId} and project_id = ${scope.projectId}`;
}

// ---- Pending and stored: what an upload in progress leaves ----

/** The fence of a write made by a resume: the figures generation it claimed. A fresh pass passes none. */
export interface FigureFence { generation: number }

async function checkFence(_tx: Tx, _scope: DocumentAssetLedgerScope, fence: FigureFence | undefined, previous: LevelRow | undefined): Promise<void> {
  if (!fence) return;
  if (!previous || Number(previous.figures_generation) !== fence.generation) throw new DocumentAssetLedgerError("stale-generation");
}

/**
 * Before their uploads: record the files about to be uploaded as `pending` rows with their content-addressed keys, so a
 * crash between upload and commit leaves rows the next attempt can adopt (HEAD + SHA-256), never unrecorded bytes. Only
 * extracted rows. A stored row is never downgraded (its file exists under its own key); a resume may not name a stored
 * image with other bytes (`resume-rewrite`). Pending rows are neither served nor billed.
 */
export async function markAssetsPending(
  sql: Sql<Record<string, unknown>>,
  args: { scope: DocumentAssetLedgerScope; rows: readonly LedgerAsset[]; fence?: FigureFence },
): Promise<{ pending: number }> {
  assertScope(args.scope);
  const rows = args.rows.map((row) => checkedRow({ ...row, storageKey: row.storageKey ?? null }, row.storageKey === undefined));
  if (rows.length > DOPPLER_MANIFEST_V2_LIMITS.maxEntries || rows.some((row) => row.status !== "extracted")) throw new DocumentAssetLedgerError("invalid-assets");
  if (rows.length === 0) return { pending: 0 };
  const { orgId, projectId, documentId, runId } = args.scope;
  return await sql.begin(async (tx) => {
    const { root, previous } = await lockAndCheck(tx, args.scope);
    await checkFence(tx, args.scope, args.fence, previous);
    for (const row of rows) {
      let key: string;
      try { key = dopplerAssetStorageKey(root, documentId, row.assetId, row.format!, row.sha256!); } catch { throw new DocumentAssetLedgerError("invalid-assets"); }
      if (row.storageKey !== null && row.storageKey !== key) throw new DocumentAssetLedgerError("key-mismatch");
      row.storageKey = key;
    }
    const writable = args.fence ? await resumeRows(tx, args.scope, rows) : rows;
    let pending = 0;
    for (let start = 0; start < writable.length; start += BATCH) {
      const payload = writable.slice(start, start + BATCH).map((row) => ({ ...assetPayload(row), storage_state: "pending" }));
      const written = await tx`
        insert into document_assets (document_id, org_id, project_id, run_id, asset_id, page_number, kind, fate, status, reason,
          resumable, source, format, bytes, sha256, width, height, repeat_of, fallback, link_path, file_of, storage_key, obj_num,
          obj_gen, bbox, storage_state)
        select ${documentId}, ${orgId}, ${projectId}, ${runId}, r.asset_id, r.page_number, r.kind, r.fate, r.status, r.reason,
          r.resumable, r.source, r.format, r.bytes, r.sha256, r.width, r.height, r.repeat_of, r.fallback, r.link_path, r.file_of,
          r.storage_key, r.obj_num, r.obj_gen, r.bbox, 'pending'
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
            bbox = excluded.bbox, storage_state = 'pending', updated_at = now()
        where document_assets.org_id = excluded.org_id and document_assets.project_id = excluded.project_id
          and document_assets.storage_state <> 'stored'
        returning 1`;
      pending += written.length;
    }
    return { pending };
  });
}

/**
 * After uploads landed and checked out: flip their pending rows to `stored` (only rows still pending with exactly the
 * key that was uploaded), and recompute the level's bytes from the stored rows. Called every 64 files.
 */
export async function markAssetsStored(
  sql: Sql<Record<string, unknown>>,
  args: { scope: DocumentAssetLedgerScope; files: ReadonlyArray<{ id: string; key: string }>; fence?: FigureFence },
): Promise<{ stored: number }> {
  assertScope(args.scope);
  if (args.files.length === 0) return { stored: 0 };
  if (args.files.length > DOPPLER_MANIFEST_V2_LIMITS.maxEntries) throw new DocumentAssetLedgerError("invalid-assets");
  return await sql.begin(async (tx) => {
    const { previous } = await lockAndCheck(tx, args.scope);
    await checkFence(tx, args.scope, args.fence, previous);
    const flipped = await tx`
      update document_assets a set storage_state = 'stored', updated_at = now()
      from unnest(${tx.array(args.files.map((file) => file.id))}::text[], ${tx.array(args.files.map((file) => file.key))}::text[]) as f(id, key)
      where a.org_id = ${args.scope.orgId} and a.project_id = ${args.scope.projectId} and a.document_id = ${args.scope.documentId}
        and a.asset_id = f.id and a.storage_key = f.key and a.storage_state = 'pending'
      returning 1`;
    if (previous) await recountLevel(tx, args.scope);
    return { stored: flipped.length };
  });
}

/** Reads a stored object as a stream (the worker's ArtifactStore.openStream); a missing object throws a not-found error. */
export interface FigureObjectReader {
  openStream(key: string, signal?: AbortSignal): Promise<{ stream: AsyncIterable<Uint8Array>; size: number | null }>;
}

function isMissingObject(error: unknown): boolean {
  const e = error as { name?: unknown; Code?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown }; cause?: unknown } | null;
  if (!e) return false;
  if (e.name === "NoSuchKey" || e.name === "NotFound" || e.Code === "NoSuchKey" || e.code === "ENOENT" || e.$metadata?.httpStatusCode === 404) return true;
  return e.cause !== undefined && e.cause !== error && isMissingObject(e.cause);
}

/** Size and SHA-256 of an object, streamed (never held whole); null when it does not exist. Stops past `limit` bytes. */
async function objectDigest(reader: FigureObjectReader, key: string, limit: number, signal?: AbortSignal): Promise<{ size: number; sha256: string } | null> {
  let opened;
  try {
    opened = await reader.openStream(key, signal);
  } catch (error) {
    if (isMissingObject(error)) return null;
    throw error;
  }
  if (opened.size !== null && opened.size > limit) return { size: opened.size, sha256: "" };
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of opened.stream) {
    signal?.throwIfAborted();
    size += chunk.length;
    if (size > limit) return { size, sha256: "" };
    hash.update(chunk);
  }
  return { size, sha256: hash.digest("hex") };
}

export interface AdoptResult { adopted: number; lost: number; kept: number }

/**
 * The adopt pass (no VM boot): every pending row of the document is checked against storage by its own derived key.
 * An object of exactly the row's size and SHA-256 is adopted (`stored`); a missing one, or one of other bytes, makes the
 * image resumable again (`not-extracted`, reason `aborted`), and the images showing its file lose their link to it. A
 * storage error other than not-found leaves the row pending for a later attempt. One transaction at the end, fenced by
 * the generation when a resume runs it; the level is recounted from the rows.
 */
export async function adoptPendingAssets(
  sql: Sql<Record<string, unknown>>,
  reader: FigureObjectReader,
  args: { scope: DocumentAssetLedgerScope; fence?: FigureFence; signal?: AbortSignal },
): Promise<AdoptResult> {
  assertScope(args.scope);
  const { orgId, projectId, documentId } = args.scope;
  const pending = await sql<Array<{ asset_id: string; storage_key: string; bytes: number; sha256: string; format: string }>>`
    select asset_id, storage_key, bytes, sha256, format from document_assets
    where org_id = ${orgId} and project_id = ${projectId} and document_id = ${documentId} and storage_state = 'pending'
    order by page_number, asset_id
    limit ${DOPPLER_MANIFEST_V2_LIMITS.maxEntries}`;
  if (pending.length === 0) return { adopted: 0, lost: 0, kept: 0 };
  const adopt: Array<{ id: string; key: string }> = [];
  const lost: string[] = [];
  let kept = 0;
  for (const row of pending) {
    args.signal?.throwIfAborted();
    let digest;
    try {
      digest = await objectDigest(reader, row.storage_key, row.bytes, args.signal);
    } catch (error) {
      if (args.signal?.aborted) throw error;
      kept += 1;
      continue;
    }
    if (digest && digest.size === row.bytes && digest.sha256 === row.sha256) adopt.push({ id: row.asset_id, key: row.storage_key });
    else lost.push(row.asset_id);
  }
  return await sql.begin(async (tx) => {
    const { root, previous } = await lockAndCheck(tx, args.scope);
    await checkFence(tx, args.scope, args.fence, previous);
    // Defense in depth: a key that is not exactly the one derived for its row is never adopted.
    const rows = await tx<Array<{ asset_id: string; storage_key: string; format: string; sha256: string }>>`
      select asset_id, storage_key, format, sha256 from document_assets
      where org_id = ${orgId} and project_id = ${projectId} and document_id = ${documentId} and storage_state = 'pending'
        and asset_id = any(${tx.array(adopt.map((file) => file.id))}::text[])`;
    const derived = new Set(rows.filter((row) => {
      try { return dopplerAssetStorageKey(root, documentId, row.asset_id, row.format as never, row.sha256) === row.storage_key; } catch { return false; }
    }).map((row) => row.asset_id));
    const adoptable = adopt.filter((file) => derived.has(file.id));
    for (const file of adopt) if (!derived.has(file.id)) lost.push(file.id);
    const flipped = await tx`
      update document_assets a set storage_state = 'stored', updated_at = now()
      from unnest(${tx.array(adoptable.map((file) => file.id))}::text[], ${tx.array(adoptable.map((file) => file.key))}::text[]) as f(id, key)
      where a.org_id = ${orgId} and a.project_id = ${projectId} and a.document_id = ${documentId}
        and a.asset_id = f.id and a.storage_key = f.key and a.storage_state = 'pending'
      returning 1`;
    const reverted = await revertToResumable(tx, args.scope, lost);
    if (previous) await recountLevel(tx, args.scope);
    return { adopted: flipped.length, lost: reverted, kept };
  });
}

/** Turn images whose file is gone back into resumable `aborted` ones (no key, no bytes); repeats lose the link. */
async function revertToResumable(tx: Tx, scope: DocumentAssetLedgerScope, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const { orgId, projectId, documentId } = scope;
  const reverted = await tx`
    update document_assets set status = 'not-extracted', reason = 'aborted', resumable = true, storage_state = 'none',
      storage_key = null, bytes = null, sha256 = null, source = null, width = null, height = null, updated_at = now()
    where org_id = ${orgId} and project_id = ${projectId} and document_id = ${documentId}
      and asset_id = any(${tx.array([...ids])}::text[]) and status = 'extracted'
    returning 1`;
  await tx`
    update document_assets set file_of = null, updated_at = now()
    where org_id = ${orgId} and project_id = ${projectId} and document_id = ${documentId}
      and file_of = any(${tx.array([...ids])}::text[]) and status <> 'extracted'`;
  return reverted.length;
}

/**
 * The audit's verdict on stored rows: images whose object is missing or of the wrong size become resumable `aborted`
 * images (the audit then queues a resume); bytes are recounted. Fenced like a resume when a generation is given.
 */
export async function markAssetsLost(
  sql: Sql<Record<string, unknown>>,
  args: { scope: DocumentAssetLedgerScope; ids: readonly string[]; fence?: FigureFence },
): Promise<{ lost: number }> {
  assertScope(args.scope);
  if (args.ids.length === 0) return { lost: 0 };
  return await sql.begin(async (tx) => {
    const { previous } = await lockAndCheck(tx, args.scope);
    await checkFence(tx, args.scope, args.fence, previous);
    const lost = await revertToResumable(tx, args.scope, args.ids);
    if (previous) await recountLevel(tx, args.scope);
    return { lost };
  });
}

// ---- Per-range deliveries: stored and committed as soon as each range validates ----

export interface FigureDeliveryStart {
  generation: number;
  /** merge: same PDF and settings as the ledger's generation (a retry, a resume, a later batch); fresh: a new pass. */
  mode: "fresh" | "merge";
  /** Images of this generation with a stored file (id → SHA-256): a delivery may repeat them, never change them. */
  stored: Map<string, string>;
}

/**
 * Start (or continue) the document's figure generation for a delivery whose manifest names `sourceSha256` and
 * `settingsSha256`. The same digests as the ledger's continue its generation (`merge`: a retry or reprocess with the same
 * settings goes through the adopt/resume path, nothing is redone or deleted). Other digests, or none recorded, start a
 * new generation (`fresh`): the previous generation's rows go (their objects become orphans the GC removes), the level
 * is reset with `markdown_complete = false` (the Markdown it will describe is not committed yet). A resume (`fence`)
 * must find exactly its generation with the same digests, else `stale-generation` / `resume-mismatch`.
 */
export async function beginFigureDelivery(
  sql: Sql<Record<string, unknown>>,
  args: { scope: DocumentAssetLedgerScope; sourceSha256: string; settingsSha256: string; fence?: FigureFence },
): Promise<FigureDeliveryStart> {
  assertScope(args.scope);
  if (!SHA256.test(args.sourceSha256 ?? "") || !SHA256.test(args.settingsSha256 ?? "")) throw new DocumentAssetLedgerError("invalid-level");
  const { orgId, projectId, documentId, runId } = args.scope;
  return await sql.begin(async (tx) => {
    const { previous } = await lockAndCheck(tx, args.scope);
    const same = !!previous && previous.source_sha256 === args.sourceSha256 && previous.settings_sha256 === args.settingsSha256;
    if (args.fence) {
      if (!previous || Number(previous.figures_generation) !== args.fence.generation) throw new DocumentAssetLedgerError("stale-generation");
      if (!same) throw new DocumentAssetLedgerError("resume-mismatch");
    }
    if (same) {
      const rows = await tx<Array<{ asset_id: string; sha256: string }>>`
        select asset_id, sha256 from document_assets
        where org_id = ${orgId} and project_id = ${projectId} and document_id = ${documentId} and storage_state = 'stored'`;
      await tx`update document_extraction_levels set run_id = ${runId}, updated_at = now()
        where document_id = ${documentId} and org_id = ${orgId} and project_id = ${projectId}`;
      return { generation: Number(previous!.figures_generation), mode: "merge", stored: new Map(rows.map((row) => [row.asset_id, row.sha256])) };
    }
    const generation = Number(previous?.figures_generation ?? 0) + 1;
    // A new pass: the previous generation's rows go (only here, never on a failure path).
    await tx`delete from document_assets where org_id = ${orgId} and project_id = ${projectId} and document_id = ${documentId}`;
    const leveled = await tx`
      insert into document_extraction_levels (document_id, org_id, project_id, run_id, markdown_complete, images_status, source_sha256,
        settings_sha256, figures_generation)
      values (${documentId}, ${orgId}, ${projectId}, ${runId}, false, 'none', ${args.sourceSha256}, ${args.settingsSha256}, ${generation})
      on conflict (document_id) do update
      set run_id = excluded.run_id, markdown_complete = false, images_status = 'none', images_exit_code = null, manifest_version = null,
          doppler_build = null, manifest_key = null, manifest_sha256 = null, source_sha256 = excluded.source_sha256,
          settings_sha256 = excluded.settings_sha256, resumes = 0, last_cut_page = null, deadline_ms = null, assets_total = 0,
          assets_extracted = 0, assets_not_extracted = 0, assets_unlinked = 0, assets_resumable = 0, source_copy = 0, source_decode = 0,
          source_render = 0, asset_bytes = 0, figures_generation = excluded.figures_generation, gaps = '[]'::jsonb, ranges = '[]'::jsonb,
          index_bytes = 0, manifest_bytes = 0, updated_at = now()
      where document_extraction_levels.org_id = excluded.org_id and document_extraction_levels.project_id = excluded.project_id
      returning 1`;
    if (leveled.length !== 1) throw new DocumentAssetLedgerError("write-mismatch");
    return { generation, mode: "fresh", stored: new Map() };
  });
}

export interface FigureDeliveryCommit {
  scope: DocumentAssetLedgerScope;
  generation: number;
  /** The pages the delivery covers (the manifest header's `pages`, or the whole document). */
  range: { first: number; last: number };
  /** Every image the delivery's manifest reports, in id order (the reader's spill, or rows in memory). */
  assets: LedgerAssets;
  /** The range's canonical manifest, already stored under its content-addressed key. */
  manifest: { key: string; sha256: string; bytes: number; version: 1 | 2 | 3 };
  run: DopplerManifestRunFacts | null;
  complete: boolean;
  exitCode: number | null;
  build: string | null;
  /** Page ranges inside the delivery that returned nothing (a failed shard of a sharded run). */
  gaps?: readonly DopplerFigureGap[];
  resume?: boolean;
}

/**
 * Commit one validated delivery whose files are uploaded and verified, in one transaction, fenced by its generation.
 * Monotonic: a stored image is never touched (another file for it is `resume-rewrite`, refusing the whole delivery);
 * every other image takes the delivery's result; nothing is pruned. The range's manifest replaces an earlier one for the
 * same range (deliveries repeat idempotently), gaps it now covers go, and the level is recounted from the rows (bytes of
 * stored files plus the stored manifests). `markdown_complete` is left as it is: the Markdown checkpoint owns it.
 */
export async function commitFigureDelivery(sql: Sql<Record<string, unknown>>, commit: FigureDeliveryCommit): Promise<{ upserted: number; kept: number; status: DocumentImagesStatus }> {
  assertScope(commit.scope);
  const { orgId, projectId, documentId, runId } = commit.scope;
  const { first, last } = commit.range;
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1 || last < first) throw new DocumentAssetLedgerError("invalid-level");
  if (!SHA256.test(commit.manifest?.sha256 ?? "") || !Number.isSafeInteger(commit.manifest.bytes) || commit.manifest.bytes < 0) throw new DocumentAssetLedgerError("invalid-level");
  if (commit.exitCode !== null && !(Number.isSafeInteger(commit.exitCode) && commit.exitCode >= 0 && commit.exitCode <= 255)) throw new DocumentAssetLedgerError("invalid-level");
  if (commit.build !== null && !DOPPLER_BUILD.test(commit.build)) throw new DocumentAssetLedgerError("invalid-level");
  return await sql.begin(async (tx) => {
    const checked = await lockAndCheck(tx, commit.scope);
    const { root, previous, pageCount } = checked;
    if (!previous || Number(previous.figures_generation) !== commit.generation) throw new DocumentAssetLedgerError("stale-generation");
    if (commit.run && (commit.run.sourceSha256 !== previous.source_sha256 || commit.run.settingsSha256 !== previous.settings_sha256)) {
      throw new DocumentAssetLedgerError("resume-mismatch");
    }
    if (last > pageCount) throw new DocumentAssetLedgerError("invalid-level");
    let manifestKey: string;
    try {
      manifestKey = dopplerRangeManifestKey(root, documentId, commit.range, commit.manifest.sha256, commit.manifest.version === 3);
    } catch {
      throw new DocumentAssetLedgerError("key-mismatch");
    }
    if (commit.manifest.key !== manifestKey) throw new DocumentAssetLedgerError("key-mismatch");
    const newGaps = checkedDopplerFigureGaps(commit.gaps ?? [], pageCount);
    if (!newGaps || newGaps.some((gap) => gap.first < first || gap.last > last)) throw new DocumentAssetLedgerError("invalid-gaps");

    let upserted = 0;
    let kept = 0;
    let rows = 0;
    let lastId: [number, number, number] | null = null;
    let batch: LedgerAsset[] = [];
    const flush = async () => {
      if (batch.length === 0) return;
      const incoming = batch;
      batch = [];
      const existing = await tx<Array<{ asset_id: string; storage_state: string; sha256: string | null }>>`
        select asset_id, storage_state, sha256 from document_assets
        where org_id = ${orgId} and project_id = ${projectId} and document_id = ${documentId}
          and asset_id = any(${tx.array(incoming.map((row) => row.assetId))}::text[]) and storage_state = 'stored'`;
      const stored = new Map(existing.map((row) => [row.asset_id, row.sha256]));
      const writable: LedgerAsset[] = [];
      for (const row of incoming) {
        if (!stored.has(row.assetId)) { writable.push(row); continue; }
        if (row.status === "extracted" && row.sha256 !== stored.get(row.assetId)) throw new DocumentAssetLedgerError("resume-rewrite");
        kept += 1;
      }
      if (writable.length === 0) return;
      const payload = writable.map(assetPayload);
      const written = await tx`
        insert into document_assets (document_id, org_id, project_id, run_id, asset_id, page_number, kind, fate, status, reason,
          resumable, source, format, bytes, sha256, width, height, repeat_of, fallback, link_path, file_of, storage_key, obj_num,
          obj_gen, bbox, storage_state)
        select ${documentId}, ${orgId}, ${projectId}, ${runId}, r.asset_id, r.page_number, r.kind, r.fate, r.status, r.reason,
          r.resumable, r.source, r.format, r.bytes, r.sha256, r.width, r.height, r.repeat_of, r.fallback, r.link_path, r.file_of,
          r.storage_key, r.obj_num, r.obj_gen, r.bbox, r.storage_state
        from jsonb_to_recordset(${tx.json(payload as unknown as JSONValue)}::jsonb) as r(
          asset_id text, page_number integer, kind text, fate text, status text, reason text, resumable boolean, source text,
          format text, bytes integer, sha256 text, width integer, height integer, repeat_of text, fallback text, link_path text,
          file_of text, storage_key text, obj_num integer, obj_gen integer, bbox double precision[], storage_state text)
        on conflict (document_id, asset_id) do update
        set run_id = excluded.run_id, page_number = excluded.page_number, kind = excluded.kind, fate = excluded.fate,
            status = excluded.status, reason = excluded.reason, resumable = excluded.resumable, source = excluded.source,
            format = excluded.format, bytes = excluded.bytes, sha256 = excluded.sha256, width = excluded.width,
            height = excluded.height, repeat_of = excluded.repeat_of, fallback = excluded.fallback, link_path = excluded.link_path,
            file_of = excluded.file_of, storage_key = excluded.storage_key, obj_num = excluded.obj_num, obj_gen = excluded.obj_gen,
            bbox = excluded.bbox, storage_state = excluded.storage_state, updated_at = now()
        where document_assets.org_id = excluded.org_id and document_assets.project_id = excluded.project_id
          and document_assets.storage_state <> 'stored'
        returning 1`;
      upserted += written.length;
    };
    for await (const asset of orderedRows(commit.assets)) {
      const key = idKey(asset.assetId);
      if (lastId && !idBefore(lastId, key)) throw new DocumentAssetLedgerError("invalid-assets");
      lastId = key;
      if (++rows > DOPPLER_MANIFEST_V2_LIMITS.maxEntries) throw new DocumentAssetLedgerError("invalid-assets");
      // A delivery reports only its own pages.
      if (asset.pageNumber < first || asset.pageNumber > last) throw new DocumentAssetLedgerError("invalid-assets");
      if (asset.status === "extracted") {
        let storageKey: string;
        try { storageKey = dopplerAssetStorageKey(root, documentId, asset.assetId, asset.format!, asset.sha256!); } catch { throw new DocumentAssetLedgerError("invalid-assets"); }
        if (asset.storageKey !== null && asset.storageKey !== storageKey) throw new DocumentAssetLedgerError("key-mismatch");
        asset.storageKey = storageKey;
      }
      batch.push(asset);
      if (batch.length >= BATCH) await flush();
    }
    await flush();

    const [current] = await tx<Array<{ ranges: DopplerFigureRange[]; gaps: DopplerFigureGap[]; resumes: number }>>`
      select ranges, gaps, resumes from document_extraction_levels where document_id = ${documentId} and org_id = ${orgId} and project_id = ${projectId}`;
    const ranges = (current?.ranges ?? []).filter((range) => !(range.first === first && range.last === last));
    ranges.push({ first, last, key: manifestKey, sha256: commit.manifest.sha256, bytes: commit.manifest.bytes, complete: commit.complete });
    ranges.sort((a, b) => a.first - b.first || a.last - b.last);
    if (ranges.length > DOPPLER_FIGURE_MAX_GAPS) throw new DocumentAssetLedgerError("invalid-gaps");
    const gaps = [...(current?.gaps ?? []).filter((gap) => gap.last < first || gap.first > last), ...newGaps].sort((a, b) => a.first - b.first);
    if (!checkedDopplerFigureGaps(gaps, pageCount)) throw new DocumentAssetLedgerError("invalid-gaps");
    const manifestBytes = ranges.reduce((sum, range) => sum + range.bytes, 0);
    const counts = await rowCounts(tx, commit.scope);
    const covered = coversAll(ranges.filter((range) => range.complete), pageCount);
    const status: DocumentImagesStatus = counts.resumable > 0 || gaps.length > 0 ? "resumable" : covered ? "complete" : "partial";
    const resumes = commit.resume ? Math.min((current?.resumes ?? 0) + 1, 1000) : (current?.resumes ?? 0);
    const facts = commit.run;
    const updated = await tx`
      update document_extraction_levels set
        run_id = ${runId}, images_status = ${status}, images_exit_code = ${commit.exitCode}, manifest_version = ${commit.manifest.version},
        doppler_build = ${commit.build}, manifest_key = ${manifestKey}, manifest_sha256 = ${commit.manifest.sha256},
        last_cut_page = ${facts?.lastCutPage ?? null}, deadline_ms = ${facts?.deadlineMs ?? null}, resumes = ${resumes},
        assets_total = ${counts.total}, assets_extracted = ${counts.extracted}, assets_not_extracted = ${counts.notExtracted},
        assets_unlinked = ${counts.unlinked}, assets_resumable = ${counts.resumable}, source_copy = ${counts.sourceCopy},
        source_decode = ${counts.sourceDecode}, source_render = ${counts.sourceRender},
        ranges = ${tx.json(ranges as unknown as JSONValue)}, gaps = ${tx.json(gaps as unknown as JSONValue)},
        manifest_bytes = ${manifestBytes}, asset_bytes = ${counts.storedBytes} + index_bytes + ${manifestBytes}, updated_at = now()
      where document_id = ${documentId} and org_id = ${orgId} and project_id = ${projectId} and figures_generation = ${commit.generation}
      returning 1`;
    if (updated.length !== 1) throw new DocumentAssetLedgerError("stale-generation");
    return { upserted, kept, status };
  });
}

/** Whether complete ranges cover pages 1..pageCount. */
function coversAll(ranges: readonly { first: number; last: number }[], pageCount: number): boolean {
  let next = 1;
  for (const range of [...ranges].sort((a, b) => a.first - b.first)) {
    if (range.first > next) return false;
    next = Math.max(next, range.last + 1);
  }
  return next > pageCount;
}

/**
 * The level after the Markdown checkpoint (or for a document whose figure step did not run): sets `markdown_complete`,
 * and the images status only when no delivery recorded anything (rows and ranges win: a failed or missing figure step
 * never hides or deletes figures already stored). Never deletes a row. The index's bytes count from here on.
 */
export async function writeFigureLevel(
  sql: Sql<Record<string, unknown>>,
  args: { scope: DocumentAssetLedgerScope; markdownComplete: boolean; imagesStatus: DocumentImagesStatus; exitCode?: number | null; build?: string | null; indexBytes?: number },
): Promise<void> {
  assertScope(args.scope);
  if (!DOCUMENT_IMAGES_STATUSES.includes(args.imagesStatus) || args.imagesStatus === "resumable") throw new DocumentAssetLedgerError("invalid-level");
  const exitCode = args.exitCode ?? null;
  const build = args.build ?? null;
  if ((exitCode !== null && !(Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255)) || (build !== null && !DOPPLER_BUILD.test(build))) {
    throw new DocumentAssetLedgerError("invalid-level");
  }
  const indexBytes = byteCount(args.indexBytes);
  const { orgId, projectId, documentId, runId } = args.scope;
  await sql.begin(async (tx) => {
    await lockAndCheck(tx, args.scope);
    const leveled = await tx`
      insert into document_extraction_levels (document_id, org_id, project_id, run_id, markdown_complete, images_status, images_exit_code, doppler_build)
      values (${documentId}, ${orgId}, ${projectId}, ${runId}, ${args.markdownComplete}, ${args.imagesStatus}, ${exitCode}, ${build})
      on conflict (document_id) do update
      set run_id = excluded.run_id, markdown_complete = excluded.markdown_complete,
          images_status = case when document_extraction_levels.assets_total > 0 or jsonb_array_length(document_extraction_levels.ranges) > 0
            or document_extraction_levels.images_status = 'resumable' then document_extraction_levels.images_status else excluded.images_status end,
          images_exit_code = coalesce(excluded.images_exit_code, document_extraction_levels.images_exit_code),
          doppler_build = coalesce(excluded.doppler_build, document_extraction_levels.doppler_build),
          updated_at = now()
      where document_extraction_levels.org_id = excluded.org_id and document_extraction_levels.project_id = excluded.project_id
      returning 1`;
    if (leveled.length !== 1) throw new DocumentAssetLedgerError("write-mismatch");
    if (args.indexBytes !== undefined) {
      await tx`update document_extraction_levels set index_bytes = ${indexBytes},
          asset_bytes = asset_bytes - index_bytes + ${indexBytes}
        where document_id = ${documentId} and org_id = ${orgId} and project_id = ${projectId}`;
    }
  });
}

/** The stored files of the document (id, key): the slots its committed Markdown serves. Scoped by org and project. */
export async function storedFigureFiles(sql: Sql<Record<string, unknown>>, scope: Omit<DocumentAssetLedgerScope, "runId">): Promise<Array<{ id: string; key: string }>> {
  const rows = await sql<Array<{ asset_id: string; storage_key: string }>>`
    select asset_id, storage_key from document_assets
    where org_id = ${scope.orgId} and project_id = ${scope.projectId} and document_id = ${scope.documentId} and storage_state = 'stored'
    order by page_number, asset_id`;
  return rows.map((row) => ({ id: row.asset_id, key: row.storage_key }));
}

/** The document's figure level for planning a retry or a resume (digests, generation, ranges), or null. */
export async function readFigureLevel(sql: Sql<Record<string, unknown>>, scope: Omit<DocumentAssetLedgerScope, "runId">): Promise<{
  generation: number; sourceSha256: string | null; settingsSha256: string | null; imagesStatus: DocumentImagesStatus;
  ranges: DopplerFigureRange[]; gaps: DopplerFigureGap[]; pending: number; resumes: number;
} | null> {
  const [row] = await sql<Array<{ figures_generation: string | number; source_sha256: string | null; settings_sha256: string | null; images_status: DocumentImagesStatus; ranges: DopplerFigureRange[]; gaps: DopplerFigureGap[]; pending: number; resumes: number }>>`
    select l.figures_generation, l.source_sha256, l.settings_sha256, l.images_status, l.ranges, l.gaps, l.resumes,
      (select count(*)::int from document_assets a where a.org_id = l.org_id and a.project_id = l.project_id and a.document_id = l.document_id
        and a.storage_state = 'pending') as pending
    from document_extraction_levels l
    where l.document_id = ${scope.documentId} and l.org_id = ${scope.orgId} and l.project_id = ${scope.projectId}`;
  if (!row) return null;
  return {
    generation: Number(row.figures_generation), sourceSha256: row.source_sha256, settingsSha256: row.settings_sha256, imagesStatus: row.images_status,
    ranges: row.ranges, gaps: row.gaps, pending: row.pending, resumes: row.resumes,
  };
}

/** The document's ledger rows as DocumentAsset (for the index), in id order; bounded by the entry cap. Scoped. */
export async function figureIndexRows(sql: Sql<Record<string, unknown>>, scope: Omit<DocumentAssetLedgerScope, "runId">): Promise<DocumentAsset[]> {
  const rows = await sql<Array<Record<string, unknown>>>`
    select asset_id, page_number, kind, fate, status, reason, resumable, source, format, bytes, sha256, width, height, repeat_of, fallback,
      link_path, file_of, obj_num, obj_gen, bbox, storage_state
    from document_assets
    where org_id = ${scope.orgId} and project_id = ${scope.projectId} and document_id = ${scope.documentId}
    order by page_number, (position('.g' in asset_id) > 0), substring(asset_id from '([0-9]+)$')::int
    limit ${DOPPLER_MANIFEST_V2_LIMITS.maxEntries}`;
  return rows.map((row) => ({
    assetId: row.asset_id as string, pageNumber: row.page_number as number, kind: row.kind as DocumentAsset["kind"], fate: row.fate as DocumentAsset["fate"],
    // A pending file is not served: the index shows the image as not extracted yet.
    status: (row.status === "extracted" && row.storage_state !== "stored" ? "not-extracted" : row.status) as DocumentAsset["status"],
    reason: (row.status === "extracted" && row.storage_state !== "stored" ? "aborted" : row.reason) as DocumentAsset["reason"],
    resumable: (row.resumable as boolean) || (row.status === "extracted" && row.storage_state !== "stored"),
    source: row.source as DocumentAsset["source"], format: row.format as DocumentAsset["format"], bytes: row.bytes as number | null,
    sha256: row.sha256 as string | null, width: row.width as number | null, height: row.height as number | null,
    repeatOf: row.repeat_of as string | null, fallback: row.fallback as DocumentAsset["fallback"], linkPath: row.link_path as string | null,
    fileOf: row.file_of as string | null, obj: row.obj_num === null ? null : [row.obj_num as number, row.obj_gen as number],
    bbox: row.bbox as DocumentAsset["bbox"],
  }) as DocumentAsset);
}

// ---- Building a write from the figure step ----

export interface FigureStepOutcome {
  /** extracted (exit 0), partial (exit 5 with a kept folder), failed (no folder to trust, or it was refused). */
  status: "extracted" | "partial" | "failed";
  exitCode?: number;
  build?: string;
}

/** The images status a read folder means: complete, resumable (a resume would retry some) or partial. */
export function imagesStatusOf(set: Pick<DopplerFigureSet, "complete" | "ledger">, gaps: readonly DopplerFigureGap[] = []): DocumentImagesStatus {
  if (set.ledger.counts.resumable > 0 || gaps.length > 0) return "resumable";
  return set.complete ? "complete" : "partial";
}

/** A ledger write waiting for the stage checkpoint (WorkflowState.pendingAssetLedger); the flush adds scope and markdownComplete. */
export interface PendingAssetLedgerWrite {
  level: Omit<DocumentExtractionLevelInput, "markdownComplete">;
  assets: LedgerAssets;
  resume?: boolean;
  /** A resume's claimed figures generation (the fence its write compares and sets). */
  generation?: number;
  /** The level only, never a row (DocumentAssetLedgerWrite.levelOnly). */
  levelOnly?: boolean;
}

/** The ledger write for a stored figure set: every image, streamed back from the reader's spill. */
export function ledgerWriteForStoredFigures(args: {
  set: Pick<DopplerFigureSet, "version" | "complete" | "ledger" | "run">;
  /** The stored canonical manifest's key and SHA-256, and the stored manifest and index sizes. */
  storedManifest: { key: string; sha256: string };
  storedBytes?: { manifest: number; index: number };
  outcome: FigureStepOutcome;
  /** Page ranges a shard returned nothing for (FigureStepOutcome of a sharded provider). */
  gaps?: readonly DopplerFigureGap[];
}): PendingAssetLedgerWrite {
  const gaps = args.gaps ?? [];
  return {
    level: {
      imagesStatus: imagesStatusOf(args.set, gaps), imagesExitCode: args.outcome.exitCode ?? null, manifestVersion: args.set.version,
      dopplerBuild: args.outcome.build ?? null, run: args.set.run, manifest: args.storedManifest,
      ...(args.storedBytes ? { manifestBytes: args.storedBytes.manifest, indexBytes: args.storedBytes.index } : {}),
      ...(gaps.length > 0 ? { gaps } : {}),
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
    // Never deletes: figures a delivery already stored stay, with their honest status.
    levelOnly: true,
  };
}

/**
 * The level for committed Markdown whose figure step did not run: `disabled` (figures off for the run) or `none` (another
 * extractor won, the document is not a PDF, or no VM). Level only: figures stored by an earlier attempt are kept (a new
 * pass with other settings replaces them; deleting the document purges them).
 */
export function ledgerWriteForNoFigures(status: "none" | "disabled"): PendingAssetLedgerWrite {
  return { level: { imagesStatus: status, imagesExitCode: null, manifestVersion: null, dopplerBuild: null, run: null, manifest: null }, assets: [], levelOnly: true };
}

/** The checkpoint after per-range deliveries: the Markdown is committed (the flush says so) and the index is stored. */
export function ledgerWriteForDeliveredFigures(args: { outcome: Omit<FigureStepOutcome, "status">; indexBytes: number }): PendingAssetLedgerWrite {
  return {
    level: {
      imagesStatus: "complete", imagesExitCode: args.outcome.exitCode ?? null, manifestVersion: 3, dopplerBuild: args.outcome.build ?? null,
      run: null, manifest: null, indexBytes: args.indexBytes,
    },
    assets: [],
    levelOnly: true,
  };
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
      ...(entry.resume ? { resume: true, generation: entry.generation } : {}),
      ...(entry.levelOnly ? { levelOnly: true } : {}),
    });
    return "written";
  } catch (error) {
    if (error instanceof DocumentAssetLedgerError) {
      const status = error.rule === "stale-write" || error.rule === "stale-generation" ? "stale-write" : "refused";
      console.warn(`[asset-ledger] document=${documentId} status=${status} rule=${error.rule}`);
      return status;
    }
    const code = (error as { code?: unknown } | null)?.code;
    console.warn(`[asset-ledger] document=${documentId} status=failed error=${error instanceof Error ? error.name : typeof error}${typeof code === "string" ? ` code=${code}` : ""}`);
    return "failed";
  }
}

/**
 * The ledger beside a fresh figure upload: pending rows before each upload step, through the run's store under the run's
 * organization and project, so a crash between upload and commit leaves rows the next attempt can adopt and the audit
 * knows which objects were meant. The final ledger write flips them to stored together with the slots that serve them.
 * None without a store that has it, or for a run without a scope (the final ledger write is then the only record).
 */
export function figureLedgerHooks(
  state: { store?: { markAssetsPending?(args: Parameters<typeof markAssetsPending>[1]): Promise<unknown> }; run: { id: string; orgId: string | null; projectId?: string | null } },
  documentId: string,
): DopplerFigureLedgerHooks | undefined {
  const store = state.store;
  if (!store?.markAssetsPending || !state.run.orgId || !state.run.projectId) return undefined;
  const scope = { orgId: state.run.orgId, projectId: state.run.projectId, documentId, runId: state.run.id };
  return { pending: async (rows) => { await store.markAssetsPending!({ scope, rows }); } };
}

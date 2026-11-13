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
import { rm } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { JSONValue, Sql } from "postgres";
import {
  DOCUMENT_IMAGES_STATUSES, DOPPLER_BUILD, DOPPLER_MANIFEST_V2_LIMITS, DOPPLER_MANIFEST_V3_FILE, DOPPLER_STORE_LAYOUT,
  addDocumentAssetCount, dopplerAssetStorageKey, emptyDocumentAssetCounts, isDocumentAssetRow, dopplerDocumentPrefix,
  DOPPLER_FIGURE_GAP_REASONS, DOPPLER_FIGURE_GAPS_MAX, DOPPLER_SHARDS_MAX, dopplerShardFolder, dopplerShardsContiguous,
  parseDopplerFigureId, type DocumentAsset, type DocumentImagesStatus, type DopplerFigureGap, type DopplerManifestRunFacts,
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
  /** The stored manifest (`<root>/doppler/<document>/images/manifest.jsonl`) and its SHA-256; null for shards. */
  manifest: { key: string; sha256: string } | null;
  /** Page ranges the provider reported without images (SandboxedPdfFigureOutcome.gaps), at most 128. */
  gaps?: readonly DopplerFigureGap[] | null;
  /** Bytes of the folder's own stored files (manifests, page facts, Markdown, index); a resume keeps the level's. */
  folderBytes?: number;
}

/** One shard manifest of a sharded document (document_extraction_shards). */
export interface LedgerShard {
  first: number;
  last: number;
  manifestKey: string;
  manifestSha256: string;
  sourceSha256: string;
  settingsSha256: string;
  imagesStatus: "complete" | "partial" | "resumable";
  assetsResumable: number;
  lastCutPage: number | null;
  deadlineMs: number | null;
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
   * A resume's write (`--images-resume`): the host counts it, previous + 1, and refuses one past the cap. For a sharded
   * document a resume is one shard's (`{ first, last }`): only that shard's rows and record change.
   */
  resume?: boolean | { first: number; last: number };
  /** The shard manifests of a sharded document (all of them; a shard resume names exactly its own). */
  shards?: readonly LedgerShard[];
  /**
   * The level only (writeFigureLevel): never touches or deletes a row. The failed-figures and no-figures writes: figures
   * an attempt already stored are kept (owner rule: orphan GC is the only deleter).
   */
  levelOnly?: boolean;
}

/** Resumes a document (or one shard) may have before the resume queue leaves it alone (counted by the host, not the manifest). */
export const DOCUMENT_ASSET_RESUME_CAP = 3;
/** A sharded document's resumes across all its shards: `min(3 x shards, 12)`. Past it no shard of it is listed or resumed. */
export const DOCUMENT_ASSET_RESUME_TOTAL_CAP = 12;
export function documentResumeTotalCap(shards: number): number {
  return Math.min(DOCUMENT_ASSET_RESUME_CAP * Math.max(1, shards), DOCUMENT_ASSET_RESUME_TOTAL_CAP);
}

export type DocumentAssetLedgerRule =
  | "invalid-scope" | "invalid-assets" | "invalid-level" | "scope-mismatch" | "key-mismatch" | "stale-write" | "resume-cap" | "write-mismatch"
  | "resume-rewrite";

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

/**
 * Shard records re-validated: at most DOPPLER_SHARDS_MAX, sorted, not overlapping, each key exactly its folder's. A full
 * write's shards start at page 1 with no hole between them except where one of its gaps covers the hole whole
 * (`contiguous`); a shard resume names one existing shard or lies inside a gap.
 */
function checkedShards(shards: readonly LedgerShard[], imagesPrefix: string, contiguous: { gaps: readonly DopplerFigureGap[] | null } | null): LedgerShard[] {
  if (!Array.isArray(shards) || shards.length > DOPPLER_SHARDS_MAX) throw new DocumentAssetLedgerError("invalid-level");
  let previous = 0;
  for (const shard of shards) {
    const range = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 1 && (n as number) <= 1_000_000_000;
    if (!shard || !range(shard.first) || !range(shard.last) || shard.first > shard.last || shard.first <= previous ||
        !SHA256.test(shard.manifestSha256) || !SHA256.test(shard.sourceSha256) || !SHA256.test(shard.settingsSha256) ||
        !["complete", "partial", "resumable"].includes(shard.imagesStatus) || !Number.isSafeInteger(shard.assetsResumable) ||
        shard.assetsResumable < 0 || (shard.imagesStatus === "resumable") !== (shard.assetsResumable > 0) ||
        (shard.lastCutPage !== null && !range(shard.lastCutPage)) ||
        (shard.deadlineMs !== null && !(Number.isSafeInteger(shard.deadlineMs) && shard.deadlineMs >= 0 && shard.deadlineMs <= 2_000_000_000))) {
      throw new DocumentAssetLedgerError("invalid-level");
    }
    if (shard.manifestKey !== `${imagesPrefix}shards/${dopplerShardFolder(shard.first, shard.last)}/${DOPPLER_MANIFEST_V3_FILE}`) {
      throw new DocumentAssetLedgerError("key-mismatch");
    }
    previous = shard.last;
  }
  // Holes only where a recorded gap covers them whole (the folder itself passed dopplerShardCoverage when it was read).
  if (contiguous && !dopplerShardsContiguous(shards.map((shard) => [shard.first, shard.last] as const), contiguous.gaps)) {
    throw new DocumentAssetLedgerError("invalid-level");
  }
  return [...shards];
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
  const gaps = level?.gaps;
  if (gaps != null && !(Array.isArray(gaps) && gaps.length <= DOPPLER_FIGURE_GAPS_MAX && gaps.every((gap, i) =>
    gap && Number.isSafeInteger(gap.first) && Number.isSafeInteger(gap.last) && gap.first >= 1 && gap.first <= gap.last &&
    gap.last <= 1_000_000_000 && (i === 0 || gap.first > gaps[i - 1]!.last) && (DOPPLER_FIGURE_GAP_REASONS as readonly string[]).includes(gap.reason)))) {
    throw new DocumentAssetLedgerError("invalid-level");
  }
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
    // A full write follows its uploads (all landed and verified): its files are stored.
    storage_state: asset.status === "extracted" ? "stored" : "none",
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
  if (write.levelOnly) {
    // The level only: no rows, no manifest and no shards (the shard rules apply to a full write).
    if ((write.shards?.length ?? 0) > 0 || write.level.manifest) throw new DocumentAssetLedgerError("invalid-level");
    await writeFigureLevel(sql, {
      scope: write.scope, markdownComplete: write.level.markdownComplete, imagesStatus: write.level.imagesStatus,
      exitCode: write.level.imagesExitCode, build: write.level.dopplerBuild, gaps: write.level.gaps ?? null,
    });
    return { upserted: 0, removed: 0, resumes: 0 };
  }
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
    const shardResume = typeof write.resume === "object" && write.resume !== null ? write.resume : null;
    const resuming = write.resume === true || shardResume !== null;
    // Earlier runs' figure folders, read before this write moves any row: queued for purge once it commits (fresh writes only).
    const oldFolders = resuming ? [] : await oldFigureFolders(tx, write.scope, root);
    // A full write's shards start at page 1 with no hole except where one of its gaps covers it whole.
    const shards = checkedShards(write.shards ?? [], `${prefix}${DOPPLER_STORE_LAYOUT.imagesFolder}`, shardResume ? null : { gaps: write.level.gaps ?? null });
    if (shards.length > 0 && write.level.manifest) throw new DocumentAssetLedgerError("invalid-level");
    const priorResumes = previous?.resumes ?? 0;
    if (write.resume === true && priorResumes >= DOCUMENT_ASSET_RESUME_CAP) throw new DocumentAssetLedgerError("resume-cap");
    let resumes = write.resume === true ? priorResumes + 1 : 0;
    let shardResumes = 0;
    if (shardResume) {
      // A shard's resume: exactly that shard, which this document already has; counted per shard and capped.
      if (shards.length !== 1 || shards[0]!.first !== shardResume.first || shards[0]!.last !== shardResume.last) throw new DocumentAssetLedgerError("invalid-level");
      const [existing] = await tx<{ resumes: number }[]>`
        select resumes from document_extraction_shards
        where document_id = ${documentId} and org_id = ${orgId} and project_id = ${projectId}
          and first_page = ${shardResume.first} and last_page = ${shardResume.last}`;
      // The document's total across its shards (documentResumeTotalCap), for a shard's resume and a gap's alike.
      const [total] = await tx<{ n: number; resumes: number }[]>`
        select count(*)::int as n, coalesce(sum(resumes), 0)::int as resumes from document_extraction_shards
        where document_id = ${documentId} and org_id = ${orgId} and project_id = ${projectId}`;
      if ((total?.resumes ?? 0) >= documentResumeTotalCap(total?.n ?? 1)) throw new DocumentAssetLedgerError("resume-cap");
      if (existing) {
        if (existing.resumes >= DOCUMENT_ASSET_RESUME_CAP) throw new DocumentAssetLedgerError("resume-cap");
        shardResumes = existing.resumes + 1;
      } else {
        // A gap's resume (a fresh pass over pages no shard returned): the range must lie inside one of the level's gaps;
        // its shard is created here.
        const [level] = await tx<{ gaps: DopplerFigureGap[] | null }[]>`
          select gaps from document_extraction_levels where document_id = ${documentId} and org_id = ${orgId} and project_id = ${projectId}`;
        const inGap = (level?.gaps ?? []).some((gap) => gap.first <= shardResume.first && shardResume.last <= gap.last);
        if (!inGap) throw new DocumentAssetLedgerError("invalid-level");
        shardResumes = 1;
      }
    }
    // The level's gaps after this write: a full write states them; a shard (or gap) resume keeps the others and replaces
    // whatever overlapped its range with what it reports inside it.
    let levelGaps: DopplerFigureGap[] = [...(write.level.gaps ?? [])];
    if (shardResume) {
      const [current] = await tx<{ gaps: DopplerFigureGap[] | null }[]>`
        select gaps from document_extraction_levels where document_id = ${documentId} and org_id = ${orgId} and project_id = ${projectId}`;
      const inside = (write.level.gaps ?? []).filter((gap) => gap.first >= shardResume.first && gap.last <= shardResume.last);
      const outside: DopplerFigureGap[] = [];
      for (const gap of current?.gaps ?? []) {
        if (gap.last < shardResume.first || gap.first > shardResume.last) { outside.push(gap); continue; }
        // The parts of an overlapping gap outside the resumed range stay gaps.
        if (gap.first < shardResume.first) outside.push({ ...gap, last: shardResume.first - 1 });
        if (gap.last > shardResume.last) outside.push({ ...gap, first: shardResume.last + 1 });
      }
      levelGaps = [...outside, ...inside].sort((a, b) => a.first - b.first);
      // Never truncated: a dropped range would be neither a shard nor a gap (lost work).
      if (levelGaps.length > DOPPLER_FIGURE_GAPS_MAX) throw new DocumentAssetLedgerError("invalid-level");
    }

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
    let pruneFrom = shardResume?.first ?? 1;
    let pruneTo = 0;
    let currentPage = 0;
    let last: [number, number, number] | null = null;
    const upsert = async () => {
      if (batch.length === 0) return;
      if (resuming) await refuseResumeRewrites(tx, write.scope, batch);
      const payload = batch.map(assetPayload);
      batch = [];
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
          -- A resume only adds: a stored file is never rewritten by one (refuseResumeRewrites refused another file for it).
          ${resuming ? tx`and document_assets.storage_state <> 'stored'` : tx``}
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
      if (to !== null && to < pruneFrom) return;
      const gone = await tx`
        delete from document_assets a
        where a.org_id = ${orgId} and a.project_id = ${projectId} and a.document_id = ${documentId}
          -- A resume never prunes a stored file. A fresh pass may, when its manifest no longer lists it; the orphan GC then
          -- removes the object.
          ${resuming ? tx`and a.storage_state <> 'stored'` : tx``}
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
      // A shard's resume writes only its own pages.
      if (shardResume && (asset.pageNumber < shardResume.first || asset.pageNumber > shardResume.last)) throw new DocumentAssetLedgerError("invalid-assets");
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
    await prune(shardResume ? shardResume.last : null);

    // Shard records: a full write replaces them (none for an unsharded document); a shard resume updates its own.
    if (!shardResume) {
      await tx`
        delete from document_extraction_shards
        where document_id = ${documentId} and org_id = ${orgId} and project_id = ${projectId}
          and not (first_page = any(${tx.array(shards.map((shard) => shard.first))}::int[]))`;
    }
    for (const shard of shards) {
      await tx`
        insert into document_extraction_shards (document_id, org_id, project_id, run_id, first_page, last_page, manifest_key, manifest_sha256,
          source_sha256, settings_sha256, images_status, assets_resumable, resumes, last_cut_page, deadline_ms)
        values (${documentId}, ${orgId}, ${projectId}, ${runId}, ${shard.first}, ${shard.last}, ${shard.manifestKey}, ${shard.manifestSha256},
          ${shard.sourceSha256}, ${shard.settingsSha256}, ${shard.imagesStatus}, ${shard.assetsResumable}, ${shardResume ? shardResumes : 0},
          ${shard.lastCutPage}, ${shard.deadlineMs})
        on conflict (document_id, first_page) do update
        set run_id = excluded.run_id, last_page = excluded.last_page, manifest_key = excluded.manifest_key,
            manifest_sha256 = excluded.manifest_sha256, source_sha256 = excluded.source_sha256, settings_sha256 = excluded.settings_sha256,
            images_status = excluded.images_status, assets_resumable = excluded.assets_resumable, resumes = excluded.resumes,
            last_cut_page = excluded.last_cut_page, deadline_ms = excluded.deadline_ms, updated_at = now()
        where document_extraction_shards.org_id = excluded.org_id and document_extraction_shards.project_id = excluded.project_id`;
    }

    // The level's counts are the document's rows as they now stand (a shard resume changed only its own).
    const [totals] = await tx<Array<{ total: number; extracted: number; not_extracted: number; unlinked: number; resumable: number; pending: number; copy: number; decode: number; render: number; bytes: string }>>`
      select count(*)::int as total, count(*) filter (where status = 'extracted')::int as extracted,
        count(*) filter (where status = 'not-extracted')::int as not_extracted, count(*) filter (where status = 'unlinked')::int as unlinked,
        count(*) filter (where resumable)::int as resumable, count(*) filter (where storage_state = 'pending')::int as pending,
        count(*) filter (where source = 'copy')::int as copy,
        count(*) filter (where source = 'decode')::int as decode, count(*) filter (where source = 'render')::int as render,
        -- Billed bytes: files whose upload landed and checked out.
        coalesce(sum(bytes) filter (where storage_state = 'stored'), 0)::text as bytes
      -- This run's rows only (the one recount rule, shared with recountLevel): another run's rows are never current.
      from document_assets where document_id = ${documentId} and org_id = ${orgId} and project_id = ${projectId} and run_id = ${runId}`;
    const [shardState] = await tx<Array<{ n: number; incomplete: number; resumes: number; cut: number | null; source: string | null }>>`
      select count(*)::int as n, count(*) filter (where images_status <> 'complete')::int as incomplete,
        coalesce(max(resumes), 0)::int as resumes, max(last_cut_page) as cut, min(source_sha256) as source
      from document_extraction_shards where document_id = ${documentId} and org_id = ${orgId} and project_id = ${projectId}`;
    const sharded = (shardState?.n ?? 0) > 0;
    let imagesStatus = write.level.imagesStatus;
    // Gaps (pages a shard or the document's pass budget left with no manifest) are resumable work too, within the caps; a
    // gap a shard now covers is recorded but no longer work. Uploads a crash left pending are work as well (adopted, no VM).
    // Only a complete shard covers a gap: a gap inside a partial shard (its inner gaps, e.g. a gap resume that came back
    // partial) stays work, resumed as that shard's resume narrowed to the gap's pages.
    const covered = await tx<{ first_page: number; last_page: number }[]>`
      select first_page, last_page from document_extraction_shards where document_id = ${documentId} and org_id = ${orgId} and project_id = ${projectId}
        and images_status = 'complete'`;
    const effectiveGaps = levelGaps.filter((gap) => !covered.some((shard) => shard.first_page <= gap.last && gap.first <= shard.last_page));
    const anyResumable = totals!.resumable > 0 || totals!.pending > 0 || effectiveGaps.length > 0;
    if (sharded) {
      // Complete only if every shard is and no gap is left; resumable while any image or gap a resume would retry remains.
      imagesStatus = shardState!.incomplete === 0 && effectiveGaps.length === 0 && totals!.pending === 0 ? "complete" : anyResumable ? "resumable" : "partial";
      resumes = shardState!.resumes;
    } else if (imagesStatus === "resumable" && !anyResumable) {
      throw new DocumentAssetLedgerError("invalid-level");
    } else if (anyResumable) {
      imagesStatus = "resumable";
    }
    const counts2 = {
      total: totals!.total, extracted: totals!.extracted, notExtracted: totals!.not_extracted, unlinked: totals!.unlinked,
      resumable: totals!.resumable, sourceCopy: totals!.copy, sourceDecode: totals!.decode, sourceRender: totals!.render, bytes: totals!.bytes,
    };
    const level = { ...write.level, imagesStatus, gaps: levelGaps };
    // Folder files: a fresh write states them; a resume keeps the level's until it publishes new ones.
    const folderBytes = write.level.folderBytes !== undefined ? byteCount(write.level.folderBytes) : null;
    const facts = sharded
      ? { ...(level.run ?? { manifestResumes: 0, complete: false, resumable: false, deadlineMs: null }), sourceSha256: shardState!.source, settingsSha256: null, lastCutPage: shardState!.cut }
      : level.run;
    const leveled = await tx`
      insert into document_extraction_levels (document_id, org_id, project_id, run_id, markdown_complete, images_status,
        images_exit_code, manifest_version, doppler_build, manifest_key, manifest_sha256, source_sha256, settings_sha256, resumes,
        last_cut_page, deadline_ms, assets_total, assets_extracted, assets_not_extracted, assets_unlinked, assets_resumable,
        source_copy, source_decode, source_render, asset_bytes, gaps, shards, assets_pending, folder_bytes)
      values (${documentId}, ${orgId}, ${projectId}, ${runId}, ${level.markdownComplete}, ${level.imagesStatus},
        ${level.imagesExitCode}, ${level.manifestVersion}, ${level.dopplerBuild}, ${level.manifest?.key ?? null},
        ${level.manifest?.sha256 ?? null}, ${facts?.sourceSha256 ?? null}, ${facts?.settingsSha256 ?? null}, ${resumes},
        ${facts?.lastCutPage ?? null}, ${facts?.deadlineMs ?? null}, ${counts2.total}, ${counts2.extracted}, ${counts2.notExtracted},
        ${counts2.unlinked}, ${counts2.resumable}, ${counts2.sourceCopy}, ${counts2.sourceDecode}, ${counts2.sourceRender}, ${counts2.bytes}::bigint,
        ${level.gaps && level.gaps.length > 0 ? tx.json(level.gaps.map((gap) => ({ first: gap.first, last: gap.last, reason: gap.reason })) as unknown as JSONValue) : null},
        ${shardState?.n ?? 0}, ${totals!.pending}, ${folderBytes ?? 0})
      on conflict (document_id) do update
      set run_id = excluded.run_id, markdown_complete = excluded.markdown_complete, images_status = excluded.images_status,
          images_exit_code = excluded.images_exit_code, manifest_version = excluded.manifest_version,
          doppler_build = excluded.doppler_build, manifest_key = excluded.manifest_key, manifest_sha256 = excluded.manifest_sha256,
          source_sha256 = excluded.source_sha256, settings_sha256 = excluded.settings_sha256, resumes = excluded.resumes,
          last_cut_page = excluded.last_cut_page, deadline_ms = excluded.deadline_ms, assets_total = excluded.assets_total,
          assets_extracted = excluded.assets_extracted, assets_not_extracted = excluded.assets_not_extracted,
          assets_unlinked = excluded.assets_unlinked, assets_resumable = excluded.assets_resumable,
          source_copy = excluded.source_copy, source_decode = excluded.source_decode, source_render = excluded.source_render,
          assets_pending = excluded.assets_pending,
          folder_bytes = ${folderBytes === null ? tx`document_extraction_levels.folder_bytes` : tx`excluded.folder_bytes`},
          asset_bytes = excluded.asset_bytes, gaps = excluded.gaps, shards = excluded.shards, assets_current = true, updated_at = now()
      where document_extraction_levels.org_id = excluded.org_id and document_extraction_levels.project_id = excluded.project_id
      returning 1`;
    if (leveled.length !== 1) throw new DocumentAssetLedgerError("write-mismatch");
    // Billed bytes: stored figure files of this run plus the folder's own files.
    await tx`update document_extraction_levels set asset_bytes = ${totals!.bytes}::bigint + folder_bytes
      where document_id = ${documentId} and org_id = ${orgId} and project_id = ${projectId}`;
    if (!resuming && write.level.markdownComplete) await queueOldFigureFolders(tx, write.scope, oldFolders);
    return { upserted, removed, resumes };
  });
}

// ---- Building a write from the figure step ----

export interface FigureStepOutcome {
  /** extracted (exit 0), partial (exit 5 with a kept folder), failed (no folder to trust, or it was refused). */
  status: "extracted" | "partial" | "failed";
  exitCode?: number;
  build?: string;
  gaps?: readonly DopplerFigureGap[];
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
  shards?: readonly LedgerShard[];
  resume?: boolean | { first: number; last: number };
  /** The level only, never a row (DocumentAssetLedgerWrite.levelOnly). */
  levelOnly?: boolean;
}

/** The ledger write for a stored figure set: every image, streamed back from the reader's spill. */
export function ledgerWriteForStoredFigures(args: {
  set: Pick<DopplerFigureSet, "version" | "complete" | "ledger" | "run" | "manifests">;
  /** What the store wrote: the single manifest's key and SHA-256 (null for shards), and every manifest's key. */
  stored: { manifest: { key: string; sha256: string } | null; manifests: ReadonlyArray<{ key: string; sha256: string; range: [number, number] | null }>; folderBytes?: number };
  outcome: FigureStepOutcome;
}): PendingAssetLedgerWrite {
  const shards: LedgerShard[] = [];
  for (const manifest of args.set.manifests) {
    if (!manifest.range || !manifest.run) continue;
    const stored = args.stored.manifests.find((m) => m.range && m.range[0] === manifest.range![0] && m.range[1] === manifest.range![1])!;
    shards.push({
      first: manifest.range[0], last: manifest.range[1], manifestKey: stored.key, manifestSha256: manifest.sha256,
      sourceSha256: manifest.run.sourceSha256!, settingsSha256: manifest.run.settingsSha256!,
      imagesStatus: manifest.complete ? "complete" : manifest.resumable > 0 ? "resumable" : "partial",
      assetsResumable: manifest.resumable, lastCutPage: manifest.run.lastCutPage, deadlineMs: manifest.run.deadlineMs,
    });
  }
  return {
    level: {
      imagesStatus: imagesStatusOf(args.set), imagesExitCode: args.outcome.exitCode ?? null, manifestVersion: args.set.version,
      dopplerBuild: args.outcome.build ?? null, run: args.set.run, manifest: args.stored.manifest, gaps: args.outcome.gaps ?? null,
      ...(args.stored.folderBytes !== undefined ? { folderBytes: args.stored.folderBytes } : {}),
    },
    assets: { spill: args.set.ledger.spill, rows: args.set.ledger.rows },
    ...(shards.length > 0 ? { shards } : {}),
  };
}

/** Remove a pending write's spill (written, dropped or replaced). */
export async function disposePendingAssetLedger(write: PendingAssetLedgerWrite | undefined): Promise<void> {
  if (write && !Array.isArray(write.assets)) {
    await rm(path.dirname((write.assets as { spill: string }).spill), { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The ledger write for a figure step that stored nothing new: images failed. Level only (owner rule): rows an attempt of
 * this run already stored are kept, and the status follows them (writeFigureLevel); nothing is deleted.
 */
export function ledgerWriteForFailedFigures(args: { outcome: Omit<FigureStepOutcome, "status"> }): PendingAssetLedgerWrite {
  return {
    level: {
      imagesStatus: "failed", imagesExitCode: args.outcome.exitCode ?? null, manifestVersion: null, dopplerBuild: args.outcome.build ?? null,
      run: null, manifest: null, gaps: args.outcome.gaps ?? null,
    },
    assets: [],
    levelOnly: true,
  };
}

/**
 * The level for committed Markdown whose figure step did not run: `disabled` (figures off for the run) or `none` (another
 * extractor won, the document is not a PDF, or no VM). Level only: the document leaves the resume queue (MEDIUM-3: the
 * level is this run's, with no rows of this run), while rows an earlier run stored stay as unserved, unbilled evidence
 * until the orphan GC or the run's purge (only rows of the level's run are served, counted and billed).
 */
export function ledgerWriteForNoFigures(status: "none" | "disabled"): PendingAssetLedgerWrite {
  return { level: { imagesStatus: status, imagesExitCode: null, manifestVersion: null, dopplerBuild: null, run: null, manifest: null }, assets: [], levelOnly: true };
}

// ---- Reading: the resume queue ----

export interface ResumableDocument {
  documentId: string;
  projectId: string;
  runId: string | null;
  /** For a sharded document, the shard to resume (its own manifest and page range); null for a single manifest. */
  shard: { first: number; last: number } | null;
  sourceSha256: string | null;
  settingsSha256: string | null;
  /** The stored manifest's SHA-256: what downloadDopplerImagesDir checks before it rebuilds the DIR. */
  manifestSha256: string | null;
  /** A gap (`shard` is its range): no manifest at all; resumed by a fresh pass over its pages. */
  gap: boolean;
  resumes: number;
  assetsResumable: number;
  lastCutPage: number | null;
  updatedAt: string;
}

/**
 * Whether Doppler left this image's page to the host's page image: a scan `--scan-pages copy` could not copy (unlinked,
 * `scan-not-copyable`), or a page scan whose copy failed its checks (not extracted, `copy`, e.g. `error: xref`), so the
 * Markdown has no file for it. render-images renders those pages when the project keeps page images.
 */
export function assetNeedsHostPageImage(row: { status: string; reason: string | null; fate: string }): boolean {
  return (row.status === "unlinked" && row.reason === "scan-not-copyable")
    || (row.status === "not-extracted" && row.reason === "copy" && row.fate === "page-scan");
}

/** Pages of one document whose image Doppler left to the host (assetNeedsHostPageImage), from the pending write's rows. */
export async function hostPageImagePagesOf(assets: LedgerAssets): Promise<number[]> {
  const pages = new Set<number>();
  const rows: AsyncIterable<DocumentAsset> | Iterable<DocumentAsset> = Array.isArray(assets) ? assets as readonly DocumentAsset[]
    : readLedgerSpill((assets as { spill: string }).spill);
  for await (const row of rows) if (assetNeedsHostPageImage(row)) pages.add(row.pageNumber);
  return [...pages].sort((a, b) => a - b);
}

/**
 * The same pages from the stored ledger: read-only, one document, scoped to its organization (a document id alone never
 * selects rows). Ascending, distinct.
 */
export async function listHostPageImagePages(sql: Sql<Record<string, unknown>>, scope: { orgId: string; documentId: string }): Promise<number[]> {
  if (typeof scope.orgId !== "string" || !ID.test(scope.orgId) || typeof scope.documentId !== "string" || !ID.test(scope.documentId)) {
    throw new DocumentAssetLedgerError("invalid-scope");
  }
  // Only the current level's run: rows of earlier runs (kept until a newer full write or retention removes them) and of a
  // level that is no longer current never decide this run's page images.
  const rows = await sql<Array<{ page_number: number }>>`
    select distinct a.page_number from document_assets a
    join document_extraction_levels l on l.document_id = a.document_id and l.org_id = a.org_id and l.run_id = a.run_id and l.assets_current
    where a.org_id = ${scope.orgId} and a.document_id = ${scope.documentId}
      and ((a.status = 'unlinked' and a.reason = 'scan-not-copyable')
        or (a.status = 'not-extracted' and a.reason = 'copy' and a.fate = 'page-scan'))
    order by a.page_number`;
  return rows.map((row) => row.page_number);
}

/**
 * Resumable work of one organization (optionally one project), oldest first, with a keyset cursor: a document with a
 * single manifest whose `images_status` is `resumable`, or one shard of a sharded document whose shard is resumable (a
 * resume runs per shard, with that shard's manifest and range). Only live documents, with a stored manifest, and below
 * the host's resume cap (a manifest that never finishes is dropped after DOCUMENT_ASSET_RESUME_CAP resumes, whatever it
 * reports). For a later resume worker; nothing here resumes anything.
 */
export async function listResumableDocuments(
  sql: Sql<Record<string, unknown>>,
  args: { orgId: string; projectId?: string; limit?: number; after?: { updatedAt: string; documentId: string; firstPage?: number } },
): Promise<ResumableDocument[]> {
  if (typeof args.orgId !== "string" || !ID.test(args.orgId) || (args.projectId !== undefined && (typeof args.projectId !== "string" || !ID.test(args.projectId)))) {
    throw new DocumentAssetLedgerError("invalid-scope");
  }
  const limit = Math.min(Math.max(Math.floor(args.limit ?? 100) || 100, 1), 1000);
  const project = (alias: string) => args.projectId === undefined ? sql`` : sql`and ${sql(alias)}.project_id = ${args.projectId}`;
  const rows = await sql<Array<{
    document_id: string; project_id: string; run_id: string | null; first_page: number; last_page: number | null; source_sha256: string | null;
    settings_sha256: string | null; manifest_sha256: string | null; resumes: number; assets_resumable: number; last_cut_page: number | null;
    updated_at: string; at: string;
  }>>`
    select work.*, to_char(work.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at from (
      select l.document_id, l.project_id, l.run_id, 0 as first_page, null::int as last_page, l.source_sha256, l.settings_sha256,
        l.manifest_sha256, l.resumes, l.assets_resumable, l.last_cut_page, l.updated_at as at
      from document_extraction_levels l
      join documents d on d.id = l.document_id and d.org_id = l.org_id and d.project_id = l.project_id
      join projects p on p.id = l.project_id and p.org_id = l.org_id and ${figuresOnSql(sql, "p")}
      -- The run's own pipeline too (#363 H2): a run that opted out of figures is never resumed.
      left join project_runs rp on rp.id = l.run_id and rp.org_id = l.org_id
      where (rp.id is null or ${figuresOnSql(sql, "rp")}) and l.org_id = ${args.orgId} and l.images_status = 'resumable' and l.shards = 0 and (l.assets_resumable > 0 or l.assets_pending > 0) and l.resumes < ${DOCUMENT_ASSET_RESUME_CAP}
        and l.manifest_key is not null ${project("l")}
        and d.superseded_at is null and d.archived_at is null and d.purged_at is null
      union all
      select s.document_id, s.project_id, s.run_id, s.first_page, s.last_page, s.source_sha256, s.settings_sha256, s.manifest_sha256,
        s.resumes, s.assets_resumable, s.last_cut_page, s.updated_at as at
      from document_extraction_shards s
      join documents d on d.id = s.document_id and d.org_id = s.org_id and d.project_id = s.project_id
      -- Only shards of the current level (MEDIUM-3: a re-run without the figure step takes the document off the queue).
      join projects ps on ps.id = s.project_id and ps.org_id = s.org_id and ${figuresOnSql(sql, "ps")}
      left join project_runs rs on rs.id = s.run_id and rs.org_id = s.org_id
      join document_extraction_levels lv on lv.document_id = s.document_id and lv.org_id = s.org_id and lv.assets_current
        and lv.images_status = 'resumable' and lv.run_id is not distinct from s.run_id
      where (rs.id is null or ${figuresOnSql(sql, "rs")}) and s.org_id = ${args.orgId} and s.images_status = 'resumable' and s.resumes < ${DOCUMENT_ASSET_RESUME_CAP} ${project("s")}
        and d.superseded_at is null and d.archived_at is null and d.purged_at is null
        -- The document's resumes across all its shards stay under min(3 x shards, 12) (documentResumeTotalCap).
        and (select coalesce(sum(t.resumes), 0) from document_extraction_shards t
             where t.document_id = s.document_id and t.org_id = s.org_id and t.project_id = s.project_id)
          < least(${DOCUMENT_ASSET_RESUME_CAP}::int * (select count(*) from document_extraction_shards t
             where t.document_id = s.document_id and t.org_id = s.org_id and t.project_id = s.project_id), ${DOCUMENT_ASSET_RESUME_TOTAL_CAP}::int)
      union all
      -- Gaps: page ranges with no manifest at all (a failed or over-share shard, the document's pass budget). Each is resumed
      -- by a fresh pass over its pages, which becomes that range's shard.
      select g.document_id, g.project_id, g.run_id, g.first_page, g.last_page, g.source_sha256, g.settings_sha256, null as manifest_sha256,
        g.resumes, 0 as assets_resumable, null::int as last_cut_page, g.at
      from (
        select l.document_id, l.project_id, l.run_id, (gap ->> 'first')::int as first_page, (gap ->> 'last')::int as last_page, l.source_sha256,
          l.settings_sha256, l.resumes, l.updated_at as at, l.org_id
        from document_extraction_levels l
        cross join lateral jsonb_array_elements(coalesce(l.gaps, '[]'::jsonb)) gap
        join documents d on d.id = l.document_id and d.org_id = l.org_id and d.project_id = l.project_id
        join projects pg on pg.id = l.project_id and pg.org_id = l.org_id and ${figuresOnSql(sql, "pg")}
        left join project_runs rg on rg.id = l.run_id and rg.org_id = l.org_id
        where (rg.id is null or ${figuresOnSql(sql, "rg")}) and l.org_id = ${args.orgId} and l.images_status = 'resumable' and l.assets_current and l.resumes < ${DOCUMENT_ASSET_RESUME_CAP} ${project("l")}
          and d.superseded_at is null and d.archived_at is null and d.purged_at is null
          -- Only effective gaps: a gap a shard now covers is that shard's work (no duplicate unit).
          and not exists (select 1 from document_extraction_shards sc where sc.document_id = l.document_id and sc.org_id = l.org_id
            and sc.images_status = 'complete' and sc.first_page <= (gap ->> 'last')::int and (gap ->> 'first')::int <= sc.last_page)
          -- And the document's shard-resume total (documentResumeTotalCap) is not yet spent.
          and (select coalesce(sum(t.resumes), 0) from document_extraction_shards t
               where t.document_id = l.document_id and t.org_id = l.org_id and t.project_id = l.project_id)
            < least(${DOCUMENT_ASSET_RESUME_CAP}::int * greatest(1, (select count(*) from document_extraction_shards t
               where t.document_id = l.document_id and t.org_id = l.org_id and t.project_id = l.project_id))::int, ${DOCUMENT_ASSET_RESUME_TOTAL_CAP}::int)
      ) g
    ) work
    ${args.after ? sql`where (work.at, work.document_id, work.first_page) > (${args.after.updatedAt}::timestamptz, ${args.after.documentId}, ${args.after.firstPage ?? 0})` : sql``}
    order by work.at, work.document_id, work.first_page
    limit ${limit}`;
  return rows.map((row) => ({
    documentId: row.document_id, projectId: row.project_id, runId: row.run_id,
    shard: row.last_page === null ? null : { first: row.first_page, last: row.last_page },
    sourceSha256: row.source_sha256, settingsSha256: row.settings_sha256, manifestSha256: row.manifest_sha256,
    gap: row.last_page !== null && row.manifest_sha256 === null, resumes: row.resumes,
    assetsResumable: row.assets_resumable, lastCutPage: row.last_cut_page, updatedAt: row.updated_at,
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
      ...(entry.shards ? { shards: entry.shards } : {}),
      ...(entry.resume ? { resume: entry.resume } : {}),
      ...(entry.levelOnly ? { levelOnly: true } : {}),
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

// ---- Figures kept on every failure path: pending and stored rows, adopt, level-only writes (migration 0153) ----

type Tx = import("postgres").TransactionSql<Record<string, unknown>>;

/**
 * Inside a transaction: serialize writers of one document, check the scope against the document (else `scope-mismatch`)
 * and the run against the document's current run, not older than the level's writer (else `stale-write`, the same rule as
 * writeDocumentAssetLedger). Returns the document's artifact root.
 */
async function lockAndCheck(tx: Tx, scope: DocumentAssetLedgerScope): Promise<{ root: string; level: { run_id: string | null } | undefined }> {
  const { orgId, projectId, documentId, runId } = scope;
  await tx`select pg_advisory_xact_lock(hashtext(${`document-assets:${documentId}`}))`;
  const [document] = await tx<{ user_id: string; run_id: string | null }[]>`
    select user_id, run_id from documents where id = ${documentId} and org_id = ${orgId} and project_id = ${projectId} for key share`;
  if (!document) throw new DocumentAssetLedgerError("scope-mismatch");
  const [run] = await tx<{ storage_prefix: string | null }[]>`
    select storage_prefix from project_runs where id = ${runId} and org_id = ${orgId} and project_id = ${projectId}`;
  if (!run) throw new DocumentAssetLedgerError("scope-mismatch");
  if (document.run_id !== runId) throw new DocumentAssetLedgerError("stale-write");
  const [level] = await tx<{ run_id: string | null; newer: boolean }[]>`
    select l.run_id, coalesce(l.run_id <> ${runId} and r.created_at > (select created_at from project_runs where id = ${runId}), false) as newer
    from document_extraction_levels l left join project_runs r on r.id = l.run_id
    where l.document_id = ${documentId} and l.org_id = ${orgId} and l.project_id = ${projectId}`;
  if (level?.newer) throw new DocumentAssetLedgerError("stale-write");
  return { root: run.storage_prefix ?? `${document.user_id}/${runId}`, level };
}

/** A resume batch: an image that already has a stored file must come back with that same file (else `resume-rewrite`). */
async function refuseResumeRewrites(tx: Tx, scope: DocumentAssetLedgerScope, rows: readonly LedgerAsset[]): Promise<void> {
  const stored = await tx<Array<{ asset_id: string; sha256: string | null; format: string | null }>>`
    select asset_id, sha256, format from document_assets
    where org_id = ${scope.orgId} and project_id = ${scope.projectId} and document_id = ${scope.documentId} and storage_state = 'stored'
      and asset_id = any(${tx.array(rows.map((row) => row.assetId))}::text[])`;
  const byId = new Map(stored.map((row) => [row.asset_id, row]));
  for (const row of rows) {
    const old = byId.get(row.assetId);
    if (old && (row.status !== "extracted" || row.sha256 !== old.sha256 || row.format !== old.format)) throw new DocumentAssetLedgerError("resume-rewrite");
  }
}

/**
 * Recount the level from the rows of its run (rows an earlier run left are never counted, served or billed as current)
 * and set its status: resumable while any image a resume would retry remains; otherwise `fallback` when the run has no
 * rows (a skipped or failed figure step), else partial or complete as the rows show.
 */
async function recountLevel(tx: Tx, scope: DocumentAssetLedgerScope, fallback: DocumentImagesStatus | null): Promise<void> {
  const { orgId, projectId, documentId, runId } = scope;
  const [t] = await tx<Array<{ total: number; extracted: number; not_extracted: number; unlinked: number; resumable: number; pending: number; copy: number; decode: number; render: number; bytes: string }>>`
    select count(*)::int as total, count(*) filter (where status = 'extracted')::int as extracted,
      count(*) filter (where status = 'not-extracted')::int as not_extracted, count(*) filter (where status = 'unlinked')::int as unlinked,
      count(*) filter (where resumable)::int as resumable, count(*) filter (where storage_state = 'pending')::int as pending,
      count(*) filter (where source = 'copy')::int as copy, count(*) filter (where source = 'decode')::int as decode,
      count(*) filter (where source = 'render')::int as render,
      coalesce(sum(bytes) filter (where storage_state = 'stored'), 0)::text as bytes
    from document_assets where document_id = ${documentId} and org_id = ${orgId} and project_id = ${projectId} and run_id = ${runId}`;
  // Effective gaps: gaps no shard covers (the one rule, shared with the full write).
  const [gapRow] = await tx<{ n: number }[]>`
    select count(*)::int as n from document_extraction_levels l
    cross join lateral jsonb_array_elements(coalesce(l.gaps, '[]'::jsonb)) gap
    where l.document_id = ${documentId} and l.org_id = ${orgId}
      and not exists (select 1 from document_extraction_shards s where s.document_id = l.document_id and s.org_id = l.org_id
        and s.images_status = 'complete' and s.first_page <= (gap ->> 'last')::int and (gap ->> 'first')::int <= s.last_page)`;
  const work = t!.resumable > 0 || t!.pending > 0 || (gapRow?.n ?? 0) > 0;
  const status: DocumentImagesStatus = work ? "resumable"
    : t!.total === 0 ? (fallback ?? "none")
    : fallback === "complete" ? "complete" : "partial";
  await tx`
    update document_extraction_levels set run_id = ${runId}, images_status = ${status}, assets_current = true,
      assets_total = ${t!.total}, assets_extracted = ${t!.extracted}, assets_not_extracted = ${t!.not_extracted},
      assets_unlinked = ${t!.unlinked}, assets_resumable = ${t!.resumable}, assets_pending = ${t!.pending}, source_copy = ${t!.copy},
      source_decode = ${t!.decode}, source_render = ${t!.render}, asset_bytes = ${t!.bytes}::bigint + folder_bytes, updated_at = now()
    where document_id = ${documentId} and org_id = ${orgId} and project_id = ${projectId}`;
}

/**
 * The level only (the failed-figures and no-figures writes, and the level a delivery keeps before the Markdown commits):
 * never touches or deletes a row. The level becomes this run's: a re-run that skipped the figure step takes the document
 * off the resume queue (`none`/`disabled`, MEDIUM-3), and figures this run already stored keep an honest status.
 */
export async function writeFigureLevel(
  sql: Sql<Record<string, unknown>>,
  args: { scope: DocumentAssetLedgerScope; markdownComplete: boolean; imagesStatus: DocumentImagesStatus; exitCode?: number | null; build?: string | null; gaps?: readonly DopplerFigureGap[] | null },
): Promise<void> {
  assertScope(args.scope);
  const exitCode = args.exitCode ?? null;
  const build = args.build ?? null;
  if (!DOCUMENT_IMAGES_STATUSES.includes(args.imagesStatus) || (exitCode !== null && !(Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255)) ||
      (build !== null && !DOPPLER_BUILD.test(build)) || (args.gaps != null && (!Array.isArray(args.gaps) || args.gaps.length > DOPPLER_FIGURE_GAPS_MAX))) {
    throw new DocumentAssetLedgerError("invalid-level");
  }
  const gaps = args.gaps && args.gaps.length > 0 ? args.gaps.map((gap) => ({ first: gap.first, last: gap.last, reason: (DOPPLER_FIGURE_GAP_REASONS as readonly string[]).includes(gap.reason) ? gap.reason : "other" })) : null;
  const { orgId, projectId, documentId, runId } = args.scope;
  await sql.begin(async (tx) => {
    await lockAndCheck(tx, args.scope);
    if (args.imagesStatus === "none" || args.imagesStatus === "disabled") {
      // The figure step did not run: off the resume queue (no gaps, no counts), and no row is current (none deleted). A
      // document that never stored a figure has nothing to hide: its level stays current, so only real figure documents
      // are non-current (the audit's retention set, R2-M1).
      const [held] = await tx<{ any: boolean }[]>`
        select exists (select 1 from document_assets where document_id = ${documentId} and org_id = ${orgId} and storage_key is not null) as any`;
      const current = !held?.any;
      const leveled = await tx`
        insert into document_extraction_levels (document_id, org_id, project_id, run_id, markdown_complete, images_status, images_exit_code,
          doppler_build, assets_current)
        values (${documentId}, ${orgId}, ${projectId}, ${runId}, ${args.markdownComplete}, ${args.imagesStatus}, ${exitCode}, ${build}, ${current})
        on conflict (document_id) do update
        set run_id = excluded.run_id, markdown_complete = excluded.markdown_complete, images_status = excluded.images_status,
            images_exit_code = excluded.images_exit_code, doppler_build = excluded.doppler_build, assets_current = excluded.assets_current, gaps = null,
            assets_total = 0, assets_extracted = 0, assets_not_extracted = 0, assets_unlinked = 0, assets_resumable = 0, assets_pending = 0,
            source_copy = 0, source_decode = 0, source_render = 0, asset_bytes = 0, folder_bytes = 0, updated_at = now()
        where document_extraction_levels.org_id = excluded.org_id and document_extraction_levels.project_id = excluded.project_id
        returning 1`;
      if (leveled.length !== 1) throw new DocumentAssetLedgerError("write-mismatch");
      return;
    }
    const leveled = await tx`
      insert into document_extraction_levels (document_id, org_id, project_id, run_id, markdown_complete, images_status, images_exit_code, doppler_build, gaps)
      values (${documentId}, ${orgId}, ${projectId}, ${runId}, ${args.markdownComplete}, 'none', ${exitCode}, ${build},
        ${gaps ? tx.json(gaps as unknown as JSONValue) : null})
      on conflict (document_id) do update
      set run_id = excluded.run_id, markdown_complete = excluded.markdown_complete, images_exit_code = excluded.images_exit_code,
          doppler_build = excluded.doppler_build, gaps = excluded.gaps,
          -- Another run's folder files are not this run's.
          folder_bytes = case when document_extraction_levels.run_id is distinct from excluded.run_id then 0 else document_extraction_levels.folder_bytes end,
          updated_at = now()
      where document_extraction_levels.org_id = excluded.org_id and document_extraction_levels.project_id = excluded.project_id
      returning 1`;
    if (leveled.length !== 1) throw new DocumentAssetLedgerError("write-mismatch");
    await recountLevel(tx, args.scope, args.imagesStatus === "resumable" ? "partial" : args.imagesStatus);
  });
}

/**
 * Before their uploads: record the files about to be uploaded as `pending` rows with their exact keys (derived from the
 * run's artifact root, the document and the id), so a crash between upload and commit leaves rows the next attempt can
 * adopt and the orphan GC knows were meant. Only extracted rows. A stored row is never downgraded. Pending rows are
 * neither served nor billed.
 */
export async function markAssetsPending(
  sql: Sql<Record<string, unknown>>,
  args: { scope: DocumentAssetLedgerScope; rows: ReadonlyArray<DocumentAsset & { storageKey?: string | null }> },
): Promise<{ pending: number }> {
  assertScope(args.scope);
  if (args.rows.length > DOPPLER_MANIFEST_V2_LIMITS.maxEntries) throw new DocumentAssetLedgerError("invalid-assets");
  const rows = args.rows.map((row) => {
    const { storageKey, ...rest } = row;
    const checked = checkedRow(rest as DocumentAsset, true);
    if (checked.status !== "extracted") throw new DocumentAssetLedgerError("invalid-assets");
    checked.storageKey = typeof storageKey === "string" ? storageKey : null;
    return checked;
  });
  if (rows.length === 0) return { pending: 0 };
  const { orgId, projectId, documentId, runId } = args.scope;
  return await sql.begin(async (tx) => {
    const { root } = await lockAndCheck(tx, args.scope);
    for (const row of rows) {
      let key: string;
      try { key = dopplerAssetStorageKey(root, documentId, row.assetId, row.format!); } catch { throw new DocumentAssetLedgerError("invalid-assets"); }
      if (row.storageKey !== null && row.storageKey !== key) throw new DocumentAssetLedgerError("key-mismatch");
      row.storageKey = key;
    }
    const payload = rows.map((row) => ({ ...assetPayload(row), storage_state: "pending" }));
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
        and not (document_assets.storage_state = 'stored' and document_assets.sha256 = excluded.sha256 and document_assets.run_id = excluded.run_id)
        -- A row still current and stored under an earlier run stays until this run's full write commits (a failed run
        -- must not orphan the figures the document serves); the upload is then recorded by that write.
        and not (document_assets.storage_state = 'stored' and document_assets.run_id is distinct from excluded.run_id)
      returning 1`;
    return { pending: written.length };
  });
}

/**
 * After uploads landed and checked out: flip their pending rows to `stored` (only rows still pending with exactly the key
 * that was uploaded), and keep the level honest before any Markdown commits: this run's, `markdown_complete = false` when
 * the level was another run's, counts and bytes from this run's rows. Called every upload step.
 */
export async function markAssetsStored(
  sql: Sql<Record<string, unknown>>,
  args: { scope: DocumentAssetLedgerScope; files: ReadonlyArray<{ id: string; key: string }> },
): Promise<{ stored: number }> {
  assertScope(args.scope);
  if (args.files.length === 0) return { stored: 0 };
  if (args.files.length > DOPPLER_MANIFEST_V2_LIMITS.maxEntries) throw new DocumentAssetLedgerError("invalid-assets");
  const { orgId, projectId, documentId, runId } = args.scope;
  return await sql.begin(async (tx) => {
    await lockAndCheck(tx, args.scope);
    const flipped = await tx`
      update document_assets a set storage_state = 'stored', updated_at = now()
      from unnest(${tx.array(args.files.map((file) => file.id))}::text[], ${tx.array(args.files.map((file) => file.key))}::text[]) as f(id, key)
      where a.org_id = ${orgId} and a.project_id = ${projectId} and a.document_id = ${documentId} and a.run_id = ${runId}
        and a.asset_id = f.id and a.storage_key = f.key and a.storage_state = 'pending'
      returning 1`;
    await tx`
      insert into document_extraction_levels (document_id, org_id, project_id, run_id, markdown_complete, images_status)
      values (${documentId}, ${orgId}, ${projectId}, ${runId}, false, 'none')
      on conflict (document_id) do update
      set markdown_complete = case when document_extraction_levels.run_id is distinct from excluded.run_id then false
            else document_extraction_levels.markdown_complete end,
          -- A new run's level starts clean: the earlier run's gaps and folder files are not this run's.
          gaps = case when document_extraction_levels.run_id is distinct from excluded.run_id then null else document_extraction_levels.gaps end,
          folder_bytes = case when document_extraction_levels.run_id is distinct from excluded.run_id then 0 else document_extraction_levels.folder_bytes end,
          run_id = excluded.run_id, updated_at = now()
      where document_extraction_levels.org_id = excluded.org_id and document_extraction_levels.project_id = excluded.project_id`;
    await recountLevel(tx, args.scope, "partial");
    return { stored: flipped.length };
  });
}

/** Reads a stored object as a stream (the worker's ArtifactStore.openStream); a missing object throws a not-found error. */
export interface FigureObjectReader {
  openStream(key: string, signal?: AbortSignal): Promise<{ stream: AsyncIterable<Uint8Array>; size: number | null }>;
}

export function isMissingObject(error: unknown): boolean {
  const e = error as { name?: unknown; Code?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown }; cause?: unknown } | null;
  if (!e) return false;
  if (e.name === "NoSuchKey" || e.name === "NotFound" || e.Code === "NoSuchKey" || e.code === "ENOENT" || e.$metadata?.httpStatusCode === 404) return true;
  return e.cause !== undefined && e.cause !== error && isMissingObject(e.cause);
}

/** Size and SHA-256 of an object, streamed (never held whole); null when it does not exist. Stops past `limit` bytes. */
export async function objectDigest(reader: FigureObjectReader, key: string, limit: number, signal?: AbortSignal): Promise<{ size: number; sha256: string } | null> {
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
 * The adopt pass (no VM boot): every pending row of the document's current run is checked against storage by its exact
 * key. An object of exactly the row's size and SHA-256 is adopted (`stored`); a missing one, or one of other bytes, turns
 * the image back into a resumable `aborted` one (its repeats lose their file link). A storage error other than not-found
 * leaves the row pending for a later attempt. One transaction at the end; the level is recounted. Nothing is deleted.
 */
export async function adoptPendingAssets(
  sql: Sql<Record<string, unknown>>,
  reader: FigureObjectReader,
  args: { scope: DocumentAssetLedgerScope; signal?: AbortSignal },
): Promise<AdoptResult> {
  assertScope(args.scope);
  const { orgId, projectId, documentId, runId } = args.scope;
  const pending = await sql<Array<{ asset_id: string; storage_key: string; bytes: number; sha256: string }>>`
    select asset_id, storage_key, bytes, sha256 from document_assets
    where org_id = ${orgId} and project_id = ${projectId} and document_id = ${documentId} and run_id = ${runId} and storage_state = 'pending'
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
    const { root } = await lockAndCheck(tx, args.scope);
    // Defense in depth: a key that is not exactly the one derived for its row is never adopted.
    const rows = await tx<Array<{ asset_id: string; storage_key: string; format: string }>>`
      select asset_id, storage_key, format from document_assets
      where org_id = ${orgId} and project_id = ${projectId} and document_id = ${documentId} and run_id = ${runId} and storage_state = 'pending'
        and asset_id = any(${tx.array(adopt.map((file) => file.id))}::text[])`;
    const derived = new Set(rows.filter((row) => {
      try { return dopplerAssetStorageKey(root, documentId, row.asset_id, row.format as never) === row.storage_key; } catch { return false; }
    }).map((row) => row.asset_id));
    const adoptable = adopt.filter((file) => derived.has(file.id));
    for (const file of adopt) if (!derived.has(file.id)) lost.push(file.id);
    const flipped = await tx`
      update document_assets a set storage_state = 'stored', updated_at = now()
      from unnest(${tx.array(adoptable.map((file) => file.id))}::text[], ${tx.array(adoptable.map((file) => file.key))}::text[]) as f(id, key)
      where a.org_id = ${orgId} and a.project_id = ${projectId} and a.document_id = ${documentId} and a.run_id = ${runId}
        and a.asset_id = f.id and a.storage_key = f.key and a.storage_state = 'pending'
      returning 1`;
    const reverted = await revertToResumable(tx, args.scope, lost);
    const [level] = await tx<{ n: number }[]>`select count(*)::int as n from document_extraction_levels where document_id = ${documentId} and org_id = ${orgId}`;
    if ((level?.n ?? 0) > 0) await recountLevel(tx, args.scope, "partial");
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
 * The audit's verdict on stored rows of the current run: images whose object is missing or of the wrong size become
 * resumable `aborted` images (the audit then queues a resume); the level is recounted.
 */
export async function markAssetsLost(
  sql: Sql<Record<string, unknown>>,
  args: { scope: DocumentAssetLedgerScope; ids: readonly string[] },
): Promise<{ lost: number }> {
  assertScope(args.scope);
  if (args.ids.length === 0) return { lost: 0 };
  return await sql.begin(async (tx) => {
    await lockAndCheck(tx, args.scope);
    const lost = await revertToResumable(tx, args.scope, args.ids);
    await recountLevel(tx, args.scope, "partial");
    return { lost };
  });
}

/**
 * The ledger beside a figure upload: pending rows before each upload step and stored after it, through the run's store
 * under the run's organization and project, so figures are kept whatever later fails (the Markdown, a later stage, the run,
 * the worker). The checkpoint's write then completes the level. None without a store that has them, or for a run without
 * a scope (the checkpoint's write is then the only record).
 */
export function figureLedgerHooks(
  state: {
    store?: {
      markAssetsPending?(args: Parameters<typeof markAssetsPending>[1]): Promise<unknown>;
      markAssetsStored?(args: Parameters<typeof markAssetsStored>[1]): Promise<unknown>;
      replaceUnvouchedObject?(args: Parameters<typeof replaceUnvouchedObject>[1]): Promise<void>;
    };
    run: { id: string; orgId: string | null; projectId?: string | null };
  },
  documentId: string,
): DopplerFigureLedgerHooks | undefined {
  const store = state.store;
  if (!store?.markAssetsPending || !store.markAssetsStored || !state.run.orgId || !state.run.projectId) return undefined;
  const scope = { orgId: state.run.orgId, projectId: state.run.projectId, documentId, runId: state.run.id };
  return {
    pending: async (rows) => { await store.markAssetsPending!({ scope, rows }); },
    stored: async (files) => { await store.markAssetsStored!({ scope, files }); },
    ...(store.replaceUnvouchedObject ? { replace: figureRepairHook(store.replaceUnvouchedObject.bind(store), scope) } : {}),
  };
}

/**
 * SQL: the project's figures are on (`pipeline.figures`, default on): figuresEnabled (#363) without the deploy flag. Fails
 * closed on malformed shapes too (`"off"`, `{ enabled: false }`), so discovery never lists more than figuresEnabled runs.
 */
export function figuresOnSql(sql: Sql<Record<string, unknown>>, projectAlias: string /* a projects or project_runs row: both carry `pipeline` */) {
  const p = sql(projectAlias);
  return sql`(coalesce(${p}.pipeline -> 'figures', 'true'::jsonb) not in ('false'::jsonb, '"off"'::jsonb)
    and coalesce(${p}.pipeline -> 'figures' ->> 'enabled', 'true') <> 'false')`;
}

/**
 * Repair under the document's ledger lock: `replace` (delete, then create) runs only when no stored row vouches for `key`;
 * otherwise `object-conflict`. Held across the delete and the create, so no writer can vouch for the key in between.
 */
export async function replaceUnvouchedObject(
  sql: Sql<Record<string, unknown>>,
  args: { scope: DocumentAssetLedgerScope; key: string; replace: () => Promise<void> },
): Promise<void> {
  assertScope(args.scope);
  const { orgId, projectId, documentId } = args.scope;
  await sql.begin(async (tx) => {
    const { root } = await lockAndCheck(tx, args.scope);
    if (!args.key.startsWith(`${dopplerDocumentPrefix(root, documentId)}${DOPPLER_STORE_LAYOUT.imagesFolder}`) || args.key.includes("..")) {
      throw new DocumentAssetLedgerError("key-mismatch");
    }
    const [vouched] = await tx<{ n: number }[]>`
      select count(*)::int as n from document_assets
      where document_id = ${documentId} and org_id = ${orgId} and project_id = ${projectId} and storage_key = ${args.key} and storage_state = 'stored'`;
    if ((vouched?.n ?? 0) > 0) throw new DopplerFigureConflict();
    await args.replace();
  });
}

/** An object with other bytes at a key a stored row still vouches for: never replaced. */
export class DopplerFigureConflict extends Error {
  readonly rule = "object-conflict";
  constructor() { super("Doppler figures rejected: object-conflict"); this.name = "DopplerFigureRejection"; }
}

/**
 * Once a fresh full write of `scope.runId` commits the document's figures (its Markdown is committed), the figure folders
 * of the document's earlier runs are queued for purge (kind `doppler_folder`). Never on a resume, a pending write or a
 * failed run: those leave the earlier folders as they are. The drainer re-checks that no row vouches for the folder and
 * that it is not the current run's.
 */
async function oldFigureFolders(tx: Tx, scope: DocumentAssetLedgerScope, root: string): Promise<string[]> {
  const current = dopplerDocumentPrefix(root, scope.documentId);
  const rows = await tx<{ folder: string | null }[]>`
    select distinct substring(storage_key from ${`^(.*/doppler/${scope.documentId}/)`}) as folder from document_assets
    where document_id = ${scope.documentId} and org_id = ${scope.orgId} and storage_key is not null and run_id is distinct from ${scope.runId}
    union
    select coalesce(r.storage_prefix, d.user_id || '/' || r.id) || '/doppler/' || ${scope.documentId} || '/' as folder
    from document_extraction_levels l
    join project_runs r on r.id = l.run_id and r.org_id = l.org_id
    join documents d on d.id = l.document_id
    where l.document_id = ${scope.documentId} and l.org_id = ${scope.orgId} and l.run_id is distinct from ${scope.runId}`;
  return rows.map((row) => row.folder).filter((folder): folder is string => !!folder && folder !== current && !folder.includes(".."));
}

async function queueOldFigureFolders(tx: Tx, scope: DocumentAssetLedgerScope, folders: readonly string[]): Promise<void> {
  for (const folder of folders) {
    await tx`
      insert into storage_cleanup_queue (kind, org_id, target, payload, reason, not_before)
      select 'doppler_folder', ${scope.orgId}, ${folder}, ${tx.json({ documentId: scope.documentId, projectId: scope.projectId, runId: scope.runId })},
        'figures moved to a newer run', now() + interval '1 hour'
      where not exists (select 1 from storage_cleanup_queue where kind = 'doppler_folder' and target = ${folder})`;
  }
}

/** The ledger's repair hook for figureLedgerHooks (DopplerFigureLedgerHooks.replace). */
export function figureRepairHook(
  replace: (args: { scope: DocumentAssetLedgerScope; key: string; replace: () => Promise<void> }) => Promise<void>,
  scope: DocumentAssetLedgerScope,
): DopplerFigureLedgerHooks["replace"] {
  return async (key, run) => { await replace({ scope, key, replace: run }); };
}

/** A non-negative byte count, or `invalid-level`. */
function byteCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new DocumentAssetLedgerError("invalid-level");
  return value;
}

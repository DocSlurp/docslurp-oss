/*
 * Read side of the document asset ledger (migration 0140, docs/extraction/doppler-figures.md "Asset ledger"): a
 * document's images (extracted, not extracted with the reason, unlinked) and its extraction level, for the API and the
 * inspector. Every query is filtered by the caller's organization and project; a document of another scope reads as
 * missing (null), exactly like one that does not exist.
 *
 * Storage keys stay internal: a caller gets each image's artifact slot, which the document detail resolves to a
 * short-lived file URL under the file proxy's own authorization (artifacts scope, project, PII policy).
 */
import { sql } from "../db.js";

export interface DocumentAssetScope {
  orgId: string;
  /** The document's project, when the caller already resolved it (an API key's project check). */
  projectId?: string;
  documentId: string;
}

export interface DocumentAssetView {
  id: string;
  page: number;
  kind: string;
  fate: string;
  status: string;
  reason: string | null;
  resumable: boolean;
  source: string | null;
  format: string | null;
  bytes: number | null;
  sha256: string | null;
  width: number | null;
  height: number | null;
  repeatOf: string | null;
  fallback: string | null;
  /** The link as the stored Markdown holds it (manifest v2), or null. */
  link: string | null;
  /** The image whose file shows this one (itself when it owns one), or null. */
  fileOf: string | null;
  /** The document artifact slot of that file (`<documentId>:doppler-figure:<id>`), or null. */
  slot: string | null;
}

export interface DocumentExtractionLevelView {
  markdownComplete: boolean;
  factsLevel: string;
  imagesStatus: string;
  imagesExitCode: number | null;
  manifestVersion: number | null;
  dopplerBuild: string | null;
  resumes: number;
  lastCutPage: number | null;
  deadlineMs: number | null;
  counts: {
    total: number; extracted: number; notExtracted: number; unlinked: number; resumable: number;
    bySource: { copy: number; decode: number; render: number };
    bytes: number;
  };
  updatedAt: string;
}

export interface DocumentAssetLedgerView {
  documentId: string;
  /** Null when no figure step has recorded anything for the document yet. */
  level: DocumentExtractionLevelView | null;
  assets: DocumentAssetView[];
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * The document's asset map and extraction level, or null when the document is not in this organization (and project).
 * The scope is required: there is no unscoped read.
 */
export async function getDocumentAssetLedger(scope: DocumentAssetScope): Promise<DocumentAssetLedgerView | null> {
  if (!scope || typeof scope.orgId !== "string" || !ID.test(scope.orgId) || typeof scope.documentId !== "string" || !ID.test(scope.documentId) ||
      (scope.projectId !== undefined && (typeof scope.projectId !== "string" || !ID.test(scope.projectId)))) {
    throw new Error("A document asset read needs an organization and a document id");
  }
  const projectFilter = scope.projectId === undefined ? sql`` : sql`and d.project_id = ${scope.projectId}`;
  const [document] = await sql<{ id: string }[]>`
    select d.id from documents d
    where d.id = ${scope.documentId} and d.org_id = ${scope.orgId} ${projectFilter}`;
  if (!document) return null;

  const [level] = await sql<Array<{
    markdown_complete: boolean; facts_level: string; images_status: string; images_exit_code: number | null; manifest_version: number | null;
    doppler_build: string | null; resumes: number; last_cut_page: number | null; deadline_ms: number | null; assets_total: number;
    assets_extracted: number; assets_not_extracted: number; assets_unlinked: number; assets_resumable: number; source_copy: number;
    source_decode: number; source_render: number; asset_bytes: string | number; updated_at: string;
  }>>`
    select markdown_complete, facts_level, images_status, images_exit_code, manifest_version, doppler_build, resumes, last_cut_page,
      deadline_ms, assets_total, assets_extracted, assets_not_extracted, assets_unlinked, assets_resumable, source_copy, source_decode,
      source_render, asset_bytes, updated_at::text
    from document_extraction_levels
    where document_id = ${scope.documentId} and org_id = ${scope.orgId}`;

  const rows = await sql<Array<{
    asset_id: string; page_number: number; kind: string; fate: string; status: string; reason: string | null; resumable: boolean;
    source: string | null; format: string | null; bytes: number | null; sha256: string | null; width: number | null; height: number | null;
    repeat_of: string | null; fallback: string | null; link_path: string | null; file_of: string | null;
  }>>`
    select asset_id, page_number, kind, fate, status, reason, resumable, source, format, bytes, sha256, width, height, repeat_of,
      fallback, link_path, file_of
    from document_assets
    where document_id = ${scope.documentId} and org_id = ${scope.orgId}
    order by page_number, asset_id`;

  return {
    documentId: scope.documentId,
    level: level ? {
      markdownComplete: level.markdown_complete, factsLevel: level.facts_level, imagesStatus: level.images_status,
      imagesExitCode: level.images_exit_code, manifestVersion: level.manifest_version, dopplerBuild: level.doppler_build,
      resumes: level.resumes, lastCutPage: level.last_cut_page, deadlineMs: level.deadline_ms,
      counts: {
        total: level.assets_total, extracted: level.assets_extracted, notExtracted: level.assets_not_extracted, unlinked: level.assets_unlinked,
        resumable: level.assets_resumable, bySource: { copy: level.source_copy, decode: level.source_decode, render: level.source_render },
        bytes: Number(level.asset_bytes),
      },
      updatedAt: level.updated_at,
    } : null,
    assets: rows.map((row) => ({
      id: row.asset_id, page: row.page_number, kind: row.kind, fate: row.fate, status: row.status, reason: row.reason,
      resumable: row.resumable, source: row.source, format: row.format, bytes: row.bytes, sha256: row.sha256, width: row.width,
      height: row.height, repeatOf: row.repeat_of, fallback: row.fallback, link: row.link_path, fileOf: row.file_of,
      slot: row.file_of ? `${scope.documentId}:doppler-figure:${row.file_of}` : null,
    })),
  };
}

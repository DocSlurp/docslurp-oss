/*
 * Read side of the document asset ledger (migration 0141, docs/extraction/doppler-figures.md "Asset ledger"): a
 * document's images (extracted, not extracted with the reason, unlinked) and its extraction level, for the API and the
 * inspector. Every query is filtered by the caller's organization and project; a document of another scope, or one the
 * viewer would not be shown (not `completed`, or purged), reads as missing (null), exactly like one that does not exist.
 *
 * Storage keys stay internal (image files, the stored manifest, the source pointer): a caller gets each image's artifact
 * slot, which the document detail resolves to a short-lived file URL under the file proxy's own authorization (artifacts
 * scope, project, PII policy). An image whose file the project's PII policy withholds keeps its size and hash but has no
 * slot, and says why with a fixed value (`refusal: "pii-policy"`), never error text or document content.
 */
import { parseArtifactUri } from "@docslurp/shared";

import { sql } from "../db.js";
import { withheldArtifactUrisFromMetadata } from "./pii-artifact-guard.js";

export interface DocumentAssetScope {
  orgId: string;
  /** The document's project, when the caller already resolved it (an API key's project check). */
  projectId?: string;
  documentId: string;
}

/** Why an image's file is not served although it exists. A closed enum; never error text. */
export type DocumentAssetRefusal = "pii-policy";

export interface DocumentAssetView {
  id: string;
  page: number;
  kind: string;
  fate: string;
  status: string;
  /** Doppler's own fixed reason for a `not-extracted` image (`min_side`, `repeat`, `budget`, `copy`, ...). */
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
  /** The document artifact slot of that file (`<documentId>:doppler-figure:<id>`), or null (no file, or withheld). */
  slot: string | null;
  /** Why the file exists but is not served (`pii-policy`), or null. */
  refusal: DocumentAssetRefusal | null;
}

export interface DocumentExtractionLevelView {
  markdownComplete: boolean;
  imagesStatus: string;
  imagesExitCode: number | null;
  manifestVersion: number | null;
  /** SHA-256 of the stored manifest bytes, when one is stored (its location stays internal). */
  manifestSha256: string | null;
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
  /** Null when nothing has recorded a level for the document yet. */
  level: DocumentExtractionLevelView | null;
  assets: DocumentAssetView[];
  /** Pass as `after` for the next page; null on the last page. */
  nextCursor: string | null;
}

export interface DocumentAssetPage {
  /** Rows per page, 1..1000 (default 500). */
  limit?: number;
  /** Keyset cursor from a previous page's `nextCursor`. */
  after?: string;
  /** Only images on pages pageFrom..pageTo (inclusive). */
  pageFrom?: number;
  pageTo?: number;
}

export const DOCUMENT_ASSET_PAGE_DEFAULT = 500;
export const DOCUMENT_ASSET_PAGE_MAX = 1000;

/** A request the route answers 400 to, with this fixed message. */
export class DocumentAssetQueryError extends Error {
  constructor() {
    super("Invalid asset page parameters");
    this.name = "DocumentAssetQueryError";
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const ASSET_ID = /^p[1-9][0-9]{0,8}\.g?(?:0|[1-9][0-9]{0,5})$/;
const MAX_PAGE = 1_000_000_000;

/** Opaque keyset cursor: base64url of `<page>:<asset id>`. */
export function encodeAssetCursor(page: number, assetId: string): string {
  return Buffer.from(`${page}:${assetId}`, "utf8").toString("base64url");
}

export function decodeAssetCursor(cursor: string): { page: number; assetId: string } | null {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 64 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return null;
  const match = /^([1-9][0-9]{0,9}):(p[1-9][0-9]{0,8}\.g?(?:0|[1-9][0-9]{0,5}))$/.exec(Buffer.from(cursor, "base64url").toString("utf8"));
  if (!match) return null;
  const page = Number(match[1]);
  // Canonical only: the cursor round-trips exactly, and its page is the one in the asset id.
  if (page > MAX_PAGE || encodeAssetCursor(page, match[2]!) !== cursor || !match[2]!.startsWith(`p${page}.`)) return null;
  return { page, assetId: match[2]! };
}

function checkedPage(page: DocumentAssetPage | undefined): { limit: number; after: { page: number; assetId: string } | null; from: number | null; to: number | null } {
  const limit = page?.limit ?? DOCUMENT_ASSET_PAGE_DEFAULT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DOCUMENT_ASSET_PAGE_MAX) throw new DocumentAssetQueryError();
  const after = page?.after === undefined ? null : decodeAssetCursor(page.after);
  if (page?.after !== undefined && !after) throw new DocumentAssetQueryError();
  const bound = (value: number | undefined) => {
    if (value === undefined) return null;
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE) throw new DocumentAssetQueryError();
    return value;
  };
  const from = bound(page?.pageFrom);
  const to = bound(page?.pageTo);
  if (from !== null && to !== null && from > to) throw new DocumentAssetQueryError();
  return { limit, after, from, to };
}

/**
 * The document's asset map (one page of it) and extraction level, or null when the document is not in this organization
 * (and project) or is not one the viewer is shown. The scope is required: there is no unscoped read.
 */
export async function getDocumentAssetLedger(scope: DocumentAssetScope, page?: DocumentAssetPage): Promise<DocumentAssetLedgerView | null> {
  if (!scope || typeof scope.orgId !== "string" || !ID.test(scope.orgId) || typeof scope.documentId !== "string" || !ID.test(scope.documentId) ||
      (scope.projectId !== undefined && (typeof scope.projectId !== "string" || !ID.test(scope.projectId)))) {
    throw new Error("A document asset read needs an organization and a document id");
  }
  const { limit, after, from, to } = checkedPage(page);
  const projectFilter = scope.projectId === undefined ? sql`` : sql`and d.project_id = ${scope.projectId}`;
  // Only a document the viewer would be shown: completed (not processing, failed or PII-blocked) and not purged.
  const [document] = await sql<{ id: string; metadata: unknown; run_id: string | null }[]>`
    select d.id, d.metadata, d.run_id from documents d
    where d.id = ${scope.documentId} and d.org_id = ${scope.orgId} ${projectFilter}
      and d.status = 'completed' and d.purged_at is null`;
  if (!document) return null;

  const [level] = await sql<Array<{
    markdown_complete: boolean; images_status: string; images_exit_code: number | null; manifest_version: number | null;
    manifest_sha256: string | null; doppler_build: string | null; resumes: number; last_cut_page: number | null; deadline_ms: number | null;
    assets_total: number; assets_extracted: number; assets_not_extracted: number; assets_unlinked: number; assets_resumable: number;
    source_copy: number; source_decode: number; source_render: number; asset_bytes: string | number; updated_at: string;
  }>>`
    select markdown_complete, images_status, images_exit_code, manifest_version, manifest_sha256, doppler_build, resumes, last_cut_page,
      deadline_ms, assets_total, assets_extracted, assets_not_extracted, assets_unlinked, assets_resumable, source_copy, source_decode,
      source_render, asset_bytes, updated_at::text
    from document_extraction_levels
    where document_id = ${scope.documentId} and org_id = ${scope.orgId}`;

  // The file an image shows is its owner's (file_of); the owner may sit on another page of the result, so join it.
  const rows = await sql<Array<{
    asset_id: string; page_number: number; kind: string; fate: string; status: string; reason: string | null; resumable: boolean;
    source: string | null; format: string | null; bytes: number | null; sha256: string | null; width: number | null; height: number | null;
    repeat_of: string | null; fallback: string | null; link_path: string | null; file_of: string | null; owner_key: string | null;
    slot_uri: string | null;
  }>>`
    select a.asset_id, a.page_number, a.kind, a.fate, a.status, a.reason, a.resumable, a.source, a.format, a.bytes, a.sha256, a.width,
      a.height, a.repeat_of, a.fallback, a.link_path, a.file_of, o.storage_key as owner_key,
      (select r.artifacts ->> (a.document_id || ':doppler-figure:' || a.file_of) from project_runs r
        where r.id = ${document.run_id} and r.org_id = ${scope.orgId}) as slot_uri
    from document_assets a
    left join document_assets o on o.document_id = a.document_id and o.org_id = a.org_id and o.asset_id = a.file_of
    where a.document_id = ${scope.documentId} and a.org_id = ${scope.orgId}
      ${from === null ? sql`` : sql`and a.page_number >= ${from}`}
      ${to === null ? sql`` : sql`and a.page_number <= ${to}`}
      ${after === null ? sql`` : sql`and (a.page_number, a.asset_id) > (${after.page}, ${after.assetId})`}
    order by a.page_number, a.asset_id
    limit ${limit + 1}`;

  // PII withholding: by the exact URI recorded for the file's slot, or by the file's own object key.
  const withheld = withheldArtifactUrisFromMetadata(document.metadata);
  const withheldKeys = new Set([...withheld].map((uri) => parseArtifactUri(uri)?.key).filter((key): key is string => !!key));
  const isWithheld = (row: (typeof rows)[number]) =>
    !!row.file_of && ((row.slot_uri !== null && withheld.has(row.slot_uri)) || (row.owner_key !== null && withheldKeys.has(row.owner_key)));

  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    documentId: scope.documentId,
    level: level ? {
      markdownComplete: level.markdown_complete, imagesStatus: level.images_status, imagesExitCode: level.images_exit_code,
      manifestVersion: level.manifest_version, manifestSha256: level.manifest_sha256, dopplerBuild: level.doppler_build,
      resumes: level.resumes, lastCutPage: level.last_cut_page, deadlineMs: level.deadline_ms,
      counts: {
        total: level.assets_total, extracted: level.assets_extracted, notExtracted: level.assets_not_extracted, unlinked: level.assets_unlinked,
        resumable: level.assets_resumable, bySource: { copy: level.source_copy, decode: level.source_decode, render: level.source_render },
        bytes: Number(level.asset_bytes),
      },
      updatedAt: level.updated_at,
    } : null,
    assets: pageRows.map((row) => {
      const refused = isWithheld(row);
      return {
        id: row.asset_id, page: row.page_number, kind: row.kind, fate: row.fate, status: row.status, reason: row.reason,
        resumable: row.resumable, source: row.source, format: row.format, bytes: row.bytes, sha256: row.sha256, width: row.width,
        height: row.height, repeatOf: row.repeat_of, fallback: row.fallback, link: row.link_path, fileOf: row.file_of,
        slot: row.file_of && !refused && ASSET_ID.test(row.file_of) ? `${scope.documentId}:doppler-figure:${row.file_of}` : null,
        refusal: refused ? "pii-policy" as const : null,
      };
    }),
    nextCursor: rows.length > limit && last ? encodeAssetCursor(last.page_number, last.asset_id) : null,
  };
}

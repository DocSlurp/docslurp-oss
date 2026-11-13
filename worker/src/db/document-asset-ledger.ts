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
import type { JSONValue, Sql } from "postgres";
import {
  DOCUMENT_FACTS_LEVELS, DOCUMENT_IMAGES_STATUSES, DOPPLER_BUILD, DOPPLER_MANIFEST_V2_LIMITS, PAGE_SCAN_CLASSES, PAGE_TEXT_LAYERS,
  documentAssetCounts, documentAssetSchema, dopplerFigureFileName, dopplerManifestRunFacts,
  type DocumentAsset, type DocumentFactsLevel, type DocumentImagesStatus, type DopplerManifest, type DopplerManifestRunFacts,
} from "@docslurp/shared";

/** Who the rows belong to. Every query is filtered by `orgId` (and `projectId`), never by the document id alone. */
export interface DocumentAssetLedgerScope {
  orgId: string;
  projectId: string;
  documentId: string;
  /** The run that wrote them (null when it is gone). */
  runId: string | null;
}

export interface DocumentExtractionLevelInput {
  markdownComplete: boolean;
  factsLevel: DocumentFactsLevel;
  imagesStatus: DocumentImagesStatus;
  imagesExitCode: number | null;
  manifestVersion: 1 | 2 | null;
  dopplerBuild: string | null;
  run: DopplerManifestRunFacts | null;
}

export type LedgerAsset = DocumentAsset & { storageKey: string | null };

export interface LedgerPageFacts {
  pageNumber: number;
  textLayer?: (typeof PAGE_TEXT_LAYERS)[number] | null;
  scanClass?: (typeof PAGE_SCAN_CLASSES)[number] | null;
}

export interface DocumentAssetLedgerWrite {
  scope: DocumentAssetLedgerScope;
  level: DocumentExtractionLevelInput;
  assets: readonly LedgerAsset[];
  /** Per-page routing facts (document_page_facts.text_layer / scan_class); absent fields are left as they are. */
  pages?: readonly LedgerPageFacts[];
}

/** A write refused before anything reached the database, or a scope that did not match the document. Fixed messages. */
export class DocumentAssetLedgerError extends Error {
  constructor(readonly rule: "invalid-scope" | "invalid-assets" | "invalid-level" | "invalid-pages" | "scope-mismatch" | "write-mismatch") {
    super(`Document asset ledger refused: ${rule}`);
    this.name = "DocumentAssetLedgerError";
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DOCUMENT_ID = /^[A-Za-z0-9-]{1,64}$/;
const BATCH = 1000;
const MAX_PAGES = 100_000;

function assertScope(scope: DocumentAssetLedgerScope): void {
  if (!scope || typeof scope.orgId !== "string" || !ID.test(scope.orgId) || typeof scope.projectId !== "string" || !ID.test(scope.projectId) ||
      typeof scope.documentId !== "string" || !DOCUMENT_ID.test(scope.documentId) ||
      (scope.runId !== null && (typeof scope.runId !== "string" || !ID.test(scope.runId)))) {
    throw new DocumentAssetLedgerError("invalid-scope");
  }
}

/** Re-validate every row: the closed vocabulary, the status rules, unique ids and a storage key in this document's folder. */
function checkedAssets(documentId: string, assets: readonly LedgerAsset[]): LedgerAsset[] {
  if (!Array.isArray(assets) || assets.length > DOPPLER_MANIFEST_V2_LIMITS.maxEntries) throw new DocumentAssetLedgerError("invalid-assets");
  const seen = new Set<string>();
  return assets.map((asset) => {
    const { storageKey, ...row } = asset;
    const parsed = documentAssetSchema.safeParse(row);
    if (!parsed.success || seen.has(parsed.data.assetId)) throw new DocumentAssetLedgerError("invalid-assets");
    seen.add(parsed.data.assetId);
    const owns = parsed.data.status === "extracted";
    if (owns !== (storageKey !== null)) throw new DocumentAssetLedgerError("invalid-assets");
    if (storageKey !== null) {
      const suffix = `/doppler-figures/${documentId}/${dopplerFigureFileName(parsed.data.assetId, parsed.data.format!)}`;
      if (typeof storageKey !== "string" || storageKey.length > 512 || !storageKey.endsWith(suffix) || storageKey.includes("..") ||
          storageKey.startsWith("/") || storageKey.includes("//")) {
        throw new DocumentAssetLedgerError("invalid-assets");
      }
    }
    return { ...parsed.data, storageKey };
  });
}

function checkedLevel(level: DocumentExtractionLevelInput, resumable: number): void {
  const ok = level && typeof level.markdownComplete === "boolean" &&
    DOCUMENT_FACTS_LEVELS.includes(level.factsLevel) && DOCUMENT_IMAGES_STATUSES.includes(level.imagesStatus) &&
    (level.imagesExitCode === null || (Number.isSafeInteger(level.imagesExitCode) && level.imagesExitCode >= 0 && level.imagesExitCode <= 255)) &&
    (level.manifestVersion === null || level.manifestVersion === 1 || level.manifestVersion === 2) &&
    (level.dopplerBuild === null || (typeof level.dopplerBuild === "string" && DOPPLER_BUILD.test(level.dopplerBuild))) &&
    (level.imagesStatus === "resumable") === (resumable > 0);
  const run = level?.run;
  const hex = (v: unknown) => v === null || (typeof v === "string" && /^[0-9a-f]{64}$/.test(v));
  const int = (v: unknown, min: number, max: number) => v === null || (Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max);
  if (!ok || (run !== null && !(hex(run.sourceSha256) && hex(run.settingsSha256) && int(run.resumes, 0, 1_000_000) &&
      int(run.lastCutPage, 1, 1_000_000_000) && int(run.deadlineMs, 0, 2_000_000_000)))) {
    throw new DocumentAssetLedgerError("invalid-level");
  }
}

function checkedPages(pages: readonly LedgerPageFacts[] | undefined): LedgerPageFacts[] {
  if (pages === undefined) return [];
  if (!Array.isArray(pages) || pages.length > MAX_PAGES) throw new DocumentAssetLedgerError("invalid-pages");
  const seen = new Set<number>();
  for (const page of pages) {
    if (!Number.isSafeInteger(page.pageNumber) || page.pageNumber < 1 || page.pageNumber > 1_000_000_000 || seen.has(page.pageNumber) ||
        (page.textLayer != null && !PAGE_TEXT_LAYERS.includes(page.textLayer)) || (page.scanClass != null && !PAGE_SCAN_CLASSES.includes(page.scanClass))) {
      throw new DocumentAssetLedgerError("invalid-pages");
    }
    seen.add(page.pageNumber);
  }
  return pages.filter((page) => page.textLayer != null || page.scanClass != null);
}

/**
 * Upsert the document's ledger rows and extraction level in one transaction, scoped to the document's organization and
 * project. Validates everything first (a refusal writes nothing). Inside the transaction the document must exist with
 * exactly this organization and project, or nothing is written and DocumentAssetLedgerError("scope-mismatch") is thrown.
 * Rows of images the write does not list are removed, so the table is always the full map of the latest manifest.
 */
export async function writeDocumentAssetLedger(sql: Sql<Record<string, unknown>>, write: DocumentAssetLedgerWrite): Promise<void> {
  assertScope(write.scope);
  const assets = checkedAssets(write.scope.documentId, write.assets);
  const counts = documentAssetCounts(assets);
  checkedLevel(write.level, counts.resumable);
  const pages = checkedPages(write.pages);
  const { orgId, projectId, documentId, runId } = write.scope;

  await sql.begin(async (tx) => {
    // Serialize writers of one document (a re-run racing a resume), then check the scope against the document itself.
    await tx`select pg_advisory_xact_lock(hashtext(${`document-assets:${documentId}`}))`;
    const [document] = await tx<{ id: string }[]>`
      select id from documents where id = ${documentId} and org_id = ${orgId} and project_id = ${projectId} for key share`;
    if (!document) throw new DocumentAssetLedgerError("scope-mismatch");

    await tx`
      delete from document_assets
      where org_id = ${orgId} and project_id = ${projectId} and document_id = ${documentId}
        and not (asset_id = any(${tx.array(assets.map((asset) => asset.assetId))}::text[]))`;

    for (let start = 0; start < assets.length; start += BATCH) {
      const payload = assets.slice(start, start + BATCH).map((asset) => ({
        asset_id: asset.assetId, page_number: asset.pageNumber, kind: asset.kind, fate: asset.fate, status: asset.status,
        reason: asset.reason, resumable: asset.resumable, source: asset.source, format: asset.format, bytes: asset.bytes,
        sha256: asset.sha256, width: asset.width, height: asset.height, repeat_of: asset.repeatOf, fallback: asset.fallback,
        link_path: asset.linkPath, file_of: asset.fileOf, storage_key: asset.storageKey,
      }));
      const written = await tx`
        insert into document_assets (document_id, org_id, project_id, run_id, asset_id, page_number, kind, fate, status, reason,
          resumable, source, format, bytes, sha256, width, height, repeat_of, fallback, link_path, file_of, storage_key)
        select ${documentId}, ${orgId}, ${projectId}, ${runId}, r.asset_id, r.page_number, r.kind, r.fate, r.status, r.reason,
          r.resumable, r.source, r.format, r.bytes, r.sha256, r.width, r.height, r.repeat_of, r.fallback, r.link_path, r.file_of, r.storage_key
        from jsonb_to_recordset(${tx.json(payload as unknown as JSONValue)}::jsonb) as r(
          asset_id text, page_number integer, kind text, fate text, status text, reason text, resumable boolean, source text,
          format text, bytes integer, sha256 text, width integer, height integer, repeat_of text, fallback text, link_path text,
          file_of text, storage_key text)
        on conflict (document_id, asset_id) do update
        set run_id = excluded.run_id, page_number = excluded.page_number, kind = excluded.kind, fate = excluded.fate,
            status = excluded.status, reason = excluded.reason, resumable = excluded.resumable, source = excluded.source,
            format = excluded.format, bytes = excluded.bytes, sha256 = excluded.sha256, width = excluded.width,
            height = excluded.height, repeat_of = excluded.repeat_of, fallback = excluded.fallback, link_path = excluded.link_path,
            file_of = excluded.file_of, storage_key = excluded.storage_key, updated_at = now()
        where document_assets.org_id = excluded.org_id and document_assets.project_id = excluded.project_id
        returning 1`;
      // Defense in depth behind the composite foreign key: a row of another scope is never overwritten, and that is loud.
      if (written.length !== payload.length) throw new DocumentAssetLedgerError("write-mismatch");
    }

    const level = write.level;
    const run = level.run;
    const leveled = await tx`
      insert into document_extraction_levels (document_id, org_id, project_id, run_id, markdown_complete, facts_level, images_status,
        images_exit_code, manifest_version, doppler_build, source_sha256, settings_sha256, resumes, last_cut_page, deadline_ms,
        assets_total, assets_extracted, assets_not_extracted, assets_unlinked, assets_resumable, source_copy, source_decode,
        source_render, asset_bytes)
      values (${documentId}, ${orgId}, ${projectId}, ${runId}, ${level.markdownComplete}, ${level.factsLevel}, ${level.imagesStatus},
        ${level.imagesExitCode}, ${level.manifestVersion}, ${level.dopplerBuild}, ${run?.sourceSha256 ?? null}, ${run?.settingsSha256 ?? null},
        ${run?.resumes ?? 0}, ${run?.lastCutPage ?? null}, ${run?.deadlineMs ?? null}, ${counts.total}, ${counts.extracted},
        ${counts.notExtracted}, ${counts.unlinked}, ${counts.resumable}, ${counts.sourceCopy}, ${counts.sourceDecode},
        ${counts.sourceRender}, ${counts.bytes})
      on conflict (document_id) do update
      set run_id = excluded.run_id, markdown_complete = excluded.markdown_complete, facts_level = excluded.facts_level,
          images_status = excluded.images_status, images_exit_code = excluded.images_exit_code,
          manifest_version = excluded.manifest_version, doppler_build = excluded.doppler_build,
          source_sha256 = excluded.source_sha256, settings_sha256 = excluded.settings_sha256, resumes = excluded.resumes,
          last_cut_page = excluded.last_cut_page, deadline_ms = excluded.deadline_ms, assets_total = excluded.assets_total,
          assets_extracted = excluded.assets_extracted, assets_not_extracted = excluded.assets_not_extracted,
          assets_unlinked = excluded.assets_unlinked, assets_resumable = excluded.assets_resumable,
          source_copy = excluded.source_copy, source_decode = excluded.source_decode, source_render = excluded.source_render,
          asset_bytes = excluded.asset_bytes, updated_at = now()
      where document_extraction_levels.org_id = excluded.org_id and document_extraction_levels.project_id = excluded.project_id
      returning 1`;
    if (leveled.length !== 1) throw new DocumentAssetLedgerError("write-mismatch");

    for (let start = 0; start < pages.length; start += BATCH) {
      const payload = pages.slice(start, start + BATCH).map((page) => ({
        page_number: page.pageNumber, text_layer: page.textLayer ?? null, scan_class: page.scanClass ?? null,
      }));
      await tx`
        insert into document_page_facts (document_id, page_number, run_id, text_layer, scan_class)
        select ${documentId}, r.page_number, ${runId}, r.text_layer, r.scan_class
        from jsonb_to_recordset(${tx.json(payload as unknown as JSONValue)}::jsonb) as r(page_number integer, text_layer text, scan_class text)
        on conflict (document_id, page_number) do update
        set text_layer = coalesce(excluded.text_layer, document_page_facts.text_layer),
            scan_class = coalesce(excluded.scan_class, document_page_facts.scan_class),
            updated_at = now()`;
    }
  });
}

// ---- Building a write from the figure step ----

export interface FigureStepOutcome {
  /** extracted (exit 0), partial (exit 5 with a kept folder), failed (no folder to trust, or it was refused). */
  status: "extracted" | "partial" | "failed";
  exitCode?: number;
  build?: string;
}

/** The images status a parsed manifest means: complete, resumable (a resume would retry some) or partial. */
export function imagesStatusOf(manifest: DopplerManifest): DocumentImagesStatus {
  const run = dopplerManifestRunFacts(manifest);
  if (run.complete) return "complete";
  return run.resumable ? "resumable" : "partial";
}

/** The ledger write for a stored figure set: every image, with the storage key of each file it owns. */
export function ledgerWriteForStoredFigures(args: {
  scope: DocumentAssetLedgerScope;
  manifest: DopplerManifest;
  assets: readonly DocumentAsset[];
  /** Storage key by owning image id, as the files were stored. */
  keys: ReadonlyMap<string, string>;
  outcome: FigureStepOutcome;
  pages?: readonly LedgerPageFacts[];
}): DocumentAssetLedgerWrite {
  return {
    scope: args.scope,
    level: {
      markdownComplete: true, factsLevel: "none", imagesStatus: imagesStatusOf(args.manifest),
      imagesExitCode: args.outcome.exitCode ?? null, manifestVersion: args.manifest.version, dopplerBuild: args.outcome.build ?? null,
      run: args.manifest.version === 2 ? dopplerManifestRunFacts(args.manifest) : null,
    },
    assets: args.assets.map((asset) => ({ ...asset, storageKey: asset.status === "extracted" ? args.keys.get(asset.assetId) ?? null : null })),
    ...(args.pages ? { pages: args.pages } : {}),
  };
}

/** The ledger write for a figure step that stored nothing: no asset rows (older ones go), images failed. */
export function ledgerWriteForFailedFigures(args: {
  scope: DocumentAssetLedgerScope; outcome: Omit<FigureStepOutcome, "status">; pages?: readonly LedgerPageFacts[];
}): DocumentAssetLedgerWrite {
  return {
    scope: args.scope,
    level: {
      markdownComplete: true, factsLevel: "none", imagesStatus: "failed", imagesExitCode: args.outcome.exitCode ?? null,
      manifestVersion: null, dopplerBuild: args.outcome.build ?? null, run: null,
    },
    assets: [],
    ...(args.pages ? { pages: args.pages } : {}),
  };
}

// ---- Reading: the resume queue ----

export interface ResumableDocument {
  documentId: string;
  projectId: string;
  runId: string | null;
  sourceSha256: string | null;
  settingsSha256: string | null;
  resumes: number;
  assetsResumable: number;
  lastCutPage: number | null;
  updatedAt: string;
}

/**
 * Documents of one organization (optionally one project) whose images a Doppler resume would retry, oldest first, with a
 * keyset cursor. Only live documents (not superseded, archived or purged). For a later resume worker; nothing here
 * resumes anything.
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
    resumes: number; assets_resumable: number; last_cut_page: number | null; updated_at: string;
  }>>`
    select l.document_id, l.project_id, l.run_id, l.source_sha256, l.settings_sha256, l.resumes, l.assets_resumable, l.last_cut_page,
      to_char(l.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at
    from document_extraction_levels l
    join documents d on d.id = l.document_id and d.org_id = l.org_id and d.project_id = l.project_id
    where l.org_id = ${args.orgId} and l.images_status = 'resumable'
      ${args.projectId === undefined ? sql`` : sql`and l.project_id = ${args.projectId}`}
      ${args.after ? sql`and (l.updated_at, l.document_id) > (${args.after.updatedAt}::timestamptz, ${args.after.documentId})` : sql``}
      and d.superseded_at is null and d.archived_at is null and d.purged_at is null
    order by l.updated_at, l.document_id
    limit ${limit}`;
  return rows.map((row) => ({
    documentId: row.document_id, projectId: row.project_id, runId: row.run_id, sourceSha256: row.source_sha256,
    settingsSha256: row.settings_sha256, resumes: row.resumes, assetsResumable: row.assets_resumable, lastCutPage: row.last_cut_page,
    updatedAt: row.updated_at,
  }));
}

// ---- The figure step's call ----

/** What the figure step did with the ledger, for stage stats (fixed values, no error text). */
export type LedgerRecordStatus = "written" | "unsupported" | "no-scope" | "refused" | "failed";

/**
 * Write the figure step's ledger through the run's store. Never fails the document: a store without the ledger, a run
 * without an organization or project (nothing is written: there is no scope to write under), a refused write and a
 * database error are each logged with a fixed reason and reported in the returned status. Cancellation still throws.
 */
export async function recordFigureLedger(args: {
  store: { writeDocumentAssetLedger?(write: DocumentAssetLedgerWrite): Promise<void> } | undefined;
  run: { id: string; orgId: string | null; projectId?: string | null };
  documentId: string;
  build: (scope: DocumentAssetLedgerScope) => DocumentAssetLedgerWrite;
  signal?: AbortSignal;
}): Promise<LedgerRecordStatus> {
  if (!args.store?.writeDocumentAssetLedger) return "unsupported";
  if (!args.run.orgId || !args.run.projectId) {
    console.warn(`[asset-ledger] document=${args.documentId} status=no-scope (run without organization or project; nothing written)`);
    return "no-scope";
  }
  try {
    args.signal?.throwIfAborted();
    await args.store.writeDocumentAssetLedger(args.build({ orgId: args.run.orgId, projectId: args.run.projectId, documentId: args.documentId, runId: args.run.id }));
    return "written";
  } catch (error) {
    if (args.signal?.aborted) throw error;
    if (error instanceof DocumentAssetLedgerError) {
      console.warn(`[asset-ledger] document=${args.documentId} status=refused rule=${error.rule}`);
      return "refused";
    }
    const code = (error as { code?: unknown } | null)?.code;
    console.warn(`[asset-ledger] document=${args.documentId} status=failed error=${error instanceof Error ? error.name : typeof error}${typeof code === "string" ? ` code=${code}` : ""}`);
    return "failed";
  }
}

/** Per-page text layers from validated layout facts (lib/page-layout-facts.ts), for document_page_facts.text_layer. */
export function ledgerPagesFromLayoutFacts(
  layoutFacts: ReadonlyMap<number, { textLayer?: LedgerPageFacts["textLayer"] }> | undefined,
): LedgerPageFacts[] | undefined {
  if (!layoutFacts || layoutFacts.size === 0) return undefined;
  const pages: LedgerPageFacts[] = [];
  for (const [pageNumber, facts] of layoutFacts) if (facts.textLayer) pages.push({ pageNumber, textLayer: facts.textLayer });
  return pages.length > 0 ? pages : undefined;
}

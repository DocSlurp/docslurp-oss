/*
 * Doppler image manifest v2 (`pdftomarkdown --images-dir`, Doppler's `manifest.json` version 2) and the document asset
 * ledger rows DocSlurp keeps for every image Doppler reports, extracted or not.
 *
 * Version 2 names each image's file by path (`page-0012/image-003.webp`), links it from the Markdown
 * (`<link_prefix><path>`), and says per image whether a file was written and, if not, why (`status`, `reason`,
 * `resumable`). The manifest is written inside the PDF VM, so the worker treats every field as hostile: the schema here
 * is strict (unknown fields refuse it), every enum is closed, every number finite and bounded, every string bounded, and
 * paths are only ever `page-NNNN/(image|figure)-NNN.<format>` derived from the image id (or the id it repeats).
 *
 * Version 1 (`doppler-figures@1`, ./doppler-figures.ts) is still accepted until the Doppler pin moves; both map into
 * the same ledger rows (`dopplerLedgerAssets`).
 *
 * Design: docs/extraction/doppler-figures.md ("Asset ledger").
 */
import { z } from "zod";

import {
  DOPPLER_FIGURE_ID, DOPPLER_FIGURE_FORMATS, DOPPLER_FIGURE_LIMITS, dopplerFigureManifestSchema, parseDopplerFigureId,
  type DopplerFigureFormat, type DopplerFigureManifest,
} from "./doppler-figures.js";

/** Absolute host-side bounds for a version 2 manifest; the per-document caps (`dopplerAssetCaps`) scale below them. */
export const DOPPLER_MANIFEST_V2_LIMITS = {
  /** Every image Doppler reports, with or without a file (unlinked furniture and watermarks included). */
  maxEntries: 131_072,
  maxBatches: 16_384,
  maxManifestBytes: 64 * 1024 * 1024,
  maxFiles: 32_768,
  maxTotalBytes: 4 * 1024 * 1024 * 1024,
  /** One picture or figure file (`--images-max-file-bytes`). */
  maxPictureFileBytes: 8 * 1024 * 1024,
  /** One page scan copied or decoded from the PDF (`--scan-max-bytes`, which Doppler caps at 64 MiB per copy). */
  maxScanFileBytes: 64 * 1024 * 1024,
  /** `page-facts.jsonl` beside the manifest (doppler-page-facts/1 lines). */
  maxPageFactsBytes: 64 * 1024 * 1024,
  maxLinkPrefixBytes: 128,
} as const;

/** The caps the host holds one document's images folder to, and passes to Doppler as its own limits. */
export interface DopplerAssetCaps {
  /** Files in the folder (pictures, figures and page scans). */
  files: number;
  /** `page-NNNN` folders. */
  pageDirs: number;
  totalBytes: number;
  entries: number;
  manifestBytes: number;
  pictureFileBytes: number;
  scanFileBytes: number;
  pageFactsBytes: number;
}

const MIB = 1024 * 1024;

/**
 * Caps that grow with the document, bounded: a scanned book's page scans fit (one JPEG of up to about 1.25 MiB per page
 * on top of the pictures' allowance), and a hostile manifest still cannot claim more than the absolute limits.
 *
 * - files `min(2048 + 2 x pages, 32768)`, page folders `min(pages, files)`
 * - bytes `min(64 MiB + 1.25 MiB x pages, 4 GiB)`
 * - entries `min(16384 + 16 x pages, 131072)`, manifest `min(8 MiB + 512 B x entries, 64 MiB)`
 * - one file: 8 MiB for pictures and figures, 64 MiB for a page scan copied or decoded from the PDF
 */
export function dopplerAssetCaps(pageCount: number): DopplerAssetCaps {
  const pages = Number.isSafeInteger(pageCount) && pageCount > 0 ? Math.min(pageCount, 1_000_000_000) : 0;
  const L = DOPPLER_MANIFEST_V2_LIMITS;
  const files = Math.min(2048 + 2 * pages, L.maxFiles);
  const entries = Math.min(16_384 + 16 * pages, L.maxEntries);
  return {
    files,
    pageDirs: Math.min(pages, files),
    totalBytes: Math.min(64 * MIB + Math.floor(1.25 * MIB) * pages, L.maxTotalBytes),
    entries,
    manifestBytes: Math.min(8 * MIB + 512 * entries, L.maxManifestBytes),
    pictureFileBytes: L.maxPictureFileBytes,
    scanFileBytes: L.maxScanFileBytes,
    pageFactsBytes: Math.min(MIB + 16 * 1024 * pages, L.maxPageFactsBytes),
  };
}

/** The largest file one entry may own: a copied or decoded page scan may reach the scan cap, anything else the picture cap. */
export function dopplerEntryFileCap(entry: { fate: string; source: string | null }, caps: Pick<DopplerAssetCaps, "pictureFileBytes" | "scanFileBytes">): number {
  return entry.fate === "page-scan" && (entry.source === "copy" || entry.source === "decode") ? caps.scanFileBytes : caps.pictureFileBytes;
}

const ABSOLUTE_FILE_CAPS = {
  pictureFileBytes: DOPPLER_MANIFEST_V2_LIMITS.maxPictureFileBytes,
  scanFileBytes: DOPPLER_MANIFEST_V2_LIMITS.maxScanFileBytes,
} as const;

/** Pages per Doppler image batch (`--images-batch-pages`); the per-batch limits below are derived from it. */
export const DOPPLER_IMAGES_BATCH_PAGES = 64;

/**
 * The limits the host passes to Doppler (`pdftomarkdown` flags) so that its own budgets stop it, resumably, before the
 * host's caps would refuse the folder: Doppler's budgets are per batch, the host's per document, so the per-batch file
 * budgets are the document's divided over its batches. The host refuses a folder only when Doppler exceeded these.
 */
export interface DopplerImageLimits {
  /** `--images-batch-pages` */
  batchPages: number;
  /** `--images-max` (picture and figure files per batch) */
  imagesMax: number;
  /** `--images-max-bytes` (picture and figure bytes per batch) */
  imagesMaxBytes: number;
  /** `--images-max-file-bytes` */
  imagesMaxFileBytes: number;
  /** `--scan-max` (page scan files per batch: at most one per page) */
  scanMax: number;
  /** `--scan-max-bytes` (page scan bytes per batch; also one copy's cap, which Doppler holds to 64 MiB) */
  scanMaxBytes: number;
  /** `--images-doc-max-bytes` (every file of the document) */
  imagesDocMaxBytes: number;
  /** `--images-link-prefix`: the folder the stored Markdown's links resolve into (see `DOPPLER_STORE_LAYOUT`). */
  linkPrefix: string;
}

export function dopplerImageLimits(pageCount: number): DopplerImageLimits {
  const caps = dopplerAssetCaps(pageCount);
  const batchPages = DOPPLER_IMAGES_BATCH_PAGES;
  const batches = Math.max(1, Math.ceil(Math.max(1, caps.pageDirs) / batchPages));
  // Every batch may write up to `batchPages` scans; what is left of the document's file cap is shared by the batches.
  const imagesMax = Math.max(1, Math.floor(caps.files / batches) - batchPages);
  return {
    batchPages,
    imagesMax,
    imagesMaxBytes: Math.min(256 * MIB, caps.totalBytes),
    imagesMaxFileBytes: caps.pictureFileBytes,
    scanMax: batchPages,
    scanMaxBytes: Math.min(caps.scanFileBytes * batchPages, caps.totalBytes),
    imagesDocMaxBytes: caps.totalBytes,
    linkPrefix: DOPPLER_STORE_LAYOUT.imagesFolder,
  };
}

/**
 * Where a document's Doppler output lives in object storage: Doppler's own folder layout under one prefix,
 * `<artifact root>/doppler/<document id>/`, so a plain download of the folder is the conversion as Doppler wrote it.
 *
 *     document.md                          the Markdown exactly as Doppler wrote it (links `images/page-NNNN/...`)
 *     source.json                          {sourceKey, sha256, pageCount, mimeType}: a pointer, never served
 *     index.json                           DocSlurp's figure index (the `doppler-figures` slot)
 *     images/manifest.json                 the validated manifest bytes, unchanged
 *     images/page-facts.jsonl              doppler-page-facts/1 lines, when the provider returned them
 *     images/page-NNNN/image-MMM.<ext>     pictures and page scans
 *     images/page-NNNN/figure-KKK.<ext>    vector figures
 *
 * `images/` is the `--images-link-prefix` the host asks for, so every link of `document.md` resolves inside the folder
 * with no rewriting, and `images/` (manifest plus page folders) is exactly the DIR `pdftomarkdown --images-resume` takes.
 */
export const DOPPLER_STORE_LAYOUT = {
  folder: "doppler",
  imagesFolder: "images/",
  markdown: "document.md",
  source: "source.json",
  index: "index.json",
  manifest: "manifest.json",
  pageFacts: "page-facts.jsonl",
} as const;

const DOCUMENT_ID_SEGMENT = /^[A-Za-z0-9-]{1,64}$/;

/** `<artifact root>/doppler/<document id>/`: the document's Doppler folder (with the trailing slash). */
export function dopplerDocumentPrefix(artifactRoot: string, documentId: string): string {
  if (typeof artifactRoot !== "string" || artifactRoot === "" || artifactRoot.startsWith("/") || artifactRoot.endsWith("/") ||
      artifactRoot.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("Invalid artifact root for a Doppler folder");
  }
  if (!DOCUMENT_ID_SEGMENT.test(documentId)) throw new Error("Invalid document id for a Doppler folder");
  return `${artifactRoot}/${DOPPLER_STORE_LAYOUT.folder}/${documentId}/`;
}

/** The storage key of the file an image owns: the document's images folder plus its derived path. */
export function dopplerAssetStorageKey(artifactRoot: string, documentId: string, ownerId: string, format: DopplerFigureFormat): string {
  const relative = dopplerAssetPath(ownerId, format);
  if (!relative) throw new Error("Invalid Doppler image id or format");
  return `${dopplerDocumentPrefix(artifactRoot, documentId)}${DOPPLER_STORE_LAYOUT.imagesFolder}${relative}`;
}

export const DOPPLER_ASSET_KINDS = ["picture", "mask", "vector"] as const;
export type DopplerAssetKind = (typeof DOPPLER_ASSET_KINDS)[number];

/** Where Doppler placed an image (its `Fate`). `other`: a version 1 value outside this vocabulary (ledger only). */
export const DOPPLER_ASSET_FATES = [
  "block", "inline", "page-scan", "background", "furniture", "watermark", "small", "duplicate", "fragment", "grouped", "text",
] as const;
export const DOPPLER_LEDGER_FATES = [...DOPPLER_ASSET_FATES, "other"] as const;
export type DopplerLedgerFate = (typeof DOPPLER_LEDGER_FATES)[number];

export const DOPPLER_ASSET_STATUSES = ["extracted", "not-extracted", "unlinked"] as const;
export type DopplerAssetStatus = (typeof DOPPLER_ASSET_STATUSES)[number];

/** Why a linked image has no file of its own. `other`: a version 1 reason outside this vocabulary (ledger only). */
export const DOPPLER_ASSET_REASONS = [
  // about the image itself
  "min_side", "repeat", "pages", "bbox", "id", "file_bytes", "encode", "scan-pages", "copy", "error",
  // its batch or the document stopped
  "budget", "doc_budget", "timeout", "deadline", "renderer", "aborted",
] as const;
export const DOPPLER_LEDGER_REASONS = [...DOPPLER_ASSET_REASONS, "other"] as const;
export type DopplerLedgerReason = (typeof DOPPLER_LEDGER_REASONS)[number];
/** The reasons that mean the image's batch (or the document) stopped, not anything about the image. */
export const DOPPLER_BATCH_REASONS = ["budget", "doc_budget", "timeout", "deadline", "renderer", "aborted"] as const;
/** The reasons a later `--images-resume` retries: the batch stopped, nothing about the image. */
export const DOPPLER_RESUMABLE_REASONS = ["budget", "doc_budget", "timeout", "deadline", "aborted"] as const;

/** How a file was made: `copy` (a page scan's JPEG stream, metadata stripped), `decode` (samples decoded once), `render`. */
export const DOPPLER_ASSET_SOURCES = ["copy", "decode", "render"] as const;
export type DopplerAssetSource = (typeof DOPPLER_ASSET_SOURCES)[number];

/** Why a file is not in its natural format. `other`: version 1's bare `true` or an unknown slug (ledger only). */
export const DOPPLER_ASSET_FALLBACKS = ["svg_allowlist", "svg_size", "svg_input"] as const;
export const DOPPLER_LEDGER_FALLBACKS = [...DOPPLER_ASSET_FALLBACKS, "other"] as const;
export type DopplerLedgerFallback = (typeof DOPPLER_LEDGER_FALLBACKS)[number];

export const DOPPLER_BATCH_STATUSES = ["ok", "budget", "doc_budget", "timeout", "deadline", "renderer", "aborted"] as const;

/** `page-NNNN/(image|figure)-NNN.<format>`: at least 4 and 3 digits, no extra leading zeros (checked against the id). */
export const DOPPLER_ASSET_PATH = /^page-([0-9]{4,10})\/(image|figure)-([0-9]{3,7})\.(webp|png|svg|jpg)$/;
const LINK_PREFIX = /^(?:[A-Za-z0-9._~-]+\/)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const slug = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,31}$/);

/** The only path an image may have: derived from an id (its own, or the one it repeats) and the format. */
export function dopplerAssetPath(id: string, format: DopplerFigureFormat): string | null {
  const parsed = parseDopplerFigureId(id);
  if (!parsed || !DOPPLER_FIGURE_FORMATS.includes(format)) return null;
  return `page-${String(parsed.pageNumber).padStart(4, "0")}/${parsed.vector ? "figure" : "image"}-${String(parsed.index).padStart(3, "0")}.${format}`;
}

/** A link as a version 2 Markdown holds it: a valid prefix followed by a valid path. */
export function isDopplerAssetLink(link: string): boolean {
  const match = /^(.*?)(page-[0-9]{4,10}\/(?:image|figure)-[0-9]{3,7}\.(?:webp|png|svg|jpg))$/.exec(link);
  return !!match && isDopplerLinkPrefix(match[1]!) && DOPPLER_ASSET_PATH.test(match[2]!);
}

/** An `--images-link-prefix` as Doppler accepts it: empty, or relative segments of `A-Z a-z 0-9 . _ ~ -` ending in `/`. */
export function isDopplerLinkPrefix(prefix: string): boolean {
  if (prefix === "") return true;
  if (prefix.length > DOPPLER_MANIFEST_V2_LIMITS.maxLinkPrefixBytes || !LINK_PREFIX.test(prefix)) return false;
  return prefix.slice(0, -1).split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const pageNumber = z.number().int().min(1).max(1_000_000_000);
const coordinate = z.number().finite().min(-1e9).max(1e9);
const side = z.number().int().min(0).max(DOPPLER_FIGURE_LIMITS.maxSide);

export const dopplerManifestV2EntrySchema = z.strictObject({
  id: z.string().regex(DOPPLER_FIGURE_ID),
  page: pageNumber,
  bbox: z.tuple([coordinate, coordinate, coordinate, coordinate]),
  kind: z.enum(DOPPLER_ASSET_KINDS),
  fate: z.enum(DOPPLER_ASSET_FATES),
  obj: z.tuple([z.number().int().min(0).max(2_147_483_647), z.number().int().min(0).max(65_535)]).nullable(),
  path: z.string().max(64).regex(DOPPLER_ASSET_PATH).nullable(),
  link: z.string().max(DOPPLER_MANIFEST_V2_LIMITS.maxLinkPrefixBytes + 64).nullable(),
  status: z.enum(DOPPLER_ASSET_STATUSES),
  reason: z.enum(DOPPLER_ASSET_REASONS).optional(),
  resumable: z.literal(true).optional(),
  /** The renderer's or copy check's own detail for `reason: error` / `copy`. Telemetry only, never stored. */
  error: slug.optional(),
  repeat_of: z.string().regex(DOPPLER_FIGURE_ID).optional(),
  format: z.enum(DOPPLER_FIGURE_FORMATS).nullable(),
  source: z.enum(DOPPLER_ASSET_SOURCES).nullable(),
  bytes: z.number().int().min(0).max(DOPPLER_MANIFEST_V2_LIMITS.maxScanFileBytes),
  sha256: z.string().regex(SHA256).nullable(),
  width: side,
  height: side,
  fallback: z.enum(DOPPLER_ASSET_FALLBACKS).optional(),
}).superRefine((entry, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const id = parseDopplerFigureId(entry.id);
  if (!id || id.pageNumber !== entry.page) issue("image id does not match its page");
  if (id && id.vector !== (entry.kind === "vector")) issue("image id does not match its kind");
  if (entry.repeat_of === entry.id) issue("an image repeats itself");
  if (entry.status === "unlinked") {
    if (entry.path !== null || entry.link !== null) issue("an unlinked image has a path");
  } else {
    // A linked image's path is derived from its own id or, for a repeat without a file, the id whose path it shares.
    const owners = entry.repeat_of && entry.status !== "extracted" ? [entry.id, entry.repeat_of] : [entry.id];
    if (entry.path === null || entry.format === null || !owners.some((owner) => dopplerAssetPath(owner, entry.format!) === entry.path)) {
      issue("image path is not derived from its id");
    }
    if (entry.link === null) issue("a linked image has no link");
  }
  if ((entry.status === "not-extracted") !== (entry.reason !== undefined)) issue("reason goes with not-extracted, and only with it");
  if (entry.resumable && !(DOPPLER_RESUMABLE_REASONS as readonly string[]).includes(entry.reason ?? "")) issue("resumable needs a batch reason");
  if (entry.error !== undefined && entry.reason !== "error" && entry.reason !== "copy") issue("error goes with reason error or copy");
  if (entry.status === "extracted") {
    if (entry.bytes < 1 || entry.sha256 === null || entry.source === null || entry.width < 1 || entry.height < 1) {
      issue("an extracted image needs bytes, sha256, source, width and height");
    }
  } else if (entry.bytes !== 0 || entry.sha256 !== null || entry.source !== null || entry.fallback !== undefined) {
    issue("an image without a file reports file details");
  }
  if ((entry.source === "copy" || entry.source === "decode") && entry.fate !== "page-scan") issue("only page scans are copied or decoded");
  // A decoded scan is re-encoded (WebP or PNG); only a copy keeps the PDF's JPEG stream.
  if (entry.source === "decode" && entry.format === "jpg") issue("a decoded scan is never a JPEG");
  if (entry.bytes > dopplerEntryFileCap(entry, ABSOLUTE_FILE_CAPS)) issue("image file over its size limit");
});
export type DopplerManifestV2Entry = z.infer<typeof dopplerManifestV2EntrySchema>;

export const dopplerManifestV2Schema = z.strictObject({
  version: z.literal(2),
  source_sha256: z.string().regex(SHA256),
  settings_sha256: z.string().regex(SHA256),
  resumes: z.number().int().min(0).max(1_000_000),
  resumable: z.boolean(),
  link_prefix: z.string().max(DOPPLER_MANIFEST_V2_LIMITS.maxLinkPrefixBytes).refine(isDopplerLinkPrefix, "invalid link prefix"),
  dpi: z.number().int().min(1).max(4800),
  min_side_pt: z.number().finite().min(0).max(1e6),
  repeats: z.enum(["skip", "link", "keep"]),
  scan_pages: z.enum(["image", "skip", "render"]),
  scan_dpi: z.number().int().min(1).max(4800),
  scan_max_dpi: z.number().int().min(1).max(4800),
  batch_pages: z.number().int().min(1).max(1_000_000_000),
  deadline_ms: z.number().int().min(0).max(24 * 3_600_000),
  complete: z.boolean(),
  batches: z.array(z.strictObject({
    pages: z.tuple([pageNumber, pageNumber]),
    status: z.enum(DOPPLER_BATCH_STATUSES),
    cut_page: pageNumber.optional(),
  }).refine((batch) => batch.pages[0] <= batch.pages[1] &&
      (batch.cut_page === undefined || (batch.cut_page >= batch.pages[0] && batch.cut_page <= batch.pages[1])), "batch pages out of order"))
    .max(DOPPLER_MANIFEST_V2_LIMITS.maxBatches),
  images: z.array(dopplerManifestV2EntrySchema).max(DOPPLER_MANIFEST_V2_LIMITS.maxEntries),
  totals: z.strictObject({
    images: count, linked: count, extracted: count, not_extracted: count, unlinked: count, bytes: count, repeats: count,
    fallbacks: count, scans: count, scan_bytes: count, batches: count, batches_cut: count,
  }),
}).superRefine((manifest, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const byId = new Map<string, DopplerManifestV2Entry>();
  const filePaths = new Set<string>();
  const sum = { files: 0, bytes: 0, linked: 0, repeats: 0, fallbacks: 0, scans: 0, scanBytes: 0, extracted: 0, notExtracted: 0, unlinked: 0 };
  for (const entry of manifest.images) {
    if (byId.has(entry.id)) issue("duplicate image id");
    byId.set(entry.id, entry);
    if (entry.link !== null && entry.path !== null && entry.link !== `${manifest.link_prefix}${entry.path}`) issue("link is not the prefix and the path");
    if (entry.path !== null) sum.linked += 1;
    if (entry.reason === "repeat") sum.repeats += 1;
    if (entry.fallback !== undefined) sum.fallbacks += 1;
    if (entry.status === "extracted") {
      // One file per path: a repeat links to its first placement's path and has no file of its own.
      if (filePaths.has(entry.path!)) issue("two images own one file");
      filePaths.add(entry.path!);
      sum.extracted += 1;
      sum.bytes += entry.bytes;
      if (entry.fate === "page-scan") { sum.scans += 1; sum.scanBytes += entry.bytes; }
    } else if (entry.status === "not-extracted") sum.notExtracted += 1;
    else sum.unlinked += 1;
  }
  for (const entry of manifest.images) {
    if (entry.repeat_of === undefined) continue;
    const target = byId.get(entry.repeat_of);
    // A repeat names an image of this manifest that is not itself a repeat (no chains, so no cycles), and shares its path.
    if (!target) issue("repeat_of names no image");
    else if (target.repeat_of !== undefined) issue("repeat_of names a repeat");
  }
  if (sum.extracted > DOPPLER_MANIFEST_V2_LIMITS.maxFiles) issue("too many image files");
  if (sum.bytes > DOPPLER_MANIFEST_V2_LIMITS.maxTotalBytes) issue("image files exceed their total limit");
  if (manifest.resumable !== manifest.images.some((entry) => entry.resumable === true)) issue("resumable disagrees with the images");
  if (manifest.complete) {
    // Complete: every batch finished and no image was left by a stopped batch.
    if (manifest.resumable) issue("a complete manifest has nothing to resume");
    if (manifest.batches.some((batch) => batch.status !== "ok")) issue("a complete manifest has a stopped batch");
    if (manifest.images.some((entry) => entry.reason !== undefined && (DOPPLER_BATCH_REASONS as readonly string[]).includes(entry.reason))) {
      issue("a complete manifest has images a stopped batch left");
    }
  }
  const totals = manifest.totals;
  if (totals.images !== manifest.images.length || totals.extracted !== sum.extracted || totals.not_extracted !== sum.notExtracted ||
      totals.unlinked !== sum.unlinked || totals.batches !== manifest.batches.length || totals.linked !== sum.linked ||
      totals.bytes !== sum.bytes || totals.repeats !== sum.repeats || totals.fallbacks !== sum.fallbacks || totals.scans !== sum.scans ||
      totals.scan_bytes !== sum.scanBytes || totals.batches_cut !== manifest.batches.filter((batch) => batch.status !== "ok").length) {
    issue("totals disagree with the images");
  }
});
export type DopplerManifestV2 = z.infer<typeof dopplerManifestV2Schema>;

/** A parsed manifest of either version. */
export type DopplerManifest = { version: 1; manifest: DopplerFigureManifest } | { version: 2; manifest: DopplerManifestV2 };

/** Parse a manifest (already JSON-decoded and size-checked by the caller) strictly, or return null. */
export function parseDopplerManifest(json: unknown): DopplerManifest | null {
  const version = (json as { version?: unknown } | null)?.version;
  if (version === 2) {
    const parsed = dopplerManifestV2Schema.safeParse(json);
    return parsed.success ? { version: 2, manifest: parsed.data } : null;
  }
  const parsed = dopplerFigureManifestSchema.safeParse(json);
  return parsed.success ? { version: 1, manifest: parsed.data } : null;
}

// ---- Ledger rows ----

/** One ledger row as the worker writes it: validated manifest fields only, never free text from the document. */
export const documentAssetSchema = z.strictObject({
  assetId: z.string().regex(DOPPLER_FIGURE_ID),
  pageNumber,
  kind: z.enum(DOPPLER_ASSET_KINDS),
  fate: z.enum(DOPPLER_LEDGER_FATES),
  status: z.enum(DOPPLER_ASSET_STATUSES),
  reason: z.enum(DOPPLER_LEDGER_REASONS).nullable(),
  resumable: z.boolean(),
  source: z.enum(DOPPLER_ASSET_SOURCES).nullable(),
  format: z.enum(DOPPLER_FIGURE_FORMATS).nullable(),
  bytes: z.number().int().min(1).max(DOPPLER_MANIFEST_V2_LIMITS.maxScanFileBytes).nullable(),
  sha256: z.string().regex(SHA256).nullable(),
  width: z.number().int().min(1).max(DOPPLER_FIGURE_LIMITS.maxSide).nullable(),
  height: z.number().int().min(1).max(DOPPLER_FIGURE_LIMITS.maxSide).nullable(),
  repeatOf: z.string().regex(DOPPLER_FIGURE_ID).nullable(),
  fallback: z.enum(DOPPLER_LEDGER_FALLBACKS).nullable(),
  /** The link as the Markdown holds it (`images/page-0003/image-001.webp`); null for version 1 and unlinked images. */
  linkPath: z.string().max(DOPPLER_MANIFEST_V2_LIMITS.maxLinkPrefixBytes + 64).refine(isDopplerAssetLink, "invalid link").nullable(),
  /** The id whose stored file this image shows (itself when it owns one); null when no file shows it. */
  fileOf: z.string().regex(DOPPLER_FIGURE_ID).nullable(),
  /** The image object (`[num, gen]`), when Doppler names it: with `sha256`, a key for repeats across runs. */
  obj: z.tuple([z.number().int().min(0).max(2_147_483_647), z.number().int().min(0).max(65_535)]).nullable(),
  /** Page points, y down, page rotation applied. */
  bbox: z.tuple([coordinate, coordinate, coordinate, coordinate]).nullable(),
}).superRefine((row, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if ((row.status === "not-extracted") !== (row.reason !== null)) issue("reason goes with not-extracted");
  if (row.resumable && row.status !== "not-extracted") issue("only a not-extracted image is resumable");
  if (row.status === "extracted" && (row.bytes === null || row.sha256 === null || row.format === null || row.fileOf !== row.assetId)) {
    issue("an extracted image owns a file");
  }
  if (row.status !== "extracted" && (row.bytes !== null || row.sha256 !== null || row.source !== null)) issue("no file, no file details");
  if (row.status === "unlinked" && row.linkPath !== null) issue("an unlinked image has no link");
  if (row.bytes !== null && row.bytes > dopplerEntryFileCap(row, ABSOLUTE_FILE_CAPS)) issue("image file over its size limit");
  if (row.source === "decode" && row.format === "jpg") issue("a decoded scan is never a JPEG");
  if ((row.source === "copy" || row.source === "decode") && row.fate !== "page-scan") issue("only page scans are copied or decoded");
});
export type DocumentAsset = z.infer<typeof documentAssetSchema>;

/** The text the PDF's Markdown is built from, and how far its images got. */
export const DOCUMENT_IMAGES_STATUSES = ["none", "complete", "partial", "resumable", "failed", "disabled"] as const;
export type DocumentImagesStatus = (typeof DOCUMENT_IMAGES_STATUSES)[number];
export const PAGE_TEXT_LAYERS = ["none", "invisible", "visible", "mixed"] as const;
export const PAGE_SCAN_CLASSES = ["none", "single", "tiled", "layered"] as const;

/** A Doppler build as the provider names it (a version or a commit). */
export const DOPPLER_BUILD = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;

/** Fields of a version 2 manifest the extraction level keeps; null for version 1. */
export interface DopplerManifestRunFacts {
  sourceSha256: string | null;
  settingsSha256: string | null;
  /** What the manifest says (telemetry only: the ledger counts resumes itself). */
  manifestResumes: number;
  lastCutPage: number | null;
  deadlineMs: number | null;
  complete: boolean;
  resumable: boolean;
}

function v1Fate(fate: string): DopplerLedgerFate {
  return (DOPPLER_ASSET_FATES as readonly string[]).includes(fate) ? fate as DopplerLedgerFate : "other";
}

const V1_SKIPPED: Readonly<Record<string, DopplerLedgerReason>> = {
  repeat: "repeat", "min-side": "min_side", min_side: "min_side", pages: "pages", bbox: "bbox", id: "id",
};

/**
 * Ledger rows for a parsed manifest: one per image, in manifest order. Version 1 maps with what it has: a file is
 * `extracted` (`copy` for a copied JPEG scan, else `render`), `skipped: fate` (an image Doppler placed without a marker)
 * is `unlinked`, a repeat or a known skip reason is `not-extracted` with that reason, an `error` is `error`, and any
 * other skip is `other`. Version 1 has no links, so `linkPath` is null.
 */
export function dopplerLedgerAssets(parsed: DopplerManifest): DocumentAsset[] {
  if (parsed.version === 2) {
    const owner = new Map<string, string>();
    for (const entry of parsed.manifest.images) if (entry.status === "extracted") owner.set(entry.path!, entry.id);
    return parsed.manifest.images.map((entry) => ({
      assetId: entry.id, pageNumber: entry.page, kind: entry.kind, fate: entry.fate, status: entry.status,
      reason: entry.reason ?? null, resumable: entry.resumable === true, source: entry.source,
      format: entry.status === "unlinked" ? null : entry.format,
      bytes: entry.status === "extracted" ? entry.bytes : null, sha256: entry.sha256,
      width: entry.status === "extracted" ? entry.width : null, height: entry.status === "extracted" ? entry.height : null,
      repeatOf: entry.repeat_of ?? null, fallback: entry.fallback ?? null, linkPath: entry.link,
      fileOf: entry.status === "extracted" ? entry.id : entry.path !== null ? owner.get(entry.path) ?? null : null,
      obj: entry.obj, bbox: entry.bbox,
    }));
  }
  return parsed.manifest.images.map((entry): DocumentAsset => {
    const base = {
      assetId: entry.id, pageNumber: entry.page, kind: entry.kind, fate: v1Fate(entry.fate), resumable: false, linkPath: null,
      repeatOf: entry.repeat_of ?? null, obj: null, bbox: entry.bbox,
      fallback: entry.fallback === undefined || entry.fallback === false ? null
        : typeof entry.fallback === "string" && (DOPPLER_ASSET_FALLBACKS as readonly string[]).includes(entry.fallback)
          ? entry.fallback as DopplerLedgerFallback : "other",
    } as const;
    if (entry.file !== null) {
      return {
        // Version 1 says nothing of how a file was made: only a page scan's JPEG is a copy of the PDF's stream.
        ...base, status: "extracted", reason: null, source: entry.format === "jpg" && base.fate === "page-scan" ? "copy" : "render", format: entry.format,
        bytes: entry.bytes, sha256: entry.sha256, width: Math.ceil(entry.width ?? 0) || null, height: Math.ceil(entry.height ?? 0) || null,
        fileOf: entry.id,
      };
    }
    const none = { source: null, bytes: null, sha256: null, width: null, height: null, format: null } as const;
    if (entry.skipped === "fate" && entry.repeat_of === undefined) return { ...base, ...none, status: "unlinked", reason: null, fileOf: null };
    const reason: DopplerLedgerReason = entry.repeat_of !== undefined ? "repeat"
      : entry.error !== undefined ? "error"
        : V1_SKIPPED[entry.skipped ?? ""] ?? "other";
    return { ...base, ...none, status: "not-extracted", reason, fileOf: entry.repeat_of ?? null };
  });
}

/** The run facts of a parsed manifest (version 1 has none beyond being complete). */
export function dopplerManifestRunFacts(parsed: DopplerManifest): DopplerManifestRunFacts {
  if (parsed.version === 1) {
    return { sourceSha256: null, settingsSha256: null, manifestResumes: 0, lastCutPage: null, deadlineMs: null, complete: true, resumable: false };
  }
  const m = parsed.manifest;
  const cut = m.batches.filter((batch) => batch.cut_page !== undefined).at(-1)?.cut_page ?? null;
  return {
    sourceSha256: m.source_sha256, settingsSha256: m.settings_sha256, manifestResumes: m.resumes, lastCutPage: cut,
    deadlineMs: m.deadline_ms, complete: m.complete, resumable: m.resumable,
  };
}

/** Counts per status and source over ledger rows (what the extraction level stores). */
export interface DocumentAssetCounts {
  total: number;
  extracted: number;
  notExtracted: number;
  unlinked: number;
  resumable: number;
  sourceCopy: number;
  sourceDecode: number;
  sourceRender: number;
  bytes: number;
}

export function documentAssetCounts(rows: readonly DocumentAsset[]): DocumentAssetCounts {
  const counts: DocumentAssetCounts = { total: rows.length, extracted: 0, notExtracted: 0, unlinked: 0, resumable: 0, sourceCopy: 0, sourceDecode: 0, sourceRender: 0, bytes: 0 };
  for (const row of rows) {
    if (row.status === "extracted") counts.extracted += 1;
    else if (row.status === "not-extracted") counts.notExtracted += 1;
    else counts.unlinked += 1;
    if (row.resumable) counts.resumable += 1;
    if (row.source === "copy") counts.sourceCopy += 1;
    else if (row.source === "decode") counts.sourceDecode += 1;
    else if (row.source === "render") counts.sourceRender += 1;
    counts.bytes += row.bytes ?? 0;
  }
  return counts;
}

/*
 * Doppler figure extraction (`pdftomarkdown --images-dir`): the contract between the sandboxed PDF provider and the
 * worker, and the `doppler-image:` markers Doppler leaves in its Markdown.
 *
 * Doppler crops every kept picture (`pN.M`) and vector drawing (`pN.gK`) of a page inside the PDF VM and writes one file
 * per figure (`<id>.webp`, `<id>.svg` or `<id>.png`) plus `manifest.json`. The provider hands that folder to the worker,
 * which validates it here, strictly and with bounds, before any byte reaches storage: file names are derived from ids,
 * never taken from the folder; sizes and hashes must match; only the leading signature bytes are looked at (the SVG
 * allowlist already ran in the VM). The Markdown keeps Doppler's markers byte for byte; a reader resolves
 * `![image](doppler-image:<id>)` to the figure's served URL at read time (see `resolveDopplerImageMarkers`).
 *
 * Design: docs/extraction/doppler-figures.md.
 */
import { z } from "zod";

/** The worker flag that turns figure extraction on for VM PDF runs (default off). */
export const DOPPLER_IMAGE_EXTRACT_ENV = "DOCSLURP_DOPPLER_IMAGE_EXTRACT";
/** The wire version of the manifest the provider hands the worker. */
export const DOPPLER_FIGURES_VERSION = "doppler-figures@1";
export const DOPPLER_FIGURES_MANIFEST = "manifest.json";
export const DOPPLER_IMAGE_SCHEME = "doppler-image:";

/** `p<page>.<n>` (raster) or `p<page>.g<n>` (vector), as Doppler numbers them. */
export const DOPPLER_FIGURE_ID = /^p([1-9][0-9]{0,8})\.(g?)(0|[1-9][0-9]{0,5})$/;
export const DOPPLER_FIGURE_FORMATS = ["webp", "svg", "png"] as const;
export type DopplerFigureFormat = (typeof DOPPLER_FIGURE_FORMATS)[number];
/** Fixed content types: served exactly as these, never as anything the bytes or the storage metadata claim. */
export const DOPPLER_FIGURE_MEDIA_TYPES: Readonly<Record<DopplerFigureFormat, string>> = {
  webp: "image/webp",
  svg: "image/svg+xml",
  png: "image/png",
};

/** Host-side bounds. The guest has its own; these hold whatever it sends. */
export const DOPPLER_FIGURE_LIMITS = {
  /** Manifest entries (figures with or without a file) per document. */
  maxEntries: 4096,
  /** Files per document. */
  maxFiles: 2048,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
  maxManifestBytes: 4 * 1024 * 1024,
  /** Pixel or point side of one figure. */
  maxSide: 16_384,
} as const;

export interface ParsedDopplerFigureId { id: string; pageNumber: number; vector: boolean; index: number }

export function parseDopplerFigureId(id: string): ParsedDopplerFigureId | null {
  const m = typeof id === "string" ? DOPPLER_FIGURE_ID.exec(id) : null;
  if (!m) return null;
  return { id, pageNumber: Number(m[1]), vector: m[2] === "g", index: Number(m[3]) };
}

/** The only name a figure's file may have: derived from its id and format, never read from the folder or the manifest. */
export function dopplerFigureFileName(id: string, format: DopplerFigureFormat): string {
  if (!parseDopplerFigureId(id) || !DOPPLER_FIGURE_FORMATS.includes(format)) throw new Error("Invalid Doppler figure id or format");
  return `${id}.${format}`;
}

/** Every name a valid folder may hold: the manifest, and `<id>.<format>` files. */
export const DOPPLER_FIGURE_FILE_NAME = /^p[1-9][0-9]{0,8}\.g?(?:0|[1-9][0-9]{0,5})\.(?:webp|svg|png)$/;

const slug = z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,63}$/);
const coordinate = z.number().finite().min(-1e7).max(1e7);
const side = z.number().finite().positive().max(DOPPLER_FIGURE_LIMITS.maxSide);

/** One figure as the provider reports it (Doppler's manifest fields, `null` where a figure has no file). */
export const dopplerFigureEntrySchema = z.strictObject({
  id: z.string().regex(DOPPLER_FIGURE_ID),
  page: z.number().int().min(1).max(1_000_000_000),
  /** Page points, y down, page rotation applied: the frame of Doppler's word boxes. */
  bbox: z.tuple([coordinate, coordinate, coordinate, coordinate]).refine(([x0, y0, x1, y1]) => x1 > x0 && y1 > y0, "bbox must be ordered"),
  kind: z.enum(["picture", "mask", "vector"]),
  /** Where Doppler placed it (`block`, `inline`, `grouped`, `furniture`, ...): only `file` says whether it was extracted. */
  fate: slug,
  file: z.string().max(64).nullable(),
  format: z.enum(DOPPLER_FIGURE_FORMATS).nullable(),
  bytes: z.number().int().min(0).max(DOPPLER_FIGURE_LIMITS.maxFileBytes).nullable(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  /** Pixels for a raster file; points for an SVG. */
  width: side.nullable(),
  height: side.nullable(),
  /** The figure whose file this one reuses (identical image drawn again). */
  repeat_of: z.string().regex(DOPPLER_FIGURE_ID).optional(),
  /** Why the file is not in the figure's natural format (a vector drawing rasterised, for example). */
  fallback: z.union([z.boolean(), slug]).optional(),
  /** Why this figure has no file, when extraction failed for it alone. */
  error: slug.optional(),
}).superRefine((entry, ctx) => {
  const id = parseDopplerFigureId(entry.id);
  if (!id || id.pageNumber !== entry.page) ctx.addIssue({ code: "custom", message: "figure id does not match its page" });
  if (id && id.vector !== (entry.kind === "vector")) ctx.addIssue({ code: "custom", message: "figure id does not match its kind" });
  if (entry.file !== null) {
    if (entry.format === null || entry.file !== `${entry.id}.${entry.format}`) ctx.addIssue({ code: "custom", message: "figure file name is not derived from its id" });
    if (entry.bytes === null || entry.bytes < 1 || entry.sha256 === null || entry.width === null || entry.height === null) {
      ctx.addIssue({ code: "custom", message: "figure file needs bytes, sha256, width and height" });
    }
    if (entry.format !== "svg" && ((entry.width !== null && !Number.isInteger(entry.width)) || (entry.height !== null && !Number.isInteger(entry.height)))) {
      ctx.addIssue({ code: "custom", message: "raster figure size must be whole pixels" });
    }
    if (entry.repeat_of !== undefined) ctx.addIssue({ code: "custom", message: "a repeat has no file of its own" });
  } else if ((entry.bytes ?? 0) !== 0 || entry.sha256 !== null) {
    ctx.addIssue({ code: "custom", message: "figure without a file reports bytes or a hash" });
  }
});
export type DopplerFigureEntry = z.infer<typeof dopplerFigureEntrySchema>;

export const dopplerFigureManifestSchema = z.strictObject({
  version: z.literal(DOPPLER_FIGURES_VERSION),
  images: z.array(dopplerFigureEntrySchema).max(DOPPLER_FIGURE_LIMITS.maxEntries),
}).superRefine((manifest, ctx) => {
  const byId = new Map<string, DopplerFigureEntry>();
  let files = 0;
  let total = 0;
  for (const entry of manifest.images) {
    if (byId.has(entry.id)) ctx.addIssue({ code: "custom", message: "duplicate figure id" });
    byId.set(entry.id, entry);
    if (entry.file !== null) {
      files += 1;
      total += entry.bytes ?? 0;
    }
  }
  if (files > DOPPLER_FIGURE_LIMITS.maxFiles) ctx.addIssue({ code: "custom", message: "too many figure files" });
  if (total > DOPPLER_FIGURE_LIMITS.maxTotalBytes) ctx.addIssue({ code: "custom", message: "figure files exceed their total limit" });
  for (const entry of manifest.images) {
    if (entry.repeat_of === undefined) continue;
    const target = byId.get(entry.repeat_of);
    if (!target || target.file === null || target.id === entry.id) ctx.addIssue({ code: "custom", message: "repeat_of names no extracted figure" });
  }
});
export type DopplerFigureManifest = z.infer<typeof dopplerFigureManifestSchema>;

/** One stored figure, as the worker records it in the document's `doppler-figures` index artifact. */
export const dopplerFigureRecordSchema = z.strictObject({
  id: z.string().regex(DOPPLER_FIGURE_ID),
  page: z.number().int().min(1),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  kind: z.enum(["picture", "mask", "vector"]),
  fate: slug,
  format: z.enum(DOPPLER_FIGURE_FORMATS).nullable(),
  mediaType: z.string().nullable(),
  bytes: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  /** The id whose stored file this figure shows (itself when it has its own file); null when none. */
  fileOf: z.string().regex(DOPPLER_FIGURE_ID).nullable(),
  /** Document artifact slot of the file (`doppler-figure:<id>`), resolvable through the document's artifacts; null when none. */
  slot: z.string().nullable(),
  fallback: z.union([z.boolean(), slug]).optional(),
  error: slug.optional(),
});
export type DopplerFigureRecord = z.infer<typeof dopplerFigureRecordSchema>;

export const DOPPLER_FIGURES_INDEX_VERSION = "docslurp-doppler-figures@1";

/** The artifact slot (without the `<documentId>:` prefix) a figure's file is recorded under. */
export function dopplerFigureSlot(id: string): string {
  if (!parseDopplerFigureId(id)) throw new Error("Invalid Doppler figure id");
  return `doppler-figure:${id}`;
}

/** The `doppler-figures` index slot of a document. */
export const DOPPLER_FIGURES_INDEX_SLOT = "doppler-figures";

// ---- Markers in Markdown ----

const MARKER = /!\[((?:[^\]\\\n]|\\.){0,200})\]\(doppler-image:(p[1-9][0-9]{0,8}\.g?(?:0|[1-9][0-9]{0,5}))\)/g;
const MARKER_LINE = /^!\[((?:[^\]\\\n]|\\.){0,200})\]\(doppler-image:(p[1-9][0-9]{0,8}\.g?(?:0|[1-9][0-9]{0,5}))\)$/;

/** A whole line that is one Doppler image marker, or null. */
export function parseDopplerImageMarkerLine(line: string): { alt: string; id: string } | null {
  const m = MARKER_LINE.exec(line.trim());
  return m ? { alt: m[1]!.replace(/\\([\\[\]])/g, "$1"), id: m[2]! } : null;
}

/** The figure ids the Markdown's markers name, in order of first appearance. */
export function dopplerImageMarkerIds(markdown: string): string[] {
  const seen = new Set<string>();
  for (const m of markdown.matchAll(MARKER)) seen.add(m[2]!);
  return [...seen];
}

/** A URL safe inside a Markdown link destination: no spaces, parentheses or angle brackets. */
function markdownUrl(url: string): string {
  return url.replace(/[\s()<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/**
 * Rewrite markers for display: a marker whose id `resolve` maps to a URL links to it; any other marker is removed
 * (its alt text is Doppler's generic "image"). Only ids the stored index lists should resolve: the PDF's own text
 * could imitate a marker, so a resolver must never build a URL from the id alone.
 */
export function resolveDopplerImageMarkers(markdown: string, resolve: (id: string) => string | null | undefined): string {
  if (!markdown.includes(DOPPLER_IMAGE_SCHEME)) return markdown;
  return markdown.replace(MARKER, (_match, alt: string, id: string) => {
    const url = resolve(id);
    return url ? `![${alt}](${markdownUrl(url)})` : "";
  });
}

/** Text for search and embeddings: markers carry no words (Doppler's alt is the generic "image"), so they go. */
export function stripDopplerImageMarkers(markdown: string): string {
  if (!markdown.includes(DOPPLER_IMAGE_SCHEME)) return markdown;
  return markdown.replace(MARKER, "");
}

/**
 * Map figure ids to URLs from a document's artifact list (`{ slot, url }`, as the document detail returns it). Slots are
 * `<documentId>:doppler-figure:<id>`; a figure that reuses another's file resolves through the index's `fileOf`.
 */
export function dopplerFigureUrls(
  documentId: string,
  artifacts: ReadonlyArray<{ slot: string; url: string }>,
  records?: ReadonlyArray<Pick<DopplerFigureRecord, "id" | "fileOf">>,
): Map<string, string> {
  const prefix = `${documentId}:doppler-figure:`;
  const byFile = new Map<string, string>();
  for (const artifact of artifacts) {
    if (!artifact.slot.startsWith(prefix) || !artifact.url) continue;
    const id = artifact.slot.slice(prefix.length);
    if (parseDopplerFigureId(id)) byFile.set(id, artifact.url);
  }
  if (!records) return byFile;
  const urls = new Map<string, string>();
  for (const record of records) {
    const url = record.fileOf ? byFile.get(record.fileOf) : undefined;
    if (url) urls.set(record.id, url);
  }
  return urls;
}

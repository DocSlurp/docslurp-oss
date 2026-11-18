/**
 * Per-page PDF sizes (the CropBox, in points) for bounded rasterization and rendered-area billing, measured once per
 * document source and reused across stages, instead of one sandboxed `pdfinfo` per render call.
 *
 * Every size here is bound to the exact bytes it measured: the document, its source key and the SHA-256 of the staged
 * source (PdfSourceCache hashes the staged file and checks it against the server's hash), within one run. Three places
 * hold them, read in this order:
 * 1. an in-process memo (bounded by total pages), shared by every raster cache in the worker process;
 * 2. a run-scoped artifact under the document's artifact root, so another stage or worker reuses them;
 * 3. `pdfinfo`, in the parser sandbox: the fallback for any page the first two do not hold.
 *
 * Doubt fails closed to `pdfinfo`: an unreadable, oversized, malformed or foreign artifact, or a page it does not list,
 * is simply not known. Reuse never invents a size and never widens a scope: the memo key and the artifact both carry the
 * run, the requester, the document and the source hash.
 *
 * Doppler page facts (DOCSLURP_PAGE_FACTS_RASTER_SIZES=on, off by default) can stand in for `pdfinfo`. Their
 * `geometry` is Poppler's own clipped CropBox (the same `Page::getCropBox()` that `pdfinfo` prints and `pdftoppm -cropbox`
 * renders), swapped for a 90/270 rotation and rounded to 0.01 pt. A page is taken from the facts only when that rounding
 * cannot change what it bills (pageSizesFromDopplerFacts); anything else is measured by `pdfinfo`.
 */
import { pageAreaEquivalentsPt } from "@docslurp/shared";

import { documentArtifactRoot } from "../lib/artifact-root.js";
import { dopplerPageFactsLowConfidence, type DopplerPageFactsDocument } from "../lib/doppler-page-facts.js";
import type { Document } from "../models.js";

export interface PdfPageSize {
  widthPt: number;
  heightPt: number;
}

/** Who measured a size. Each source has its own artifact; a reader asks for the sources it trusts. */
export type PageSizeSource = "pdfinfo" | "page-facts";

export const PAGE_SIZES_SCHEMA = "docslurp-pdf-page-sizes/1";
/** Pages one `pdfinfo` call measures: aligned blocks, so a later stage's page is usually already measured. */
export const PAGE_SIZE_BLOCK_PAGES = 4_096;
/** Largest page side a stored size may claim (pdfinfo's sizes are passed through as measured; facts are bounded lower). */
export const PAGE_SIZE_MAX_SIDE_PT = 1_000_000;
/** Page facts' side bounds (the layout reader's, parsePageLayoutFacts): outside them the page is measured by pdfinfo. */
export const FACTS_MIN_SIDE_PT = 1;
export const FACTS_MAX_SIDE_PT = 14_400;
/** Doppler writes page points with 2 decimals, correctly rounded (`std::to_chars` fixed): at most this far off. */
const FACTS_ROUNDING_PT = 0.005;
/** The memo's bound across every document it holds. */
export const PAGE_SIZE_MEMO_MAX_PAGES = 250_000;
const PAGE_SIZE_MEMO_MAX_DOCUMENTS = 256;
/** Pages an artifact may list (the facts reader's own page bound). */
const PAGE_SIZE_ARTIFACT_MAX_PAGES = 100_000;

/** Reuse of measured sizes (memo and artifact): on unless DOCSLURP_RASTER_PAGE_SIZE_REUSE=off. */
export function readPageSizeReuse(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DOCSLURP_RASTER_PAGE_SIZE_REUSE?.trim().toLowerCase() !== "off";
}

/** Sizes from Doppler page facts in place of pdfinfo: off unless DOCSLURP_PAGE_FACTS_RASTER_SIZES=on (needs reuse on). */
export function readPageFactsRasterSizes(env: NodeJS.ProcessEnv = process.env): boolean {
  return readPageSizeReuse(env) && env.DOCSLURP_PAGE_FACTS_RASTER_SIZES?.trim().toLowerCase() === "on";
}

/** The exact source a size describes: one run's document, by its staged bytes' SHA-256. */
export interface PageSizeBinding {
  runId: string;
  userId: string;
  documentId: string;
  sourceKey: string;
  sourceSha256: string;
  pageCount: number;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** The binding for `document`'s staged source in `runId`, or null when any part is missing (no reuse then). */
export function pageSizeBinding(document: Pick<Document, "id" | "userId" | "sourceKey" | "pageCount">, runId: string | undefined, sourceSha256: string): PageSizeBinding | null {
  const pageCount = Math.floor(Number(document.pageCount));
  if (!runId || !document.userId || !document.id || !document.sourceKey || !SHA256.test(sourceSha256)) return null;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > PAGE_SIZE_ARTIFACT_MAX_PAGES) return null;
  return { runId, userId: document.userId, documentId: document.id, sourceKey: document.sourceKey, sourceSha256, pageCount };
}

function bindingKey(binding: PageSizeBinding, source: PageSizeSource): string {
  return JSON.stringify([source, binding.runId, binding.userId, binding.documentId, binding.sourceKey, binding.sourceSha256, binding.pageCount]);
}

/** The run-scoped artifact holding `source`'s sizes for this exact source. */
export function pageSizesArtifactKey(
  document: Pick<Document, "id" | "userId" | "runId" | "artifactRoot">,
  binding: PageSizeBinding,
  source: PageSizeSource,
): string {
  return `${documentArtifactRoot(document, binding.runId)}/page-sizes/${binding.documentId}/${source}-${binding.sourceSha256}.json`;
}

/** Most bytes an artifact for `pageCount` pages may hold (a page entry is at most ~40 bytes). */
export function pageSizesArtifactMaxBytes(pageCount: number): number {
  return 1_024 + 48 * Math.max(1, Math.min(pageCount, PAGE_SIZE_ARTIFACT_MAX_PAGES));
}

function validSide(value: unknown, source: PageSizeSource): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  return source === "page-facts"
    ? value >= FACTS_MIN_SIDE_PT && value <= FACTS_MAX_SIDE_PT
    : value > 0 && value <= PAGE_SIZE_MAX_SIDE_PT;
}

/** A size worth keeping from `source`: positive, finite and within that source's bounds. */
export function storablePageSize(size: PdfPageSize | undefined, source: PageSizeSource): size is PdfPageSize {
  return !!size && validSide(size.widthPt, source) && validSide(size.heightPt, source);
}

export function serializePageSizes(binding: PageSizeBinding, source: PageSizeSource, sizes: ReadonlyMap<number, PdfPageSize>): Buffer {
  const pages = [...sizes]
    .filter(([page, size]) => Number.isSafeInteger(page) && page >= 1 && page <= binding.pageCount && storablePageSize(size, source))
    .sort(([a], [b]) => a - b)
    .map(([page, size]) => [page, size.widthPt, size.heightPt]);
  return Buffer.from(JSON.stringify({
    schema: PAGE_SIZES_SCHEMA,
    source,
    runId: binding.runId,
    userId: binding.userId,
    documentId: binding.documentId,
    sourceKey: binding.sourceKey,
    sourceSha256: binding.sourceSha256,
    pageCount: binding.pageCount,
    pages,
  }), "utf8");
}

export type PageSizesParse =
  | { ok: true; sizes: Map<number, PdfPageSize> }
  | { ok: false; reason: "oversized" | "malformed" | "schema" | "binding" | "page" };

/**
 * An artifact's sizes, only when every bound field equals `binding` and every page entry validates: one bad entry refuses
 * the whole artifact (it was not written by this code, so none of it is trusted).
 */
export function parsePageSizesArtifact(bytes: Uint8Array, binding: PageSizeBinding, source: PageSizeSource): PageSizesParse {
  if (bytes.byteLength > pageSizesArtifactMaxBytes(binding.pageCount)) return { ok: false, reason: "oversized" };
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "malformed" };
  const record = value as Record<string, unknown>;
  if (record.schema !== PAGE_SIZES_SCHEMA || record.source !== source) return { ok: false, reason: "schema" };
  if (record.runId !== binding.runId || record.userId !== binding.userId || record.documentId !== binding.documentId
    || record.sourceKey !== binding.sourceKey || record.sourceSha256 !== binding.sourceSha256 || record.pageCount !== binding.pageCount) {
    return { ok: false, reason: "binding" };
  }
  if (!Array.isArray(record.pages) || record.pages.length > binding.pageCount) return { ok: false, reason: "page" };
  const sizes = new Map<number, PdfPageSize>();
  for (const entry of record.pages) {
    if (!Array.isArray(entry) || entry.length !== 3) return { ok: false, reason: "page" };
    const [page, widthPt, heightPt] = entry as unknown[];
    if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1 || page > binding.pageCount || sizes.has(page)) return { ok: false, reason: "page" };
    const size = { widthPt: widthPt as number, heightPt: heightPt as number };
    if (!storablePageSize(size, source)) return { ok: false, reason: "page" };
    sizes.set(page, size);
  }
  return { ok: true, sizes };
}

interface MemoEntry {
  sizes: Map<number, PdfPageSize>;
  lastAccess: number;
}

/**
 * Process-wide memo of measured sizes, keyed by source and binding (run, requester, document, source key and hash), and
 * bounded by total pages across documents (least recently used first). Never holds a size outside its source's bounds.
 */
export class PdfPageSizeMemo {
  private readonly entries = new Map<string, MemoEntry>();
  private pages = 0;
  private tick = 0;

  constructor(private readonly maxPages = PAGE_SIZE_MEMO_MAX_PAGES, private readonly maxDocuments = PAGE_SIZE_MEMO_MAX_DOCUMENTS) {}

  get size(): { documents: number; pages: number } {
    return { documents: this.entries.size, pages: this.pages };
  }

  /** The known sizes of `pages` (any not held are absent). */
  get(binding: PageSizeBinding, source: PageSizeSource, pages: Iterable<number>): Map<number, PdfPageSize> {
    const out = new Map<number, PdfPageSize>();
    const entry = this.entries.get(bindingKey(binding, source));
    if (!entry) return out;
    entry.lastAccess = ++this.tick;
    for (const page of pages) {
      const size = entry.sizes.get(page);
      if (size) out.set(page, size);
    }
    return out;
  }

  /** Every size held for this binding (for writing the artifact). */
  all(binding: PageSizeBinding, source: PageSizeSource): Map<number, PdfPageSize> {
    return new Map(this.entries.get(bindingKey(binding, source))?.sizes ?? []);
  }

  set(binding: PageSizeBinding, source: PageSizeSource, sizes: ReadonlyMap<number, PdfPageSize>): void {
    const key = bindingKey(binding, source);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { sizes: new Map(), lastAccess: 0 };
      this.entries.set(key, entry);
    }
    entry.lastAccess = ++this.tick;
    for (const [page, size] of sizes) {
      if (!Number.isSafeInteger(page) || page < 1 || page > binding.pageCount || !storablePageSize(size, source)) continue;
      if (!entry.sizes.has(page)) this.pages += 1;
      entry.sizes.set(page, { widthPt: size.widthPt, heightPt: size.heightPt });
    }
    this.evict(key);
  }

  clear(): void {
    this.entries.clear();
    this.pages = 0;
  }

  private evict(keep: string): void {
    while ((this.pages > this.maxPages || this.entries.size > this.maxDocuments) && this.entries.size > 0) {
      let oldest: [string, MemoEntry] | null = null;
      for (const candidate of this.entries) {
        if (candidate[0] === keep && this.entries.size > 1) continue;
        if (!oldest || candidate[1].lastAccess < oldest[1].lastAccess) oldest = candidate;
      }
      if (!oldest) return;
      this.entries.delete(oldest[0]);
      this.pages -= oldest[1].sizes.size;
    }
  }
}

/**
 * One measurement of a block at a time per binding in this process: a concurrent render of another page in the same block
 * waits for it instead of starting its own VM. A waiter whose own signal aborts stops waiting; a failed shared measurement
 * is never reused (the waiter measures for itself).
 */
const inflight = new Map<string, Promise<Map<number, PdfPageSize>>>();

export async function sharedBlockMeasurement(
  binding: PageSizeBinding | null,
  block: { first: number; last: number },
  signal: AbortSignal,
  measure: () => Promise<Map<number, PdfPageSize>>,
): Promise<{ sizes: Map<number, PdfPageSize>; measured: boolean }> {
  const key = binding ? `${bindingKey(binding, "pdfinfo")}|${block.first}|${block.last}` : null;
  const pending = key ? inflight.get(key) : undefined;
  if (pending) {
    try {
      return { sizes: await abortable(pending, signal), measured: false };
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
  const own = measure();
  if (key && !inflight.has(key)) {
    inflight.set(key, own);
    own.catch(() => undefined).finally(() => { if (inflight.get(key) === own) inflight.delete(key); });
  }
  return { sizes: await own, measured: true };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

let processMemo: PdfPageSizeMemo | null = null;

/** The worker process's memo (every raster cache and extract-markdown share it). */
export function pdfPageSizeMemo(): PdfPageSizeMemo {
  processMemo ??= new PdfPageSizeMemo();
  return processMemo;
}

/** Aligned PAGE_SIZE_BLOCK_PAGES blocks covering `pages`, each clamped to 1..pageCount (one pdfinfo call each). */
export function pageSizeBlocks(pages: Iterable<number>, pageCount: number, block = PAGE_SIZE_BLOCK_PAGES): Array<{ first: number; last: number }> {
  const max = Math.max(1, Math.floor(pageCount));
  const starts = new Set<number>();
  for (const page of pages) {
    if (!Number.isSafeInteger(page) || page < 1) continue;
    starts.add(Math.floor((page - 1) / block) * block + 1);
  }
  return [...starts].sort((a, b) => a - b).map((first) => ({ first, last: Math.min(first + block - 1, Math.max(max, first)) }));
}

/** The most `pdfinfo`'s `%g` (6 significant digits) can print above the true value `side`. */
function pdfinfoPrintSlack(side: number): number {
  return 0.5 * 10 ** (Math.floor(Math.log10(Math.max(side, 1))) - 5);
}

export type FactsSizeSkip = "failed" | "xref" | "no-geometry" | "out-of-range" | "ambiguous";

/**
 * Page sizes from Doppler page facts, in `pdfinfo`'s orientation, for the pages whose bill the facts settle. The facts'
 * `geometry` is Poppler's clipped CropBox (`Page::getCropBox()`: a CropBox wider or taller than the MediaBox takes the
 * MediaBox's span on that axis, then both are intersected), the same box `pdfinfo` prints and `pdftoppm -cropbox` renders;
 * UserUnit is ignored by all three. Two differences remain, both handled here:
 * - rotation: the facts swap the sides for 90/270 (Doppler rounds any /Rotate to the nearest quarter turn), `pdfinfo` does
 *   not. Area and long edge do not depend on orientation; the swap is undone so the sizes read as `pdfinfo`'s.
 * - precision: the facts are rounded to 0.01 pt, `pdfinfo` prints 6 significant digits. A page is kept only when its area
 *   equivalents at the facts' size equal those at the largest size `pdfinfo` could print for the same box, so the facts
 *   never bill less than `pdfinfo` would. A page exactly on a boundary (US Letter, Tabloid: 1 and 2 standard pages) is
 *   ambiguous and left to `pdfinfo`.
 * Nothing is taken from a document the facts could not open, that is locked or whose cross-reference table was rebuilt, a
 * failed page, a page whose objects may come from a rebuilt table, a page without geometry, or a side outside 1..14,400 pt.
 */
export function pageSizesFromDopplerFacts(
  facts: Pick<DopplerPageFactsDocument, "doc" | "pages">,
  pageCount: number,
): { sizes: Map<number, PdfPageSize>; skipped: Partial<Record<FactsSizeSkip, number>> } {
  const sizes = new Map<number, PdfPageSize>();
  const skipped: Partial<Record<FactsSizeSkip, number>> = {};
  const skip = (reason: FactsSizeSkip) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  if (facts.doc.error || facts.doc.locked || facts.doc.encryption === "user-password-required" || facts.doc.xref === "repaired") return { sizes, skipped };
  for (const [number, page] of facts.pages) {
    if (!Number.isSafeInteger(number) || number < 1 || number > pageCount || page.page !== number) continue;
    if (page.failed) { skip("failed"); continue; }
    if (dopplerPageFactsLowConfidence(page) || page.parseWarnings.includes("xref-repaired")) { skip("xref"); continue; }
    const g = page.geometry;
    if (!g) { skip("no-geometry"); continue; }
    const swapped = g.rotation === 90 || g.rotation === 270;
    const size = { widthPt: swapped ? g.heightPt : g.widthPt, heightPt: swapped ? g.widthPt : g.heightPt };
    if (!storablePageSize(size, "page-facts")) { skip("out-of-range"); continue; }
    const billed = pageAreaEquivalentsPt(size.widthPt, size.heightPt);
    const upper = pageAreaEquivalentsPt(
      size.widthPt + FACTS_ROUNDING_PT + pdfinfoPrintSlack(size.widthPt + FACTS_ROUNDING_PT),
      size.heightPt + FACTS_ROUNDING_PT + pdfinfoPrintSlack(size.heightPt + FACTS_ROUNDING_PT),
    );
    if (upper !== billed) { skip("ambiguous"); continue; }
    sizes.set(number, size);
  }
  return { sizes, skipped };
}

/**
 * Store a run's Doppler page-facts sizes for later raster stages (extract-markdown, DOCSLURP_PAGE_FACTS_RASTER_SIZES=on):
 * seeds this process's memo and writes the run-scoped `page-facts` artifact, both bound to the staged source the facts
 * were measured on (`sourceSha256`, the hash PdfSourceCache verified). Best effort: a failed write is logged, and a
 * render then measures with pdfinfo. Null when nothing is bound or no page qualifies.
 */
export async function storePageFactsRasterSizes(args: {
  storage: { putBytes(key: string, data: Uint8Array, contentType: string): Promise<void> };
  document: Pick<Document, "id" | "userId" | "runId" | "artifactRoot" | "sourceKey" | "pageCount">;
  runId: string;
  sourceSha256: string;
  facts: Pick<DopplerPageFactsDocument, "doc" | "pages">;
  memo?: PdfPageSizeMemo;
}): Promise<{ stored: number; skipped: Partial<Record<FactsSizeSkip, number>> } | null> {
  const binding = pageSizeBinding(args.document, args.runId, args.sourceSha256);
  if (!binding) return null;
  const { sizes, skipped } = pageSizesFromDopplerFacts(args.facts, binding.pageCount);
  if (sizes.size === 0) return { stored: 0, skipped };
  (args.memo ?? pdfPageSizeMemo()).set(binding, "page-facts", sizes);
  try {
    await args.storage.putBytes(pageSizesArtifactKey(args.document, binding, "page-facts"), serializePageSizes(binding, "page-facts", sizes), "application/json");
  } catch (error) {
    console.warn(`[raster-page-sizes] document=${binding.documentId} source=page-facts status=store-failed error=${error instanceof Error ? error.name : "unknown"}`);
  }
  return { stored: sizes.size, skipped };
}

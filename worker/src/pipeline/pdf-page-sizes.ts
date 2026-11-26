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
 */
import { documentArtifactRoot } from "../lib/artifact-root.js";
import type { Document } from "../models.js";
import { isCommandTeardownError } from "../sandbox/teardown.js";

export interface PdfPageSize {
  widthPt: number;
  heightPt: number;
}

export const PAGE_SIZES_SCHEMA = "docslurp-pdf-page-sizes/1";
/** Pages one `pdfinfo` call measures: aligned blocks, so a later stage's page is usually already measured. */
export const PAGE_SIZE_BLOCK_PAGES = 4_096;
/** Largest page side a stored size may claim. */
export const PAGE_SIZE_MAX_SIDE_PT = 1_000_000;
/** The memo's bound across every document it holds. */
export const PAGE_SIZE_MEMO_MAX_PAGES = 250_000;
const PAGE_SIZE_MEMO_MAX_DOCUMENTS = 256;
/** Pages an artifact may list. */
const PAGE_SIZE_ARTIFACT_MAX_PAGES = 100_000;

/** Reuse of measured sizes (memo and artifact): on unless DOCSLURP_RASTER_PAGE_SIZE_REUSE=off. */
export function readPageSizeReuse(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DOCSLURP_RASTER_PAGE_SIZE_REUSE?.trim().toLowerCase() !== "off";
}

/** The exact source a size describes: one run's document, by its staged bytes' SHA-256. */
export interface PageSizeBinding {
  runId: string;
  userId: string;
  documentId: string;
  sourceKey: string;
  sourceSha256: string;
  artifactRoot: string;
  pageCount: number;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** The binding for `document`'s staged source in `runId`, or null when any part is missing (no reuse then). */
export function pageSizeBinding(document: Pick<Document, "id" | "userId" | "runId" | "artifactRoot" | "sourceKey" | "pageCount">, runId: string | undefined, sourceSha256: string): PageSizeBinding | null {
  const { pageCount } = document;
  if (!runId || !document.userId || !document.id || !document.sourceKey || !SHA256.test(sourceSha256)) return null;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > PAGE_SIZE_ARTIFACT_MAX_PAGES) return null;
  return { runId, userId: document.userId, documentId: document.id, sourceKey: document.sourceKey, sourceSha256, pageCount, artifactRoot: documentArtifactRoot(document, runId) };
}

function bindingKey(binding: PageSizeBinding): string {
  return JSON.stringify([binding.artifactRoot, binding.runId, binding.userId, binding.documentId, binding.sourceKey, binding.sourceSha256, binding.pageCount]);
}

/** The run-scoped artifact holding pdfinfo measurements of this exact source. */
export function pageSizesArtifactKey(binding: PageSizeBinding): string {
  return `${binding.artifactRoot}/page-sizes/${binding.documentId}/pdfinfo-${binding.sourceSha256}.json`;
}

/** Most bytes an artifact for `pageCount` pages may hold (a page entry is at most ~40 bytes). */
export function pageSizesArtifactMaxBytes(pageCount: number): number {
  return 1_024 + 48 * Math.max(1, Math.min(pageCount, PAGE_SIZE_ARTIFACT_MAX_PAGES));
}

function validSide(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  return value > 0 && value <= PAGE_SIZE_MAX_SIDE_PT;
}

/** A size worth retaining: positive, finite and bounded. */
export function storablePageSize(size: PdfPageSize | undefined): size is PdfPageSize {
  return !!size && validSide(size.widthPt) && validSide(size.heightPt);
}

export function serializePageSizes(binding: PageSizeBinding, sizes: ReadonlyMap<number, PdfPageSize>): Buffer {
  const pages = [...sizes]
    .filter(([page, size]) => Number.isSafeInteger(page) && page >= 1 && page <= binding.pageCount && storablePageSize(size))
    .sort(([a], [b]) => a - b)
    .map(([page, size]) => [page, size.widthPt, size.heightPt]);
  return Buffer.from(JSON.stringify({
    schema: PAGE_SIZES_SCHEMA,
    source: "pdfinfo",
    artifactRoot: binding.artifactRoot,
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
export function parsePageSizesArtifact(bytes: Uint8Array, binding: PageSizeBinding): PageSizesParse {
  if (bytes.byteLength > pageSizesArtifactMaxBytes(binding.pageCount)) return { ok: false, reason: "oversized" };
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "malformed" };
  const record = value as Record<string, unknown>;
  if (record.schema !== PAGE_SIZES_SCHEMA || record.source !== "pdfinfo") return { ok: false, reason: "schema" };
  if (record.artifactRoot !== binding.artifactRoot || record.runId !== binding.runId || record.userId !== binding.userId || record.documentId !== binding.documentId
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
    if (!storablePageSize(size)) return { ok: false, reason: "page" };
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
  get(binding: PageSizeBinding, pages: Iterable<number>): Map<number, PdfPageSize> {
    const out = new Map<number, PdfPageSize>();
    const entry = this.entries.get(bindingKey(binding));
    if (!entry) return out;
    entry.lastAccess = ++this.tick;
    for (const page of pages) {
      const size = entry.sizes.get(page);
      if (size) out.set(page, size);
    }
    return out;
  }

  /** Every size held for this binding (for writing the artifact). */
  all(binding: PageSizeBinding): Map<number, PdfPageSize> {
    return new Map(this.entries.get(bindingKey(binding))?.sizes ?? []);
  }

  set(binding: PageSizeBinding, sizes: ReadonlyMap<number, PdfPageSize>): void {
    const key = bindingKey(binding);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { sizes: new Map(), lastAccess: 0 };
      this.entries.set(key, entry);
    }
    entry.lastAccess = ++this.tick;
    for (const [page, size] of sizes) {
      if (!Number.isSafeInteger(page) || page < 1 || page > binding.pageCount || !storablePageSize(size)) continue;
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
): Promise<Map<number, PdfPageSize>> {
  const key = binding ? `${bindingKey(binding)}|${block.first}|${block.last}` : null;
  const pending = key ? inflight.get(key) : undefined;
  if (pending) {
    try {
      return await abortable(pending, signal);
    } catch (error) {
      if (signal.aborted || isCommandTeardownError(error)) throw error;
    }
  }
  const own = measure();
  if (key && !inflight.has(key)) {
    inflight.set(key, own);
    own.catch(() => undefined).finally(() => { if (inflight.get(key) === own) inflight.delete(key); });
  }
  return own;
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

/** The worker process's memo (every raster cache shares it). */
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

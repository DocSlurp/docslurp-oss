import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Document } from "../models.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { cleanupTempFile } from "../tools/storage.js";
import { documentArtifactRoot } from "../lib/artifact-root.js";
import { trustedTempDownloadPattern } from "../lib/temp-file-names.js";
import { loadNativePdfEngine } from "../native-pdf/loader.js";
import { logNativePdfFallback, NativePdfError } from "../native-pdf/types.js";
import { renderClipNative, renderPagesNative } from "../native-pdf/render.js";
import type { Bbox, NativePdfEngine } from "../native-pdf/types.js";
import { boundedRasterDpi, boundedRasterEdge } from "../lib/raster-bounds.js";
import { pushPerfMetric } from "../lib/perf-context.js";
import { isCommandTeardownError } from "../sandbox/teardown.js";

export type RasterEngineName = "pdftoppm" | "native-pdf";

/**
 * PDF_RASTER_ENGINE=pdftoppm|native-pdf (default pdftoppm). Native renders run inside the worker process,
 * outside WORKER_COMMAND_MAX_RSS_MB: with 8 busy slots x 4 lanes at 150 dpi they added ~670-810 MB to one
 * process (over its 512 MB off-heap budget) for ~2.4x the throughput of parallel pdftoppm children (~31 MB each),
 * so the default stays pdftoppm (ledger o1a2-raster-rss-native-pdf-a88a052-vs-pdftoppm-150dpi).
 */
export function readRasterEngine(value: string | undefined = process.env.PDF_RASTER_ENGINE): RasterEngineName {
  const normalized = value?.trim().toLowerCase();
  return normalized === "native-pdf" ? "native-pdf" : "pdftoppm";
}

export interface RasterCacheOptions {
  engine?: RasterEngineName;
  /** Resolves the native-pdf engine; null/throw means "not available" and the cache falls back to pdftoppm. */
  loadEngine?: () => Promise<NativePdfEngine | null>;
  /** Max parallel native renders (one document handle per lane). */
  concurrency?: number;
  /** Max parallel pdftoppm commands per selected-page render (default `defaultPdftoppmConcurrency`). */
  pdftoppmConcurrency?: number;
  /** Process-wide limiter for sandboxed raster commands (default `sandboxedRasterSlots()`). */
  rasterSlots?: Semaphore;
}

/** Hard ceiling for `PDF_PDFTOPPM_CONCURRENCY`: each lane is a sandboxed process holding a full-page bitmap. */
export const PDFTOPPM_CONCURRENCY_MAX = 4;

/** pdftoppm lanes per selected-page render: `PDF_PDFTOPPM_CONCURRENCY` (default 2, 1-4). Independent of native lanes. */
export function defaultPdftoppmConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.PDF_PDFTOPPM_CONCURRENCY ?? "", 10);
  return Number.isInteger(configured) && configured >= 1 ? Math.min(configured, PDFTOPPM_CONCURRENCY_MAX) : 2;
}

/** Hard ceiling for `PDF_PDFTOPPM_PROCESS_CONCURRENCY`. */
export const PDFTOPPM_PROCESS_CONCURRENCY_MAX = 32;

/**
 * Sandboxed raster commands (pdfinfo, pdftoppm) one worker process runs at once across every document:
 * `PDF_PDFTOPPM_PROCESS_CONCURRENCY` (default 8, 1-32). Per-render lanes multiply with document concurrency;
 * this keeps the total bounded (8 matches eight busy slots at one command each, as before lanes).
 */
export function defaultPdftoppmProcessConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.PDF_PDFTOPPM_PROCESS_CONCURRENCY ?? "", 10);
  return Number.isInteger(configured) && configured >= 1 ? Math.min(configured, PDFTOPPM_PROCESS_CONCURRENCY_MAX) : 8;
}

/**
 * Counting semaphore; waiters run in FIFO order and leave the queue when their signal aborts.
 * A task that fails with an unverified command teardown keeps its slot: its processes may still be
 * running, so the capacity stays out of service (bounded, logged and counted) instead of being reused.
 */
export class Semaphore {
  private active = 0;
  private poisonedSlots = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number) {}

  get inUse(): number {
    return this.active;
  }

  /** Slots held forever by commands whose teardown could not be verified. */
  get poisoned(): number {
    return this.poisonedSlots;
  }

  async run<T>(signal: AbortSignal | undefined, task: () => Promise<T>): Promise<T> {
    await this.acquire(signal);
    let poisoned = false;
    try {
      return await task();
    } catch (error) {
      poisoned = isCommandTeardownError(error);
      throw error;
    } finally {
      if (poisoned) {
        this.poisonedSlots += 1;
        console.error(
          `[worker-capacity] status=slot-poisoned metric=raster_slot_poisoned poisoned=${this.poisonedSlots} limit=${this.limit}`,
        );
        pushPerfMetric({ metric: "raster-slot-poisoned", value: this.poisonedSlots, unit: "count", tags: ["process", "teardown"] });
      } else {
        this.release();
      }
    }
  }

  private async acquire(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiters.indexOf(grant);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal!.reason);
      };
      // The releasing task hands its slot straight to this waiter (`active` is not decremented in between).
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.waiters.push(grant);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }
}

let processRasterSlots: Semaphore | null = null;

/** The worker process's shared limiter for sandboxed raster commands (sized once, from the environment). */
export function sandboxedRasterSlots(): Semaphore {
  processRasterSlots ??= new Semaphore(defaultPdftoppmProcessConcurrency());
  return processRasterSlots;
}

let rasterEngineUnavailableReported = false;

const defaultLoadEngine = async (): Promise<NativePdfEngine | null> => {
  const loaded = await loadNativePdfEngine();
  return loaded.ok ? loaded.engine : null;
};

export interface CachedPdfSource {
  path: string;
  sha256: string;
  sizeBytes: number;
  cacheHit: boolean;
}

interface SourceEntry {
  path: string;
  sha256: string;
  sizeBytes: number;
  lastAccess: number;
}

type SourceStorage = Pick<ArtifactStore, "downloadToTempFile">;

/**
 * Process-local source cache shared by Temporal activities. The Interface owns
 * download, hashing, bounded eviction, and cleanup so callers never materialize
 * the same source independently inside one worker process.
 */
export class PdfSourceCache {
  private readonly entries = new Map<string, Promise<SourceEntry>>();

  constructor(
    private readonly storage: SourceStorage,
    private readonly maxEntries = 16,
  ) {}

  async get(document: Document): Promise<CachedPdfSource> {
    const existing = this.entries.get(document.sourceKey);
    if (existing) {
      const entry = await existing;
      entry.lastAccess = Date.now();
      return { ...entry, cacheHit: true };
    }

    await this.evictIfNeeded();
    const raced = this.entries.get(document.sourceKey);
    if (raced) {
      const entry = await raced;
      entry.lastAccess = Date.now();
      return { ...entry, cacheHit: true };
    }
    const pending = this.download(document);
    this.entries.set(document.sourceKey, pending);
    try {
      const entry = await pending;
      return { ...entry, cacheHit: false };
    } catch (error) {
      this.entries.delete(document.sourceKey);
      throw error;
    }
  }

  async clear(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map(async (pending) => {
      const entry = await pending.catch(() => null);
      if (entry) await cleanupTempFile(entry.path);
    }));
  }

  private async download(document: Document): Promise<SourceEntry> {
    const filePath = await this.storage.downloadToTempFile(
      document.sourceKey,
      trustedTempDownloadPattern("docslurp-source-cache-", document),
    );
    const [sha256, fileStat] = await Promise.all([hashFile(filePath), stat(filePath)]);
    return { path: filePath, sha256, sizeBytes: fileStat.size, lastAccess: Date.now() };
  }

  private async evictIfNeeded(): Promise<void> {
    if (this.entries.size < Math.max(1, this.maxEntries)) return;
    const resolved = await Promise.all([...this.entries.entries()].map(async ([key, pending]) => ({
      key,
      entry: await pending.catch(() => null),
    })));
    const oldest = resolved
      .filter((candidate): candidate is { key: string; entry: SourceEntry } => candidate.entry !== null)
      .sort((left, right) => left.entry.lastAccess - right.entry.lastAccess)[0];
    if (!oldest) return;
    this.entries.delete(oldest.key);
    await cleanupTempFile(oldest.entry.path);
  }
}

export interface RasterPageArtifact {
  pageNumber: number;
  artifactKey: string;
  artifactUri: string;
  widthPx: number | null;
  heightPx: number | null;
  sizeBytes: number;
  cacheHit: boolean;
  mimeType: string;
  /** Engine that produced (or, on a cache hit, would have produced) this raster. */
  engine?: RasterEngineName;
  /** Requested density; oversized pages are bounded before allocation. */
  dpi?: number;
}

type RasterStorage = Pick<ArtifactStore, "objectSize" | "putBytes" | "uri">;
type RasterRunner = Pick<CommandRunner, "renderPdfPageRange" | "pdfPageSizes" | "run">;

/**
 * Durable selected-page raster Module. Callers provide page numbers and get
 * stable Artifact references; source reuse, range batching, rendering, upload,
 * and cache-hit behavior remain inside the Implementation.
 */
export class PdfRasterCache {
  constructor(
    private readonly runner: RasterRunner,
    private readonly storage: RasterStorage,
    private readonly sources: PdfSourceCache,
    private readonly options: RasterCacheOptions = {},
  ) {}

  /** Requested engine; the effective one also depends on binding availability (see `resolveEngine`). */
  get requestedEngine(): RasterEngineName {
    return this.options.engine ?? readRasterEngine();
  }

  private async resolveEngine(): Promise<{ name: RasterEngineName; engine: NativePdfEngine | null }> {
    if (this.requestedEngine !== "native-pdf") return { name: "pdftoppm", engine: null };
    const engine = await (this.options.loadEngine ?? defaultLoadEngine)().catch((error: unknown) => {
      logNativePdfFallback("raster-engine", error, "pdftoppm");
      return null;
    });
    if (!engine) {
      // Once per process: the requested engine is a process setting, so repeating it per page adds nothing.
      if (!rasterEngineUnavailableReported) {
        rasterEngineUnavailableReported = true;
        logNativePdfFallback("raster-engine", new NativePdfError("NATIVE_PDF_UNAVAILABLE", "PDF_RASTER_ENGINE=native-pdf but the engine is unavailable"), "pdftoppm");
      }
      return { name: "pdftoppm", engine: null };
    }
    return { name: "native-pdf", engine };
  }

  /**
   * Render one clipped region (PDF points, top-left origin) of a page without
   * rasterizing the full page. Returns null when the native engine is not the
   * active raster engine or cannot serve the clip, so callers keep their
   * full-page + crop path.
   */
  async renderClip(args: {
    document: Document;
    pageNumber: number;
    clip: Bbox;
    dpi?: number;
    maxEdgePx?: number;
    signal?: AbortSignal;
  }): Promise<{ bytes: Buffer; widthPx: number | null; heightPx: number | null; mimeType: string; engine: RasterEngineName; dpi: number } | null> {
    if (args.document.mimeType !== "application/pdf") return null;
    const { name, engine } = await this.resolveEngine();
    if (name !== "native-pdf" || !engine) return null;
    const dpi = clampDpi(args.dpi);
    try {
      const source = await this.sources.get(args.document);
      const clip = await renderClipNative(engine, source.path, args.pageNumber, args.clip, {
        dpi,
        maxEdgePx: args.maxEdgePx,
        signal: args.signal,
      });
      return { bytes: clip.bytes, widthPx: clip.widthPx, heightPx: clip.heightPx, mimeType: clip.mimeType, engine: name, dpi };
    } catch (error) {
      if (args.signal?.aborted) throw error;
      logNativePdfFallback(`raster-clip page=${args.pageNumber}`, error, "full-page render and crop");
      return null;
    }
  }

  /** Local path of the document's cached source file (downloaded once per worker process). */
  async sourcePath(document: Document): Promise<string> {
    return (await this.sources.get(document)).path;
  }

  /** Page sizes (CropBox, points) for the pages first..last from one pdfinfo call. */
  private async pdfPageSizes(
    sourcePath: string,
    first: number,
    last: number,
    signal: AbortSignal,
  ): Promise<Map<number, { widthPt: number; heightPt: number }>> {
    const sizePlan = await this.runner.pdfPageSizes(sourcePath, first, last);
    if (!sizePlan.available) throw new Error("pdfinfo unavailable for bounded rasterization");
    const { stdout } = await this.rasterSlots.run(signal, () => this.runner.run(sizePlan, signal));
    return parsePdfPageSizes(stdout, first, last);
  }

  private get rasterSlots(): Semaphore {
    return this.options.rasterSlots ?? sandboxedRasterSlots();
  }

  async renderSelectedPages(args: {
    document: Document;
    runId: string;
    pageNumbers: number[];
    dpi?: number;
    signal?: AbortSignal;
  }): Promise<RasterPageArtifact[]> {
    const dpi = clampDpi(args.dpi);
    const pageNumbers = normalizePageNumbers(args.pageNumbers, args.document.pageCount);
    if (pageNumbers.length === 0) return [];

    const isPdf = args.document.mimeType === "application/pdf";
    if (!isPdf && pageNumbers.some((pageNumber) => pageNumber !== 1)) {
      throw new Error(`Native image documents only support page 1, received ${pageNumbers.join(",")}`);
    }
    const outputMimeType = isPdf ? "image/png" : args.document.mimeType;
    const extension = isPdf ? "png" : extensionForImageMimeType(outputMimeType);

    // Engines get separate key spaces so an A/B run never mixes their pixels.
    const resolved = isPdf ? await this.resolveEngine() : { name: "pdftoppm" as RasterEngineName, engine: null };
    const dpiDir = resolved.name === "native-pdf" ? `v2-${dpi}dpi-native-pdf` : `v2-${dpi}dpi`;
    const keys = new Map(pageNumbers.map((pageNumber) => [
      pageNumber,
      `${documentArtifactRoot(args.document, args.runId)}/images/${args.document.id}/${dpiDir}/page-${pageNumber}.${extension}`,
    ]));
    let engineName: RasterEngineName = resolved.name;
    const existing = new Map<number, number | null>();
    await Promise.all(pageNumbers.map(async (pageNumber) => {
      existing.set(pageNumber, await this.storage.objectSize(keys.get(pageNumber)!));
    }));
    const missing = pageNumbers.filter((pageNumber) => existing.get(pageNumber) === null);
    const generated = new Map<number, { sizeBytes: number; widthPx: number | null; heightPx: number | null }>();

    if (missing.length > 0) {
      const source = await this.sources.get(args.document);
      if (!isPdf) {
        const bytes = await readFile(source.path);
        await this.storage.putBytes(keys.get(1)!, bytes, outputMimeType);
        generated.set(1, { sizeBytes: bytes.byteLength, widthPx: null, heightPx: null });
      }
      let nativeDone = false;
      if (isPdf && resolved.engine) {
        try {
          const rendered = await renderPagesNative(resolved.engine, source.path, missing, {
            dpi,
            concurrency: this.options.concurrency,
            signal: args.signal,
          });
          if (missing.every((pageNumber) => rendered.has(pageNumber))) {
            for (const [pageNumber, page] of rendered) {
              await this.storage.putBytes(keys.get(pageNumber)!, page.bytes, "image/png");
              generated.set(pageNumber, { sizeBytes: page.bytes.byteLength, widthPx: page.widthPx, heightPx: page.heightPx });
            }
            nativeDone = true;
          }
        } catch (error) {
          if (args.signal?.aborted) throw error;
          logNativePdfFallback("raster-render", error, "pdftoppm");
        }
      }
      if (isPdf && !nativeDone && resolved.engine) {
        // Keys are engine-scoped, so a fallback render must land under the pdftoppm key space.
        engineName = "pdftoppm";
        for (const pageNumber of pageNumbers) {
          keys.set(pageNumber, `${documentArtifactRoot(args.document, args.runId)}/images/${args.document.id}/v2-${dpi}dpi/page-${pageNumber}.${extension}`);
        }
        await Promise.all(pageNumbers.map(async (pageNumber) => {
          existing.set(pageNumber, await this.storage.objectSize(keys.get(pageNumber)!));
        }));
      }
      const pdftoppmPages = isPdf && !nativeDone
        ? pageNumbers.filter((pageNumber) => existing.get(pageNumber) === null)
        : [];
      const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-raster-"));
      try {
        // One pdfinfo call per contiguous run sizes the pages to render; each page then renders in its own pdftoppm
        // call, a few at a time. Lanes share one abort signal: the first failure aborts every in-flight sibling
        // command, the lanes drain, and nothing is uploaded after it. Every command also takes a process-wide slot.
        const lanes = this.options.pdftoppmConcurrency ?? defaultPdftoppmConcurrency();
        const sizes = new Map<number, { widthPt: number; heightPt: number }>();
        await runLanes(contiguousPageRanges(pdftoppmPages), lanes, args.signal, async (range, signal) => {
          for (const [pageNumber, size] of await this.pdfPageSizes(source.path, range.first, range.last, signal)) sizes.set(pageNumber, size);
        });
        await runLanes(pdftoppmPages, lanes, args.signal, async (selectedPage, signal) => {
          const size = sizes.get(selectedPage);
          if (!size) throw new Error("PDF page dimensions unavailable; refusing unbounded rasterization");
          const renderDpi = boundedRasterDpi(size.widthPt, size.heightPt, dpi);
          const prefix = path.join(scratch, `page-${selectedPage}-${selectedPage}`);
          const plan = await this.runner.renderPdfPageRange(
            source.path,
            prefix,
            selectedPage,
            selectedPage,
            renderDpi,
            boundedRasterEdge(size.widthPt, size.heightPt, renderDpi),
          );
          if (!plan.available) throw new Error("pdftoppm unavailable for selected-page rasterization");
          await this.rasterSlots.run(signal, () => this.runner.run(plan, signal));

          const stem = `${path.basename(prefix)}-`;
          const filename = (await readdir(scratch)).find((candidate) => {
            if (!candidate.startsWith(stem)) return false;
            const suffix = candidate.slice(stem.length).match(/^(\d+)\.png$/);
            return suffix !== null && Number(suffix[1]) === selectedPage;
          });
          if (!filename) throw new Error(`pdftoppm did not produce page ${selectedPage}`);
          const bytes = await readFile(path.join(scratch, filename));
          signal.throwIfAborted();
          await this.storage.putBytes(keys.get(selectedPage)!, bytes, "image/png");
          generated.set(selectedPage, { sizeBytes: bytes.byteLength, ...readPngDimensions(bytes) });
        });
        const unrendered = pdftoppmPages.filter((pageNumber) => !generated.has(pageNumber));
        if (unrendered.length > 0) throw new Error(`pdftoppm did not render pages ${unrendered.join(",")}`);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }

    return await Promise.all(pageNumbers.map(async (pageNumber) => {
      const key = keys.get(pageNumber)!;
      const generatedPage = generated.get(pageNumber);
      return {
        pageNumber,
        artifactKey: key,
        artifactUri: this.storage.uri(key),
        widthPx: generatedPage?.widthPx ?? null,
        heightPx: generatedPage?.heightPx ?? null,
        sizeBytes: generatedPage?.sizeBytes ?? existing.get(pageNumber) ?? 0,
        cacheHit: existing.get(pageNumber) !== null,
        mimeType: outputMimeType,
        engine: isPdf ? engineName : undefined,
        dpi: isPdf ? dpi : undefined,
      };
    }));
  }
}

function clampDpi(dpi: number | undefined): number {
  return Math.max(72, Math.min(300, Math.round(dpi ?? 150)));
}

function extensionForImageMimeType(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/gif") return "gif";
  return "png";
}

export function normalizePageNumbers(pageNumbers: number[], pageCount: number): number[] {
  const maxPage = Math.max(1, Math.floor(pageCount));
  return [...new Set(pageNumbers
    .filter((pageNumber) => Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= maxPage))]
    .sort((left, right) => left - right);
}

export function contiguousPageRanges(pageNumbers: number[]): Array<{ first: number; last: number }> {
  const normalized = [...new Set(pageNumbers)].sort((left, right) => left - right);
  const ranges: Array<{ first: number; last: number }> = [];
  for (const pageNumber of normalized) {
    const current = ranges.at(-1);
    if (current && pageNumber === current.last + 1) current.last = pageNumber;
    else ranges.push({ first: pageNumber, last: pageNumber });
  }
  return ranges;
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * Runs `task` over `items` on at most `lanes` concurrent lanes. Each task gets a signal linked to `signal` that
 * aborts on the first failure, so sibling commands stop; every lane drains before the first error is rethrown.
 */
export async function runLanes<T>(
  items: readonly T[],
  lanes: number,
  signal: AbortSignal | undefined,
  task: (item: T, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  // A misconfigured lane count (NaN, 0, Infinity) must still run every item, never zero lanes.
  const laneCount = Number.isFinite(lanes) && lanes >= 1 ? Math.floor(lanes) : 1;
  const controller = new AbortController();
  const forward = () => controller.abort(signal!.reason);
  if (signal?.aborted) forward();
  else signal?.addEventListener("abort", forward, { once: true });
  let cursor = 0;
  let failure: { error: unknown } | null = null;
  try {
    await Promise.all(Array.from({ length: Math.min(laneCount, items.length) }, async () => {
      while (cursor < items.length && !failure) {
        try {
          controller.signal.throwIfAborted();
          await task(items[cursor++]!, controller.signal);
        } catch (error) {
          failure ??= { error };
          controller.abort(error);
        }
      }
    }));
  } finally {
    signal?.removeEventListener("abort", forward);
  }
  if (failure) throw (failure as { error: unknown }).error;
}

/**
 * Per-page sizes from `pdfinfo -f first -l last` ("Page    N size: W x H pts"). A one-page call may print the
 * unnumbered "Page size:" form instead; it applies to `first` only when first === last. Only lines after the last
 * line-start "Pages:" count: metadata such as the title prints before it and may contain newlines.
 */
export function parsePdfPageSizes(stdout: string, first: number, last: number): Map<number, { widthPt: number; heightPt: number }> {
  const sizes = new Map<number, { widthPt: number; heightPt: number }>();
  const lines = stdout.split(/\r?\n/);
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) if (/^Pages:\s/.test(lines[index]!)) start = index + 1;
  if (start < 0) return sizes;
  let single: { widthPt: number; heightPt: number } | null = null;
  for (const line of lines.slice(start)) {
    const numbered = line.match(/^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/);
    if (numbered) {
      const pageNumber = Number(numbered[1]);
      if (pageNumber >= first && pageNumber <= last && !sizes.has(pageNumber)) {
        sizes.set(pageNumber, { widthPt: Number(numbered[2]), heightPt: Number(numbered[3]) });
      }
      continue;
    }
    const unnumbered = line.match(/^Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/);
    if (unnumbered && !single) single = { widthPt: Number(unnumbered[1]), heightPt: Number(unnumbered[2]) };
  }
  if (first === last && !sizes.has(first) && single) sizes.set(first, single);
  return sizes;
}

function readPngDimensions(bytes: Buffer): { widthPx: number | null; heightPx: number | null } {
  if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") {
    return { widthPx: null, heightPx: null };
  }
  return {
    widthPx: bytes.readUInt32BE(16),
    heightPx: bytes.readUInt32BE(20),
  };
}

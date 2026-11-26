import { createHash } from "node:crypto";
import { assertParseSourceDecided } from "../lib/parse-source.js";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
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
import { longEdgeCappedDpi, longEdgeCappedEdge } from "../lib/raster-bounds.js";
import { pageAreaEquivalents, pageAreaEquivalentsPt } from "@docslurp/shared";
import type { PageEquivalentRow } from "../db/page-equivalents.js";
import { recordRenderedPageAreas } from "./page-area-sink.js";
import { pushPerfMetric } from "../lib/perf-context.js";
import { isCommandTeardownError } from "../sandbox/teardown.js";
import { SourceIntegrityError, verifyStagedSource } from "../sandbox/source-integrity.js";
import { registerReadOnlySource, unregisterReadOnlySource } from "../sandbox/paths.js";
import { readPngFileFacts } from "../lib/page-image-evidence.js";
import { sniffedPdf } from "../lib/sniffed-pdf.js";

import {
  pageSizeBinding,
  pageSizeBlocks,
  pageSizesArtifactKey,
  pageSizesArtifactMaxBytes,
  parsePageSizesArtifact,
  pdfPageSizeMemo,
  readPageSizeReuse,
  serializePageSizes,
  sharedBlockMeasurement,
  type PageSizeBinding,
  type PdfPageSize,
  type PdfPageSizeMemo,
} from "./pdf-page-sizes.js";

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
  /** Overrides the process-wide memo for measured pdfinfo sizes. */
  pageSizeMemo?: PdfPageSizeMemo;
  /** Overrides DOCSLURP_RASTER_PAGE_SIZE_REUSE. */
  pageSizeReuse?: boolean;
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
}

interface SourceCacheEntry {
  source: Promise<SourceEntry>;
  lastAccess: number;
  borrowers: number;
  retired: boolean;
}

type SourceStorage = Pick<ArtifactStore, "downloadToTempFile">;

/**
 * Organization isolation: a cached source serves only its own run (a run belongs to exactly one organization). The storage
 * key alone is never trusted to separate tenants; the run and its requester are part of the cache key, so no other
 * organization's (or run's) stage can be handed this file.
 */
function sourceCacheKey(document: Pick<Document, "userId" | "runId" | "sourceKey">): string {
  if (!document.runId || !document.userId || !document.sourceKey) throw new Error("PDF source cache needs a run-scoped document");
  return JSON.stringify([document.runId, document.userId, document.sourceKey]);
}

/**
 * Process-local source cache shared by Temporal activities. The Interface owns
 * download, hashing, bounded eviction, and cleanup so callers never materialize
 * the same source independently inside one worker process.
 */
export class PdfSourceCache {
  private readonly entries = new Map<string, SourceCacheEntry>();

  constructor(
    private readonly storage: SourceStorage,
    private readonly maxEntries = 16,
  ) {}

  /**
   * The cached source for `document`, verified against its server hash on every call (a cached entry
   * may serve another document or version with the same key). On a mismatch the entry is dropped and
   * the document refused (SourceIntegrityError). The file is a read-only source for every command
   * (sandbox/paths.ts registerReadOnlySource): activities sharing it can neither write it nor share
   * its directory. Use acquire() when the caller needs the path to survive concurrent eviction.
   */
  async get(document: Document): Promise<CachedPdfSource> {
    const { release, ...source } = await this.borrow(document);
    await release(false);
    return source;
  }

  /** Keep a staged source registered and on disk until the last in-flight reader releases it. */
  async acquire(document: Document): Promise<CachedPdfSource & { release: () => Promise<void> }> {
    return this.borrow(document);
  }

  private async borrow(document: Document): Promise<CachedPdfSource & { release: (trim?: boolean) => Promise<void> }> {
    assertParseSourceDecided(document);
    const key = sourceCacheKey(document);
    let entry = this.entries.get(key);
    const cacheHit = entry !== undefined;
    if (!entry) {
      const evicted = this.evictIdle(1);
      entry = { source: evicted.then(() => this.download(document)), lastAccess: Date.now(), borrowers: 0, retired: false };
      this.entries.set(key, entry);
    }
    entry.lastAccess = Date.now();
    entry.borrowers += 1;
    const held = entry;
    let released = false;
    const release = async (trim = true) => {
      if (released) return;
      released = true;
      held.borrowers -= 1;
      if (held.retired) {
        if (held.borrowers === 0) await this.cleanup(held);
      } else if (trim) {
        await this.evictIdle();
      }
    };
    try {
      const source = await held.source.catch((error: unknown) => {
        if (this.entries.get(key) === held) this.entries.delete(key);
        throw error;
      });
      verifyStagedSource(document, source.sha256);
      await this.evictIdle();
      return { ...source, cacheHit, release };
    } catch (error) {
      if (error instanceof SourceIntegrityError && this.entries.get(key) === held) {
        this.entries.delete(key);
        held.retired = true;
      }
      await release();
      throw error;
    }
  }

  async clear(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.all(entries.map(async (entry) => {
      entry.retired = true;
      if (entry.borrowers === 0) await this.cleanup(entry);
    }));
  }

  private async cleanup(entry: SourceCacheEntry): Promise<void> {
    const source = await entry.source.catch(() => null);
    if (!source) return;
    try {
      await cleanupTempFile(source.path);
      unregisterReadOnlySource(source.path);
    } catch {
      console.warn("[pdf-source-cache] failed to remove staged source");
    }
  }

  private async download(document: Document): Promise<SourceEntry> {
    const filePath = await this.storage.downloadToTempFile(
      document.sourceKey,
      trustedTempDownloadPattern("docslurp-source-cache-", document),
    );
    try {
      const [sha256, fileStat] = await Promise.all([hashFile(filePath), stat(filePath)]);
      registerReadOnlySource(filePath);
      return { path: filePath, sha256, sizeBytes: fileStat.size };
    } catch (error) {
      await cleanupTempFile(filePath).catch(() => console.warn("[pdf-source-cache] failed to remove incomplete staged source"));
      throw error;
    }
  }

  private async evictIdle(incoming = 0): Promise<void> {
    // Active readers can temporarily exceed the idle cache budget.
    const excess = this.entries.size + incoming - Math.max(1, this.maxEntries);
    if (excess <= 0) return;
    const idle = [...this.entries]
      .filter(([, entry]) => entry.borrowers === 0)
      .sort(([, left], [, right]) => left.lastAccess - right.lastAccess)
      .slice(0, excess);
    for (const [key] of idle) this.entries.delete(key);
    await Promise.all(idle.map(([, entry]) => this.cleanup(entry)));
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
  /**
   * The customer's own uploaded bytes passed through as the page image (an image document), not a render this service produced
   * in its parser sandbox or VM. Never decode it in-process (sharp/libvips in the worker): only renders we produced may be.
   */
  customerOriginal?: boolean;
}

type RasterStorage = Pick<ArtifactStore, "objectSize" | "putBytes" | "uri"> & Partial<Pick<ArtifactStore, "getBytes">>;
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
    if (!sniffedPdf(args.document)) return null;
    const { name, engine } = await this.resolveEngine();
    if (name !== "native-pdf" || !engine) return null;
    const dpi = clampDpi(args.dpi);
    try {
      const source = await this.sources.acquire(args.document);
      try {
        const clip = await renderClipNative(engine, source.path, args.pageNumber, args.clip, {
          dpi,
          maxEdgePx: args.maxEdgePx,
          signal: args.signal,
        });
        return { bytes: clip.bytes, widthPx: clip.widthPx, heightPx: clip.heightPx, mimeType: clip.mimeType, engine: name, dpi };
      } finally {
        await source.release();
      }
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
    // Reads the shared cached source; writes nothing (readOnlyInputs keeps its directory read-only).
    const sizePlan = { ...(await this.runner.pdfPageSizes(sourcePath, first, last)), readOnlyInputs: true };
    if (!sizePlan.available) throw new Error("pdfinfo unavailable for bounded rasterization");
    const { stdout } = await this.rasterSlots.run(signal, () => this.runner.run(sizePlan, signal));
    return parsePdfPageSizes(stdout, first, last);
  }

  private get rasterSlots(): Semaphore {
    return this.options.rasterSlots ?? sandboxedRasterSlots();
  }

  /**
   * Sizes of `pages` of `source`: the process memo, then the run's stored pdfinfo sizes, then one sandboxed pdfinfo
   * per aligned block of the pages still unknown. Reuse binds the run, document and staged source hash. Missing
   * measurements and disabled reuse fall back to pdfinfo over the selected ranges. The returned callback persists
   * measurements after authorization and successful rendering.
   */
  private async measurePageSizes(
    document: Document,
    runId: string,
    source: CachedPdfSource,
    pages: number[],
    lanes: number,
    signal: AbortSignal | undefined,
  ): Promise<{ sizes: Map<number, PdfPageSize>; store: () => Promise<void> }> {
    const sizes = new Map<number, PdfPageSize>();
    let store = async () => {};
    if (pages.length === 0) return { sizes, store };
    const reuse = this.options.pageSizeReuse ?? readPageSizeReuse();
    const binding = reuse && pages.every((page) => page <= document.pageCount) ? pageSizeBinding(document, runId, source.sha256) : null;
    const memo = this.options.pageSizeMemo ?? pdfPageSizeMemo();
    const counts = { memo: 0, artifact: 0, pdfinfo: 0, calls: 0 };
    const missing = () => pages.filter((page) => !sizes.has(page));
    const take = (found: ReadonlyMap<number, PdfPageSize>, counter: "memo" | "artifact") => {
      for (const [page, size] of found) {
        if (sizes.has(page)) continue;
        sizes.set(page, size);
        counts[counter] += 1;
      }
    };
    if (binding) {
      take(memo.get(binding, pages), "memo");
      const wanted = missing();
      if (wanted.length > 0) {
        const stored = await this.readStoredPageSizes(document.id, binding);
        if (stored) {
          memo.set(binding, stored);
          take(memo.get(binding, wanted), "artifact");
        }
      }
    }
    const unmeasured = missing();
    if (unmeasured.length > 0) {
      // With a binding, whole aligned blocks: a later stage's pages are then usually already known.
      const measured = new Map<number, PdfPageSize>();
      if (binding) {
        await runLanes(pageSizeBlocks(unmeasured, binding.pageCount), lanes, signal, async (range, laneSignal) => {
          try {
            const result = await sharedBlockMeasurement(binding, range, laneSignal, () => {
              counts.calls += 1;
              return this.pdfPageSizes(source.path, range.first, range.last, laneSignal);
            });
            for (const [page, size] of result) measured.set(page, size);
          } catch (error) {
            if (laneSignal.aborted || isCommandTeardownError(error)) throw error;
            // A larger probe can fail where the original selected range succeeds.
          }
        });
      }
      const remaining = unmeasured.filter((page) => !measured.has(page));
      await runLanes(contiguousPageRanges(remaining), lanes, signal, async (range, laneSignal) => {
        counts.calls += 1;
        for (const [page, size] of await this.pdfPageSizes(source.path, range.first, range.last, laneSignal)) measured.set(page, size);
      });
      for (const page of unmeasured) {
        const size = measured.get(page);
        if (size) {
          sizes.set(page, size);
          counts.pdfinfo += 1;
        }
      }
      if (binding && counts.calls > 0) {
        memo.set(binding, measured);
        store = () => this.writeStoredPageSizes(document.id, binding, memo.all(binding));
      }
    }
    console.log(
      `[raster-page-sizes] document=${document.id} pages=${pages.length} memo=${counts.memo} artifact=${counts.artifact} ` +
        `pdfinfo=${counts.pdfinfo} pdfinfo_calls=${counts.calls} reuse=${binding ? "on" : "off"}`,
    );
    pushPerfMetric({ metric: "raster-page-size-pdfinfo-calls", value: counts.calls, unit: "count", tags: ["raster", "page-sizes"] });
    return { sizes, store };
  }

  /** The run's stored sizes for this exact source, or null (absent, unreadable or refused). */
  private async readStoredPageSizes(documentId: string, binding: PageSizeBinding): Promise<Map<number, PdfPageSize> | null> {
    if (!this.storage.getBytes) return null;
    const key = pageSizesArtifactKey(binding);
    let bytes: Buffer;
    try {
      bytes = await this.storage.getBytes(key, { maxBytes: pageSizesArtifactMaxBytes(binding.pageCount) });
    } catch (error) {
      if (isCommandTeardownError(error)) throw error;
      const name = error instanceof Error ? error.name : "unknown";
      const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
      if (name !== "NoSuchKey" && name !== "NotFound" && status !== 404) {
        console.warn(`[raster-page-sizes] document=${documentId} source=pdfinfo status=read-failed error=${name}`);
      }
      return null;
    }
    const parsed = parsePageSizesArtifact(bytes, binding);
    if (!parsed.ok) {
      console.warn(`[raster-page-sizes] document=${documentId} source=pdfinfo status=refused reason=${parsed.reason}`);
      return null;
    }
    return parsed.sizes;
  }

  /** Store every pdfinfo size known for this source (best effort: a failed write only costs a later pdfinfo). */
  private async writeStoredPageSizes(documentId: string, binding: PageSizeBinding, sizes: ReadonlyMap<number, PdfPageSize>): Promise<void> {
    if (sizes.size === 0 || !this.storage.getBytes) return;
    try {
      await this.storage.putBytes(pageSizesArtifactKey(binding), serializePageSizes(binding, sizes), "application/json");
    } catch (error) {
      if (isCommandTeardownError(error)) throw error;
      console.warn(`[raster-page-sizes] document=${documentId} source=pdfinfo status=store-failed error=${error instanceof Error ? error.name : "unknown"}`);
    }
  }

  async renderSelectedPages(args: {
    document: Document;
    runId: string;
    pageNumbers: number[];
    dpi?: number;
    /**
     * Longest rendered edge in pixels, for a vision model trained on that size (vision-request-profile.ts). Lowers each
     * PDF page's DPI from its measured point size; raster uploads are stored as uploaded. Renders get their own keys.
     */
    maxLongEdgePx?: number;
    signal?: AbortSignal;
  }): Promise<RasterPageArtifact[]> {
    const dpi = clampDpi(args.dpi);
    const maxLongEdgePx = args.maxLongEdgePx;
    if (maxLongEdgePx !== undefined && !(Number.isInteger(maxLongEdgePx) && maxLongEdgePx >= 256 && maxLongEdgePx <= 4_000)) {
      throw new Error("maxLongEdgePx must be an integer from 256 to 4000");
    }
    const edgeSuffix = maxLongEdgePx !== undefined ? `-edge${maxLongEdgePx}` : "";
    const pageNumbers = normalizePageNumbers(args.pageNumbers, args.document.pageCount);
    if (pageNumbers.length === 0) return [];

    const isPdf = sniffedPdf(args.document);
    if (!isPdf && pageNumbers.some((pageNumber) => pageNumber !== 1)) {
      throw new Error(`Native image documents only support page 1, received ${pageNumbers.join(",")}`);
    }
    const outputMimeType = isPdf ? "image/png" : args.document.mimeType;
    const extension = isPdf ? "png" : extensionForImageMimeType(outputMimeType);

    // Engines get separate key spaces so an A/B run never mixes their pixels.
    const resolved = isPdf ? await this.resolveEngine() : { name: "pdftoppm" as RasterEngineName, engine: null };
    const dpiDir = resolved.name === "native-pdf" ? `v2-${dpi}dpi${edgeSuffix}-native-pdf` : `v2-${dpi}dpi${edgeSuffix}`;
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
    // Each rendered page's area in standard pages (capped per page) bills: a giant page costs the pixels it renders to. It is
    // recorded and authorized (recordRenderedPageAreas) before the page's bytes are cached, so a cache hit was authorized.

    if (missing.length > 0) {
      const source = await this.sources.acquire(args.document);
      try {
        if (!isPdf) {
          const bytes = await readFile(source.path);
          await this.storage.putBytes(keys.get(1)!, bytes, outputMimeType);
          generated.set(1, { sizeBytes: bytes.byteLength, widthPx: null, heightPx: null });
        }
        let nativeDone = false;
        if (isPdf && resolved.engine) {
          let rendered: Awaited<ReturnType<typeof renderPagesNative>> | null = null;
          try {
            rendered = await renderPagesNative(resolved.engine, source.path, missing, {
              dpi,
              ...(maxLongEdgePx !== undefined ? { maxLongEdgePx } : {}),
              concurrency: this.options.concurrency,
              signal: args.signal,
            });
          } catch (error) {
            if (args.signal?.aborted) throw error;
            logNativePdfFallback("raster-render", error, "pdftoppm");
          }
          if (rendered && missing.every((pageNumber) => rendered.has(pageNumber))) {
            const areas: PageEquivalentRow[] = [];
            for (const [pageNumber, page] of rendered) {
              // Billed from the page's point size, as the pdftoppm path is: a DPI lowered by the pixel bounds or a long-edge
              // cap changes the pixels, never the page.
              if (page.widthPt && page.heightPt) areas.push({ pageNumber, area: pageAreaEquivalentsPt(page.widthPt, page.heightPt) });
              else if (page.widthPx && page.heightPx) areas.push({ pageNumber, area: pageAreaEquivalents(page.widthPx, page.heightPx, page.dpi) });
            }
            // Measured and authorized before any page is cached, outside the engine fallback: a refusal (an unfunded run is
            // paused) or a failed record stops here and leaves nothing a retry would skip.
            await recordRenderedPageAreas(args.runId, args.document, areas);
            for (const [pageNumber, page] of rendered) {
              await this.storage.putBytes(keys.get(pageNumber)!, page.bytes, "image/png");
              generated.set(pageNumber, { sizeBytes: page.bytes.byteLength, widthPx: page.widthPx, heightPx: page.heightPx });
            }
            nativeDone = true;
          }
        }
        if (isPdf && !nativeDone && resolved.engine) {
          // Keys are engine-scoped, so a fallback render must land under the pdftoppm key space.
          engineName = "pdftoppm";
          for (const pageNumber of pageNumbers) {
            keys.set(pageNumber, `${documentArtifactRoot(args.document, args.runId)}/images/${args.document.id}/v2-${dpi}dpi${edgeSuffix}/page-${pageNumber}.${extension}`);
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
          // Reused pdfinfo measurements size the selected pages before bounded same-size render batches.
          const lanes = this.options.pdftoppmConcurrency ?? defaultPdftoppmConcurrency();
          const { sizes, store: storePageSizes } = await this.measurePageSizes(args.document, args.runId, source, pdftoppmPages, lanes, args.signal);
          if (pdftoppmPages.some((pageNumber) => !sizes.has(pageNumber))) throw new Error("PDF page dimensions unavailable; refusing unbounded rasterization");
          // Each page's area from its size, measured and authorized before anything renders or is cached.
          await recordRenderedPageAreas(args.runId, args.document, pdftoppmPages.map((pageNumber) => {
            const size = sizes.get(pageNumber)!;
            return { pageNumber, area: pageAreaEquivalentsPt(size.widthPt, size.heightPt) };
          }));
          const batchAdjacent = process.env.DOCSLURP_PDF_RASTER_BATCHING === "on";
          const batches: Array<{ first: number; last: number; dpi: number; edge: number }> = [];
          for (const pageNumber of pdftoppmPages) {
            const size = sizes.get(pageNumber)!;
            const renderDpi = longEdgeCappedDpi(size.widthPt, size.heightPt, dpi, maxLongEdgePx);
            const edge = longEdgeCappedEdge(size.widthPt, size.heightPt, renderDpi, maxLongEdgePx);
            const previous = batches.at(-1);
            // At most two ordinary pages per command. Keep large renders single, with the existing edge and slot limits.
            if (batchAdjacent && previous && previous.first === previous.last && previous.last + 1 === pageNumber &&
                previous.dpi === renderDpi && previous.edge === edge && edge * edge * 8 <= 32 * 1024 * 1024) {
              previous.last = pageNumber;
            } else {
              batches.push({ first: pageNumber, last: pageNumber, dpi: renderDpi, edge });
            }
          }
          await runLanes(batches, lanes, args.signal, async (batch, signal) => {
            // Each process reads the source read-only and writes only into its own bounded output directory.
            const laneDir = await mkdtemp(path.join(scratch, "docslurp-page-"));
            const stem = `page-${batch.first}-${batch.last}`;
            const rendered = await this.runner.renderPdfPageRange(
              source.path, path.join(laneDir, stem), batch.first, batch.last, batch.dpi, batch.edge,
            );
            if (!rendered.available) throw new Error("pdftoppm unavailable for selected-page rasterization");
            const paired = batch.first !== batch.last;
            const pairOutputLimit = 36 * 1024 * 1024;
            await this.rasterSlots.run(signal, () => this.runner.run({
              ...rendered, readOnlyInputs: true, ...(paired ? { maxOutputBytes: pairOutputLimit } : {}),
            }, signal));

            const files = new Map<number, string>();
            for (const filename of await readdir(laneDir)) {
              if (!filename.startsWith(`${stem}-`)) continue;
              const suffix = filename.slice(stem.length + 1).match(/^(\d+)\.png$/);
              if (!suffix) continue;
              const pageNumber = Number(suffix[1]);
              if (files.has(pageNumber)) throw new Error(`pdftoppm produced duplicate output for page ${pageNumber}`);
              files.set(pageNumber, filename);
            }
            if (paired && files.size !== 2) throw new Error("pdftoppm did not produce exactly two pages");
            let pairBytes = 0;
            for (let pageNumber = batch.first; pageNumber <= batch.last; pageNumber += 1) {
              const filename = files.get(pageNumber);
              if (!filename) throw new Error(`pdftoppm did not produce page ${pageNumber}`);
              if (!paired) continue;
              signal.throwIfAborted();
              const file = path.join(laneDir, filename);
              if (!(await lstat(file)).isFile()) throw new Error("Invalid raster output file");
              const { sizeBytes, widthPx, heightPx } = await readPngFileFacts(file);
              pairBytes += sizeBytes;
              if (pairBytes > pairOutputLimit || !widthPx || !heightPx || Math.max(widthPx, heightPx) > batch.edge) {
                throw new Error(`Invalid raster output for page ${pageNumber}`);
              }
            }
            for (let pageNumber = batch.first; pageNumber <= batch.last; pageNumber += 1) {
              const bytes = await readFile(path.join(laneDir, files.get(pageNumber)!));
              signal.throwIfAborted();
              await this.storage.putBytes(keys.get(pageNumber)!, bytes, "image/png");
              generated.set(pageNumber, { sizeBytes: bytes.byteLength, ...readPngDimensions(bytes) });
            }
          });
          const unrendered = pdftoppmPages.filter((pageNumber) => !generated.has(pageNumber));
          if (unrendered.length > 0) throw new Error(`pdftoppm did not render pages ${unrendered.join(",")}`);
          args.signal?.throwIfAborted();
          await storePageSizes();
        } finally {
          await rm(scratch, { recursive: true, force: true });
        }
      } finally {
        await source.release();
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
        ...(isPdf ? {} : { customerOriginal: true }),
        mimeType: outputMimeType,
        engine: isPdf ? engineName : undefined,
        // A long-edge cap lowers each page's DPI from its own size: the requested DPI would mis-scale coordinates, so a
        // capped render reports none.
        dpi: isPdf && maxLongEdgePx === undefined ? dpi : undefined,
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

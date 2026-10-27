import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Document } from "../models.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { cleanupTempFile } from "../tools/storage.js";
import { trustedTempDownloadPattern } from "../lib/temp-file-names.js";
import { loadNativePdfEngine } from "../native-pdf/loader.js";
import { logNativePdfFallback, NativePdfError } from "../native-pdf/types.js";
import { renderClipNative, renderPagesNative } from "../native-pdf/render.js";
import type { Bbox, NativePdfEngine } from "../native-pdf/types.js";
import { boundedRasterDpi, boundedRasterEdge } from "../lib/raster-bounds.js";
import { pushPerfMetric } from "../lib/perf-context.js";
import { SandboxRunError } from "../sandbox/types.js";
import {
  encodeLosslessWebp,
  OversizedPageImageError,
  PAGE_IMAGE_MIME_TYPES,
  pageImageKey,
  pageImageWebpEffort,
  readPageImageFormat,
  readPngDimensions,
  reportPageImageFormatFallback,
  type PageImageFormat,
} from "./page-image-format.js";

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
  /** Stored page-image format; defaults to DOCSLURP_PAGE_IMAGE_FORMAT (webp). */
  format?: PageImageFormat;
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
/** `encodeLosslessWebp` is optional so a runner without it stores PNG (a logged format fallback). */
type RasterRunner = Pick<CommandRunner, "renderPdfPageRange" | "pdfPageSizes" | "run"> & Partial<Pick<CommandRunner, "encodeLosslessWebp">>;

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
    const root = `${args.document.userId}/${args.runId}`;
    if (!isPdf) return await this.storeNativeImage(args.document, root, dpi, pageNumbers);

    const format = this.options.format ?? readPageImageFormat();
    const effort = pageImageWebpEffort({ retentionHours: args.document.artifactRetentionHours });
    // Engines and formats get separate key spaces so an A/B run never mixes their pixels and a
    // WebP object never overwrites (or is mistaken for) an existing PNG one.
    const resolved = await this.resolveEngine();
    let engineName: RasterEngineName = resolved.name;
    const keyFor = (pageNumber: number, pageFormat: PageImageFormat, engine: RasterEngineName = engineName) =>
      pageImageKey({ root, documentId: args.document.id, dpi, engine, format: pageFormat, pageNumber });

    const stored = new Map<number, StoredPage>();
    const lookupExisting = async () => {
      stored.clear();
      await Promise.all(pageNumbers.map(async (pageNumber) => {
        // Preferred format first, then the PNG variant: PNG objects written before the switch
        // (or during a cwebp outage) are served as they are rather than re-rendered.
        for (const pageFormat of format === "webp" ? ["webp", "png"] as const : ["png"] as const) {
          const key = keyFor(pageNumber, pageFormat);
          const size = await this.storage.objectSize(key);
          if (size !== null) {
            stored.set(pageNumber, { key, mimeType: PAGE_IMAGE_MIME_TYPES[pageFormat], sizeBytes: size, widthPx: null, heightPx: null, cacheHit: true });
            return;
          }
        }
      }));
    };
    await lookupExisting();

    if (pageNumbers.some((pageNumber) => !stored.has(pageNumber))) {
      const source = await this.sources.get(args.document);
      const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-raster-"));
      try {
        const persist = async (pageNumber: number, png: Buffer, pngPath: string) => {
          const dimensions = readPngDimensions(png);
          if (format === "webp") {
            const encoded = await encodeLosslessWebp({
              runner: this.runner,
              pngPath,
              webpPath: path.join(scratch, `page-${pageNumber}.webp`),
              png,
              effort,
              signal: args.signal,
            });
            if (encoded.status === "encoded") {
              const key = keyFor(pageNumber, "webp");
              await this.storage.putBytes(key, encoded.bytes, "image/webp");
              pushPerfMetric({
                metric: "page-image-webp-encode-ms",
                value: encoded.encodeMs,
                unit: "ms",
                tags: ["page-image", `effort:${encoded.effort}`],
                metadata: { pageNumber, pngBytes: png.byteLength, webpBytes: encoded.bytes.byteLength, effort: encoded.effort },
              });
              stored.set(pageNumber, { key, mimeType: "image/webp", sizeBytes: encoded.bytes.byteLength, widthPx: encoded.widthPx, heightPx: encoded.heightPx, cacheHit: false });
              return;
            }
            reportPageImageFormatFallback({ status: encoded.status, reason: encoded.reason, pageNumber, documentId: args.document.id });
          }
          const key = keyFor(pageNumber, "png");
          await this.storage.putBytes(key, png, "image/png");
          stored.set(pageNumber, { key, mimeType: "image/png", sizeBytes: png.byteLength, ...dimensions, cacheHit: false });
        };

        let nativeDone = false;
        if (resolved.engine) {
          const missing = pageNumbers.filter((pageNumber) => !stored.has(pageNumber));
          try {
            const rendered = await renderPagesNative(resolved.engine, source.path, missing, {
              dpi,
              concurrency: this.options.concurrency,
              signal: args.signal,
            });
            if (missing.every((pageNumber) => rendered.has(pageNumber))) {
              for (const [pageNumber, page] of rendered) {
                if (page.mimeType !== "image/png") throw new Error(`native raster returned ${page.mimeType}`);
                // The encoder reads a file in the sandbox's temp workspace, never in-process bytes.
                const pngPath = path.join(scratch, `native-page-${pageNumber}.png`);
                await writeFile(pngPath, page.bytes);
                await persist(pageNumber, page.bytes, pngPath);
              }
              nativeDone = true;
            }
          } catch (error) {
            if (args.signal?.aborted || error instanceof SandboxRunError || error instanceof OversizedPageImageError) throw error;
            logNativePdfFallback("raster-render", error, "pdftoppm");
          }
          if (!nativeDone) {
            // Keys are engine-scoped, so a fallback render must land under the pdftoppm key space.
            engineName = "pdftoppm";
            await lookupExisting();
          }
        }
        const pdftoppmPages = nativeDone ? [] : pageNumbers.filter((pageNumber) => !stored.has(pageNumber));
        for (const selectedPage of pdftoppmPages) {
          const range = { first: selectedPage, last: selectedPage };
          const sizePlan = await this.runner.pdfPageSizes(source.path, selectedPage, selectedPage);
          if (!sizePlan.available) throw new Error("pdfinfo unavailable for bounded rasterization");
          const sizeResult = await this.runner.run(sizePlan, args.signal);
          const size = sizeResult.stdout.match(/(?:Page\s+\d+\s+size|Page size):\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/);
          if (!size) throw new Error("PDF page dimensions unavailable; refusing unbounded rasterization");
          const renderDpi = boundedRasterDpi(Number(size[1]), Number(size[2]), dpi);
          const prefix = path.join(scratch, `page-${range.first}-${range.last}`);
          const plan = await this.runner.renderPdfPageRange(
            source.path,
            prefix,
            range.first,
            range.last,
            renderDpi,
            boundedRasterEdge(Number(size[1]), Number(size[2]), renderDpi),
          );
          if (!plan.available) throw new Error("pdftoppm unavailable for selected-page rasterization");
          await this.runner.run(plan, args.signal);

          const filenames = await readdir(scratch);
          for (let pageNumber = range.first; pageNumber <= range.last; pageNumber += 1) {
            const filename = filenames.find((candidate) => {
              const stem = `${path.basename(prefix)}-`;
              if (!candidate.startsWith(stem)) return false;
              const suffix = candidate.slice(stem.length).match(/^(\d+)\.png$/);
              return suffix !== null && Number(suffix[1]) === pageNumber;
            });
            if (!filename) throw new Error(`pdftoppm did not produce page ${pageNumber}`);
            const pngPath = path.join(scratch, filename);
            await persist(pageNumber, await readFile(pngPath), pngPath);
          }
        }
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }

    return pageNumbers.map((pageNumber) => {
      const page = stored.get(pageNumber);
      if (!page) throw new Error(`page ${pageNumber} was not rendered`);
      return {
        pageNumber,
        artifactKey: page.key,
        artifactUri: this.storage.uri(page.key),
        widthPx: page.widthPx,
        heightPx: page.heightPx,
        sizeBytes: page.sizeBytes,
        cacheHit: page.cacheHit,
        mimeType: page.mimeType,
        engine: engineName,
        dpi,
      };
    });
  }

  /** An uploaded image is its own page 1: stored as uploaded, never re-encoded. */
  private async storeNativeImage(document: Document, root: string, dpi: number, pageNumbers: number[]): Promise<RasterPageArtifact[]> {
    const mimeType = document.mimeType;
    const key = `${root}/images/${document.id}/v2-${dpi}dpi/page-1.${extensionForImageMimeType(mimeType)}`;
    const existing = await this.storage.objectSize(key);
    let sizeBytes = existing ?? 0;
    if (existing === null) {
      const source = await this.sources.get(document);
      const bytes = await readFile(source.path);
      await this.storage.putBytes(key, bytes, mimeType);
      sizeBytes = bytes.byteLength;
    }
    return pageNumbers.map((pageNumber) => ({
      pageNumber,
      artifactKey: key,
      artifactUri: this.storage.uri(key),
      widthPx: null,
      heightPx: null,
      sizeBytes,
      cacheHit: existing !== null,
      mimeType,
    }));
  }
}

interface StoredPage {
  key: string;
  mimeType: string;
  sizeBytes: number;
  widthPx: number | null;
  heightPx: number | null;
  cacheHit: boolean;
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

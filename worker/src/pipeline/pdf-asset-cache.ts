import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Document } from "../models.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import { cleanupTempFile } from "../tools/storage.js";
import { trustedTempDownloadPattern } from "../lib/temp-file-names.js";
import { loadNativePdfEngine } from "../native-pdf/loader.js";
import { renderClipNative, renderPagesNative } from "../native-pdf/render.js";
import type { Bbox, NativePdfEngine } from "../native-pdf/types.js";
import { boundedRasterDpi, boundedRasterEdge } from "../lib/raster-bounds.js";

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
}

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
    const engine = await (this.options.loadEngine ?? defaultLoadEngine)().catch(() => null);
    return engine ? { name: "native-pdf", engine } : { name: "pdftoppm", engine: null };
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
    } catch {
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
    const outputMimeType = isPdf ? "image/png" : args.document.mimeType;
    const extension = isPdf ? "png" : extensionForImageMimeType(outputMimeType);

    // Engines get separate key spaces so an A/B run never mixes their pixels.
    const resolved = isPdf ? await this.resolveEngine() : { name: "pdftoppm" as RasterEngineName, engine: null };
    const dpiDir = resolved.name === "native-pdf" ? `v2-${dpi}dpi-native-pdf` : `v2-${dpi}dpi`;
    const keys = new Map(pageNumbers.map((pageNumber) => [
      pageNumber,
      `${args.document.userId}/${args.runId}/images/${args.document.id}/${dpiDir}/page-${pageNumber}.${extension}`,
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
          console.warn(`[raster] native-pdf render failed, falling back to pdftoppm: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (isPdf && !nativeDone && resolved.engine) {
        // Keys are engine-scoped, so a fallback render must land under the pdftoppm key space.
        engineName = "pdftoppm";
        for (const pageNumber of pageNumbers) {
          keys.set(pageNumber, `${args.document.userId}/${args.runId}/images/${args.document.id}/v2-${dpi}dpi/page-${pageNumber}.${extension}`);
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
            const bytes = await readFile(path.join(scratch, filename));
            await this.storage.putBytes(keys.get(pageNumber)!, bytes, "image/png");
            generated.set(pageNumber, { sizeBytes: bytes.byteLength, ...readPngDimensions(bytes) });
          }
        }
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

function readPngDimensions(bytes: Buffer): { widthPx: number | null; heightPx: number | null } {
  if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") {
    return { widthPx: null, heightPx: null };
  }
  return {
    widthPx: bytes.readUInt32BE(16),
    heightPx: bytes.readUInt32BE(20),
  };
}

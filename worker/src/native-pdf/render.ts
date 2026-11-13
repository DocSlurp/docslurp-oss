import { availableParallelism } from "node:os";

import type { NativePdfDocument, NativePdfEngine, Bbox } from "./types.js";
import { NativePdfError } from "./types.js";
import { longEdgeCappedDpi, longEdgeCappedEdge } from "../lib/raster-bounds.js";

/**
 * Raster helper for the `native-pdf` engine: renders selected pages (and clipped
 * crops) in-process instead of spawning pdftoppm per range.
 *
 * A document handle is used by one task at a time (adapter contract), so
 * parallelism is one handle per lane, with a bounded lane count.
 */
export interface NativeRenderedPage {
  /** 1-based. */
  pageNumber: number;
  bytes: Buffer;
  widthPx: number | null;
  heightPx: number | null;
  mimeType: "image/png" | "image/jpeg";
  /** The DPI this page actually rendered at (bounded, and lowered by `maxLongEdgePx`): page area billing divides by it. */
  dpi: number;
}

export interface NativeRenderOptions {
  dpi: number;
  /** Longest rendered edge in pixels (a vision model's training size); lowers the page's DPI, never raises it. */
  maxLongEdgePx?: number;
  /** Max simultaneous renders (one document handle each). */
  concurrency?: number;
  format?: "png" | "jpeg";
  gray?: boolean;
  signal?: AbortSignal;
}

export function defaultRenderConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.PDF_RASTER_CONCURRENCY ?? "", 10);
  if (Number.isInteger(configured) && configured >= 1) return Math.min(configured, 32);
  return Math.max(1, Math.min(4, availableParallelism()));
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new NativePdfError("NATIVE_PDF_FAILED", "render aborted");
}

/** Render the given 1-based pages at `dpi`. Rejects if any page fails (caller falls back). */
export async function renderPagesNative(
  engine: NativePdfEngine,
  sourcePath: string,
  pageNumbers: number[],
  options: NativeRenderOptions,
): Promise<Map<number, NativeRenderedPage>> {
  const out = new Map<number, NativeRenderedPage>();
  const pages = [...new Set(pageNumbers)].sort((a, b) => a - b);
  if (pages.length === 0) return out;
  const format = options.format ?? "png";
  const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
  const lanes = Math.max(1, Math.min(options.concurrency ?? defaultRenderConcurrency(), pages.length));

  let cursor = 0;
  const docs: NativePdfDocument[] = [];
  try {
    await Promise.all(Array.from({ length: lanes }, async () => {
      const doc = await engine.openPath(sourcePath, { signal: options.signal });
      docs.push(doc);
      while (cursor < pages.length) {
        throwIfAborted(options.signal);
        const pageNumber = pages[cursor++]!;
        const page = doc.page(pageNumber - 1);
        const size = await page.size();
        const dpi = longEdgeCappedDpi(size.widthPt, size.heightPt, options.dpi, options.maxLongEdgePx);
        const bytes = await page.render({
          dpi,
          maxEdgePx: longEdgeCappedEdge(size.widthPt, size.heightPt, dpi, options.maxLongEdgePx),
          format,
          ...(options.gray ? { gray: true } : {}),
        });
        out.set(pageNumber, { pageNumber, bytes, ...imageDimensions(bytes), mimeType, dpi });
      }
    }));
  } finally {
    await Promise.allSettled(docs.map((doc) => doc.close()));
  }
  return out;
}

/**
 * Render only `clip` (PDF points, top-left origin) of one page. Inset and
 * verifier paths use this instead of rendering a full page and cropping.
 */
export async function renderClipNative(
  engine: NativePdfEngine,
  sourcePath: string,
  pageNumber: number,
  clip: Bbox,
  options: Pick<NativeRenderOptions, "dpi" | "format" | "gray" | "signal"> & { maxEdgePx?: number },
): Promise<NativeRenderedPage> {
  throwIfAborted(options.signal);
  const format = options.format ?? "png";
  const doc = await engine.openPath(sourcePath, { signal: options.signal });
  try {
    const bytes = await doc.page(pageNumber - 1).render({
      dpi: options.dpi,
      clip,
      format,
      ...(options.maxEdgePx ? { maxEdgePx: options.maxEdgePx } : {}),
      ...(options.gray ? { gray: true } : {}),
    });
    return {
      pageNumber,
      bytes,
      ...imageDimensions(bytes),
      mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
      // The requested DPI; `maxEdgePx` can only lower the effective one. Clip renders are not area-billed.
      dpi: options.dpi,
    };
  } finally {
    await doc.close().catch(() => undefined);
  }
}

/** Width/height from a PNG IHDR or a JPEG SOF marker; null when unrecognised. */
export function imageDimensions(bytes: Buffer): { widthPx: number | null; heightPx: number | null } {
  if (bytes.length >= 24 && bytes.toString("ascii", 1, 4) === "PNG") {
    return { widthPx: bytes.readUInt32BE(16), heightPx: bytes.readUInt32BE(20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { heightPx: bytes.readUInt16BE(offset + 5), widthPx: bytes.readUInt16BE(offset + 7) };
      }
      offset += 2 + bytes.readUInt16BE(offset + 2);
    }
  }
  return { widthPx: null, heightPx: null };
}

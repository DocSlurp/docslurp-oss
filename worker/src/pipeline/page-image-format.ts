import { readFile, stat } from "node:fs/promises";

import { emitTelemetryLog, setActiveSpanAttributes } from "@docslurp/shared/observability";

import { currentPerfContext, pushPerfMetric } from "../lib/perf-context.js";
import type { CommandPlan, CommandRunner } from "../tools/runner.js";
import { SandboxRunError } from "../sandbox/types.js";

/**
 * Stored page images: format, encode effort and key space.
 *
 * Lossless WebP keeps every pixel of the PNG render (OCR and vision input are unchanged) at
 * ~41-53% fewer bytes. Measured 2026-10-26 on 127 pages, one vCPU at the $0.0846/h slot rate and
 * Tigris at $0.02/GB-month: PNG level 6 77 pages/min 1,599 KB/page; WebP effort 1 49 pages/min
 * 937 KB/page; effort 6 31 pages/min 750 KB/page. Effort 1 is cheapest when an image is kept for
 * less than about 4.5 months, effort 6 beyond that; efforts 3-7 are within 1% over 12 months and
 * 8-9 never pay back.
 *
 * Pixels come from customer PDFs, so the encode runs `cwebp` through the parser sandbox
 * (CommandRunner), never in the worker process. A missing `cwebp` keeps storing PNG with a loud
 * warning: that is a format fallback, not an isolation fallback.
 */

export type PageImageFormat = "webp" | "png";

export const PAGE_IMAGE_MIME_TYPES: Readonly<Record<PageImageFormat, string>> = {
  webp: "image/webp",
  png: "image/png",
};

/** Default lossless effort (`cwebp -z`) for images kept long-term. */
export const DEFAULT_PAGE_IMAGE_WEBP_EFFORT = 6;
/** Effort used when images are deleted soon: encode time dominates storage below ~4.5 months. */
export const SHORT_RETENTION_PAGE_IMAGE_WEBP_EFFORT = 1;
/** Retention below this many hours (about 4 months) counts as short. */
export const DEFAULT_PAGE_IMAGE_WEBP_SHORT_RETENTION_HOURS = 3_000;

type Env = Record<string, string | undefined>;

/** DOCSLURP_PAGE_IMAGE_FORMAT=webp|png, default webp. Any other value keeps the default. */
export function readPageImageFormat(env: Env = process.env): PageImageFormat {
  return env.DOCSLURP_PAGE_IMAGE_FORMAT?.trim().toLowerCase() === "png" ? "png" : "webp";
}

function readIntegerInRange(value: string | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** DOCSLURP_PAGE_IMAGE_WEBP_EFFORT, an integer 0-9 (`cwebp -z`), default 6. */
export function readPageImageWebpEffort(env: Env = process.env): number {
  return readIntegerInRange(env.DOCSLURP_PAGE_IMAGE_WEBP_EFFORT, 0, 9, DEFAULT_PAGE_IMAGE_WEBP_EFFORT);
}

/** DOCSLURP_PAGE_IMAGE_WEBP_SHORT_RETENTION_HOURS, a positive integer, default 3,000. */
export function readPageImageWebpShortRetentionHours(env: Env = process.env): number {
  return readIntegerInRange(env.DOCSLURP_PAGE_IMAGE_WEBP_SHORT_RETENTION_HOURS, 1, 10_000_000, DEFAULT_PAGE_IMAGE_WEBP_SHORT_RETENTION_HOURS);
}

/**
 * Encode effort for a page image kept `retentionHours`. Unknown or unlimited retention
 * (null, undefined, non-finite or non-positive) is long-term and gets the default effort.
 *
 * This is the hook for any retention signal. Today that is the workspace's run retention
 * (`Document.artifactRetentionHours`, loaded by the worker store). Nothing sets an extract's
 * `retentionHours` yet; extract mode should set the same field when it lands.
 */
export function pageImageWebpEffort(args: { retentionHours?: number | null }, env: Env = process.env): number {
  const defaultEffort = readPageImageWebpEffort(env);
  const hours = args.retentionHours;
  if (typeof hours !== "number" || !Number.isFinite(hours) || hours <= 0) return defaultEffort;
  return hours < readPageImageWebpShortRetentionHours(env)
    ? Math.min(SHORT_RETENTION_PAGE_IMAGE_WEBP_EFFORT, defaultEffort)
    : defaultEffort;
}

/**
 * Pages where effort 6 buys too little. Measured 2026-10-26 on 27 rasters (150 dpi PDF pages,
 * scans and synthetic noise): above 0.5 PNG bytes per pixel (dense scans, photos), effort 6
 * saved at most 12% over effort 1 for 2-2.5x the CPU, which repays only after about 7 months of
 * storage; incompressible noise saved 0% (a 16 MP noise page took 5.7 s at effort 6 vs 2.4 s at
 * effort 1). Large rasters are capped for the same reason: encode time grows with pixels.
 */
export const INCOMPRESSIBLE_PNG_BYTES_PER_PIXEL = 0.5;
export const LARGE_PAGE_IMAGE_PIXELS = 8_000_000;

/**
 * Effort for one page: the retention-chosen effort, lowered to the short-retention effort
 * when the page is over 8 MP or its PNG is incompressible, so a hostile or noisy page cannot
 * buy expensive encodes that do not shrink it.
 */
export function pageImageEncodeEffort(args: { effort: number; widthPx: number; heightPx: number; pngBytes: number }): number {
  const pixels = args.widthPx * args.heightPx;
  if (args.effort <= SHORT_RETENTION_PAGE_IMAGE_WEBP_EFFORT || pixels <= 0) return args.effort;
  if (pixels > LARGE_PAGE_IMAGE_PIXELS || args.pngBytes / pixels > INCOMPRESSIBLE_PNG_BYTES_PER_PIXEL) {
    return SHORT_RETENTION_PAGE_IMAGE_WEBP_EFFORT;
  }
  return args.effort;
}

/**
 * Directory of one raster variant under `images/<documentId>/`. PNG keeps the v2 names so
 * existing objects are still found; WebP gets its own `-webp` suffix, so the two never collide.
 * The effort is not part of the key: lossless output decodes to the same pixels at any effort.
 */
export function pageImageVariantDir(args: { dpi: number; engine: "pdftoppm" | "native-pdf"; format: PageImageFormat }): string {
  const base = args.engine === "native-pdf" ? `v2-${args.dpi}dpi-native-pdf` : `v2-${args.dpi}dpi`;
  return args.format === "webp" ? `${base}-webp` : base;
}

export function pageImageKey(args: {
  root: string;
  documentId: string;
  dpi: number;
  engine: "pdftoppm" | "native-pdf";
  format: PageImageFormat;
  pageNumber: number;
}): string {
  return `${args.root}/images/${args.documentId}/${pageImageVariantDir(args)}/page-${args.pageNumber}.${args.format}`;
}

/** Media type from the leading bytes; null when the bytes are not a known raster format. */
export function sniffImageMimeType(bytes: Uint8Array): string | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.toString("ascii", 0, 6))) return "image/gif";
  return null;
}

/** Temp-file extension for a raster media type, so tools that look at names see the real format. */
export function rasterFileExtension(mimeType: string | null | undefined): string {
  switch (mimeType?.split(";")[0]?.trim().toLowerCase()) {
    case "image/webp": return ".webp";
    case "image/jpeg": return ".jpg";
    case "image/gif": return ".gif";
    default: return ".png";
  }
}

export function readPngDimensions(bytes: Buffer): { widthPx: number | null; heightPx: number | null } {
  if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG" || bytes.toString("ascii", 12, 16) !== "IHDR") {
    return { widthPx: null, heightPx: null };
  }
  return { widthPx: bytes.readUInt32BE(16), heightPx: bytes.readUInt32BE(20) };
}

/** Canvas size of a lossless (VP8L) or extended (VP8X) WebP; null for anything else. */
export function readWebpDimensions(bytes: Buffer): { widthPx: number; heightPx: number } | null {
  if (bytes.length < 30 || sniffImageMimeType(bytes) !== "image/webp") return null;
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { widthPx: (bits & 0x3fff) + 1, heightPx: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    return { widthPx: bytes.readUIntLE(24, 3) + 1, heightPx: bytes.readUIntLE(27, 3) + 1 };
  }
  return null;
}

/**
 * Same limits the renderers enforce (raster-bounds.ts): at most 4,096 px a side and 16 MP.
 * Checked again on the PNG before it is handed to the encoder.
 */
export const MAX_ENCODED_PAGE_IMAGE_EDGE_PX = 4_096;
export const MAX_ENCODED_PAGE_IMAGE_PIXELS = 16_000_000;
/** Output cap: 16 MP of RGBA, which lossless WebP never needs to exceed. */
export const MAX_ENCODED_PAGE_IMAGE_BYTES = 64 * 1024 * 1024;

export class OversizedPageImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OversizedPageImageError";
  }
}

export function assertEncodablePageRaster(dimensions: { widthPx: number | null; heightPx: number | null }, sizeBytes: number): { widthPx: number; heightPx: number } {
  const { widthPx, heightPx } = dimensions;
  if (!widthPx || !heightPx || widthPx < 1 || heightPx < 1) {
    throw new OversizedPageImageError("Page raster is not a readable PNG; refusing to encode");
  }
  if (widthPx > MAX_ENCODED_PAGE_IMAGE_EDGE_PX || heightPx > MAX_ENCODED_PAGE_IMAGE_EDGE_PX || widthPx * heightPx > MAX_ENCODED_PAGE_IMAGE_PIXELS) {
    throw new OversizedPageImageError(`Page raster ${widthPx}x${heightPx} exceeds the bounded raster limits; refusing to encode`);
  }
  if (sizeBytes > MAX_ENCODED_PAGE_IMAGE_BYTES) {
    throw new OversizedPageImageError(`Page raster is ${sizeBytes} bytes, over ${MAX_ENCODED_PAGE_IMAGE_BYTES}; refusing to encode`);
  }
  return { widthPx, heightPx };
}

export type WebpEncodeRunner = Pick<CommandRunner, "run"> & Partial<Pick<CommandRunner, "encodeLosslessWebp">>;

export type WebpEncodeResult =
  | { status: "encoded"; bytes: Buffer; widthPx: number; heightPx: number; effort: number; encodeMs: number }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; reason: string };

/**
 * Encode one bounded PNG (already on disk inside a DocSlurp temp workspace) to lossless WebP
 * with `cwebp` through the parser sandbox. Sandbox failures and aborts throw: they are never
 * turned into a format fallback. Returns `unavailable` when `cwebp` is not installed and
 * `failed` when it ran but produced no valid image, so the caller can keep the PNG.
 */
export async function encodeLosslessWebp(args: {
  runner: WebpEncodeRunner;
  pngPath: string;
  webpPath: string;
  png: Buffer;
  effort: number;
  signal?: AbortSignal;
}): Promise<WebpEncodeResult> {
  if (!args.runner.encodeLosslessWebp) return { status: "unavailable", reason: "runner cannot plan cwebp" };
  // The renderers already bound the raster; check the bytes again before the encoder sees them.
  const expected = assertEncodablePageRaster(readPngDimensions(args.png), args.png.byteLength);
  const effort = pageImageEncodeEffort({ effort: args.effort, ...expected, pngBytes: args.png.byteLength });
  const plan: CommandPlan = await args.runner.encodeLosslessWebp(args.pngPath, args.webpPath, effort);
  if (!plan.available) return { status: "unavailable", reason: "cwebp is not installed" };
  const started = Date.now();
  try {
    await args.runner.run(plan, args.signal);
  } catch (error) {
    if (args.signal?.aborted) throw error;
    // The PNG was rendered inside the sandbox; storing it runs nothing outside it, so any encode
    // failure (a remote image without cwebp, a sandbox refusal, a crash) keeps the PNG.
    const reason = `${error instanceof SandboxRunError ? "sandbox: " : ""}${error instanceof Error ? error.message : String(error)}`;
    return { status: missingBinary(reason) ? "unavailable" : "failed", reason };
  }
  const encodeMs = Date.now() - started;
  let size: number;
  try {
    size = (await stat(args.webpPath)).size;
  } catch {
    return { status: "failed", reason: "cwebp produced no output" };
  }
  if (size > MAX_ENCODED_PAGE_IMAGE_BYTES) return { status: "failed", reason: `cwebp output is ${size} bytes` };
  const bytes = await readFile(args.webpPath);
  const dimensions = readWebpDimensions(bytes);
  if (!dimensions || dimensions.widthPx !== expected.widthPx || dimensions.heightPx !== expected.heightPx) {
    return { status: "failed", reason: "cwebp output is not a lossless WebP of the rendered page size" };
  }
  return { status: "encoded", bytes, ...dimensions, effort, encodeMs };
}

/** A remote image without cwebp reports it as a failed command (exit 127, ENOENT, "not found"). */
function missingBinary(reason: string): boolean {
  return /\bENOENT\b|\(127\)|exit(?:ed)? 127|cwebp: (?:command )?not found|no such file or directory/i.test(reason);
}

let unavailableWarned = false;

/**
 * A WebP page image was stored as PNG instead. Loud on every path: a once-per-process
 * console warning for `unavailable`, a warning per page for `failed`, an OTLP log record,
 * span attributes and a `page-image-webp-fallback` performance metric each time.
 */
export function reportPageImageFormatFallback(args: { status: "unavailable" | "failed"; reason: string; pageNumber: number; documentId: string }): void {
  try {
    const perf = currentPerfContext();
    const line = `[page-image] WARNING storing PNG instead of WebP status=${args.status} document=${args.documentId} page=${args.pageNumber}`
      + `${perf ? ` run=${perf.runId} stage=${perf.stageName}` : ""} reason=${args.reason.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").slice(0, 200)}`;
    if (args.status === "failed" || !unavailableWarned) console.warn(line);
    if (args.status === "unavailable") unavailableWarned = true;
    const attributes = {
      "docslurp.page_image.format_fallback": args.status,
      "docslurp.page_image.fallback_reason": args.reason.slice(0, 4000),
      "docslurp.documentId": args.documentId,
      "docslurp.page_image.page": args.pageNumber,
      ...(perf ? { "docslurp.runId": perf.runId, "docslurp.stageName": perf.stageName } : {}),
    };
    emitTelemetryLog({ severityText: "warn", eventName: "docslurp.page_image.format_fallback", body: line.slice(0, 1000), attributes });
    setActiveSpanAttributes(attributes);
    pushPerfMetric({
      metric: "page-image-webp-fallback",
      value: 1,
      unit: "count",
      tags: ["page-image", `fallback:${args.status}`],
      metadata: { pageNumber: args.pageNumber, status: args.status, reason: args.reason.slice(0, 500) },
    });
  } catch {
    /* telemetry never changes the render outcome */
  }
}

/** Test hook: forget that the once-per-process warning was printed. */
export function resetPageImageFormatFallbackWarning(): void {
  unavailableWarned = false;
}

/**
 * Startup check, logged once and loudly rather than failing startup. A worker without cwebp
 * still renders and stores every page (as PNG, the previous behaviour), and the images already
 * require cwebp at build time (scripts/check-worker-prerequisites.mjs). Refusing to start would
 * turn a storage-cost regression into an ingestion outage. Returns whether cwebp is planned.
 */
export async function reportPageImageEncoderAtStartup(
  runner: Pick<CommandRunner, "encodeLosslessWebp">,
  env: Env = process.env,
): Promise<boolean> {
  if (readPageImageFormat(env) !== "webp") {
    console.log("[page-image] format=png (DOCSLURP_PAGE_IMAGE_FORMAT); page images are stored as PNG");
    return false;
  }
  const plan = await runner.encodeLosslessWebp("/nonexistent/page.png", "/nonexistent/page.webp", readPageImageWebpEffort(env)).catch(() => null);
  if (plan?.available) {
    console.log(`[page-image] format=webp encoder=cwebp default_effort=${readPageImageWebpEffort(env)} short_retention_hours=${readPageImageWebpShortRetentionHours(env)}`);
    return true;
  }
  const line = "[page-image] ERROR DOCSLURP_PAGE_IMAGE_FORMAT=webp but cwebp is not installed; every page image will be stored as PNG";
  console.error(line);
  try {
    emitTelemetryLog({ severityText: "error", eventName: "docslurp.page_image.encoder", body: line, attributes: { "docslurp.page_image.encoder": "missing" } });
  } catch {
    /* telemetry is best effort */
  }
  unavailableWarned = true;
  return false;
}

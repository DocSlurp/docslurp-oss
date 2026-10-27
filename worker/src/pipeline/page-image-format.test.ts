import { afterEach, describe, expect, it, vi } from "vitest";

import { effectiveRasterDpi } from "../lib/raster-bounds.js";

import {
  assertEncodablePageRaster,
  DEFAULT_PAGE_IMAGE_WEBP_EFFORT,
  encodeLosslessWebp,
  OversizedPageImageError,
  pageImageKey,
  pageImageVariantDir,
  pageImageEncodeEffort,
  pageImageWebpEffort,
  reportPageImageEncoderAtStartup,
  rasterFileExtension,
  readPageImageFormat,
  readPageImageWebpEffort,
  readWebpDimensions,
  sniffImageMimeType,
} from "./page-image-format.js";

/** A PNG header (signature + IHDR) claiming `width` x `height`; enough for the dimension guard. */
function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

describe("pageImageWebpEffort", () => {
  it("uses effort 1 below the short-retention threshold and the default otherwise", () => {
    expect(pageImageWebpEffort({ retentionHours: 48 }, {})).toBe(1);
    expect(pageImageWebpEffort({ retentionHours: 720 }, {})).toBe(1);
    expect(pageImageWebpEffort({ retentionHours: 2_999 }, {})).toBe(1);
    expect(pageImageWebpEffort({ retentionHours: 3_000 }, {})).toBe(6);
    expect(pageImageWebpEffort({ retentionHours: 87_600 }, {})).toBe(6);
  });

  it("treats unknown or unlimited retention as long-term", () => {
    for (const retentionHours of [undefined, null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pageImageWebpEffort({ retentionHours }, {})).toBe(DEFAULT_PAGE_IMAGE_WEBP_EFFORT);
    }
  });

  it("honours the effort and threshold env vars and ignores invalid values", () => {
    expect(pageImageWebpEffort({ retentionHours: 10_000 }, { DOCSLURP_PAGE_IMAGE_WEBP_EFFORT: "3" })).toBe(3);
    expect(pageImageWebpEffort({ retentionHours: 10_000 }, { DOCSLURP_PAGE_IMAGE_WEBP_SHORT_RETENTION_HOURS: "20000" })).toBe(1);
    expect(pageImageWebpEffort({ retentionHours: 100 }, { DOCSLURP_PAGE_IMAGE_WEBP_SHORT_RETENTION_HOURS: "50" })).toBe(6);
    // A default below the short-retention effort is never raised.
    expect(pageImageWebpEffort({ retentionHours: 10 }, { DOCSLURP_PAGE_IMAGE_WEBP_EFFORT: "0" })).toBe(0);
    for (const value of ["10", "-1", "2.5", "high", ""]) {
      expect(readPageImageWebpEffort({ DOCSLURP_PAGE_IMAGE_WEBP_EFFORT: value })).toBe(6);
    }
    expect(pageImageWebpEffort({ retentionHours: 10 }, { DOCSLURP_PAGE_IMAGE_WEBP_SHORT_RETENTION_HOURS: "soon" })).toBe(1);
  });
});

describe("page image format and keys", () => {
  it("defaults to webp and switches to png only when asked", () => {
    expect(readPageImageFormat({})).toBe("webp");
    expect(readPageImageFormat({ DOCSLURP_PAGE_IMAGE_FORMAT: " PNG " })).toBe("png");
    expect(readPageImageFormat({ DOCSLURP_PAGE_IMAGE_FORMAT: "webp" })).toBe("webp");
    expect(readPageImageFormat({ DOCSLURP_PAGE_IMAGE_FORMAT: "avif" })).toBe("webp");
  });

  it("keeps the v2 PNG keys and gives WebP a separate key space", () => {
    const base = { root: "user/run", documentId: "doc", dpi: 150, pageNumber: 7 };
    expect(pageImageKey({ ...base, engine: "pdftoppm", format: "png" })).toBe("user/run/images/doc/v2-150dpi/page-7.png");
    expect(pageImageKey({ ...base, engine: "native-pdf", format: "png" })).toBe("user/run/images/doc/v2-150dpi-native-pdf/page-7.png");
    expect(pageImageKey({ ...base, engine: "pdftoppm", format: "webp" })).toBe("user/run/images/doc/v2-150dpi-webp/page-7.webp");
    expect(pageImageKey({ ...base, engine: "native-pdf", format: "webp" })).toBe("user/run/images/doc/v2-150dpi-native-pdf-webp/page-7.webp");
    const variants = (["pdftoppm", "native-pdf"] as const).flatMap((engine) =>
      (["png", "webp"] as const).map((format) => pageImageVariantDir({ dpi: 150, engine, format })));
    expect(new Set(variants).size).toBe(4);
  });

  it("sniffs media types from bytes and maps them to file extensions", () => {
    expect(sniffImageMimeType(pngHeader(1, 1))).toBe("image/png");
    expect(sniffImageMimeType(Buffer.from("RIFF\0\0\0\0WEBPVP8L", "latin1"))).toBe("image/webp");
    expect(sniffImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageMimeType(Buffer.from("GIF89a"))).toBe("image/gif");
    expect(sniffImageMimeType(Buffer.from("%PDF-1.7"))).toBeNull();
    expect(rasterFileExtension("image/webp")).toBe(".webp");
    expect(rasterFileExtension("image/png")).toBe(".png");
    expect(rasterFileExtension(undefined)).toBe(".png");
  });

  it("reads lossless WebP canvas sizes", () => {
    const bytes = Buffer.alloc(30);
    bytes.write("RIFF", 0, "ascii");
    bytes.write("WEBP", 8, "ascii");
    bytes.write("VP8L", 12, "ascii");
    bytes[20] = 0x2f;
    bytes.writeUInt32LE((1200 - 1) | ((1553 - 1) << 14), 21);
    expect(readWebpDimensions(bytes)).toEqual({ widthPx: 1200, heightPx: 1553 });
    expect(readWebpDimensions(pngHeader(10, 10))).toBeNull();
  });
});

describe("encode guard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses rasters past the bounded raster limits before cwebp runs", async () => {
    expect(() => assertEncodablePageRaster({ widthPx: 4_097, heightPx: 10 }, 100)).toThrow(OversizedPageImageError);
    expect(() => assertEncodablePageRaster({ widthPx: 4_000, heightPx: 4_001 }, 100)).toThrow(OversizedPageImageError);
    expect(() => assertEncodablePageRaster({ widthPx: null, heightPx: null }, 100)).toThrow(OversizedPageImageError);
    expect(assertEncodablePageRaster({ widthPx: 4_000, heightPx: 4_000 }, 100)).toEqual({ widthPx: 4_000, heightPx: 4_000 });

    const run = vi.fn();
    const runner = {
      run,
      encodeLosslessWebp: vi.fn(async () => ({ binary: "cwebp", args: [], available: true })),
    };
    // A PNG header claiming 20,000 x 20,000 (a decompression bomb) never reaches the encoder.
    await expect(encodeLosslessWebp({
      runner: runner as never,
      pngPath: "/tmp/docslurp-x/page.png",
      webpPath: "/tmp/docslurp-x/page.webp",
      png: pngHeader(20_000, 20_000),
      effort: 6,
    })).rejects.toThrow(OversizedPageImageError);
    expect(run).not.toHaveBeenCalled();
  });

  it("reports a missing cwebp as unavailable without running anything", async () => {
    const run = vi.fn();
    const result = await encodeLosslessWebp({
      runner: { run, encodeLosslessWebp: async () => ({ binary: "cwebp", args: [], available: false }) } as never,
      pngPath: "/tmp/docslurp-x/page.png",
      webpPath: "/tmp/docslurp-x/page.webp",
      png: pngHeader(10, 10),
      effort: 6,
    });
    expect(result.status).toBe("unavailable");
    expect(run).not.toHaveBeenCalled();
  });
});

describe("per-page effort and density", () => {
  it("drops to effort 1 for pages over 8 MP or with incompressible PNGs", () => {
    const page = { widthPx: 1275, heightPx: 1650 };
    expect(pageImageEncodeEffort({ effort: 6, ...page, pngBytes: 0.1 * 1275 * 1650 })).toBe(6);
    expect(pageImageEncodeEffort({ effort: 6, ...page, pngBytes: 0.6 * 1275 * 1650 })).toBe(1);
    expect(pageImageEncodeEffort({ effort: 6, widthPx: 4000, heightPx: 4000, pngBytes: 1000 })).toBe(1);
    expect(pageImageEncodeEffort({ effort: 0, widthPx: 4000, heightPx: 4000, pngBytes: 1e9 })).toBe(0);
  });

  it("computes the density a bounded page actually renders at", () => {
    expect(effectiveRasterDpi(612, 792, 150)).toBe(150);
    expect(Math.round(effectiveRasterDpi(792, 1224, 300))).toBe(235);
  });

  it("reports a missing cwebp loudly at startup instead of failing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const missing = { encodeLosslessWebp: async () => ({ binary: "cwebp", args: [], available: false }) };
    expect(await reportPageImageEncoderAtStartup(missing as never, {})).toBe(false);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("cwebp is not installed"));
    const present = { encodeLosslessWebp: async () => ({ binary: "cwebp", args: [], available: true }) };
    expect(await reportPageImageEncoderAtStartup(present as never, {})).toBe(true);
    expect(await reportPageImageEncoderAtStartup(missing as never, { DOCSLURP_PAGE_IMAGE_FORMAT: "png" })).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalled();
  });

  it("treats a remote 'not found' as unavailable and other encode errors as failed", async () => {
    const png = pngHeader(10, 10);
    const encode = (message: string) => encodeLosslessWebp({
      runner: { run: async () => { throw new Error(message); }, encodeLosslessWebp: async () => ({ binary: "cwebp", args: [], available: true }) } as never,
      pngPath: "/tmp/docslurp-x/p.png", webpPath: "/tmp/docslurp-x/p.webp", png, effort: 6,
    });
    expect((await encode("cwebp (127): sh: 1: cwebp: not found")).status).toBe("unavailable");
    expect((await encode("cwebp (1): Error! Cannot read input picture")).status).toBe("failed");
  });
});

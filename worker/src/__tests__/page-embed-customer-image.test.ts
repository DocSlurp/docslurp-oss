import { defaultPipelineFeatures } from "@docslurp/shared";
import { describe, expect, it, vi } from "vitest";

const decodes = vi.hoisted(() => [] as Buffer[]);
const options = vi.hoisted(() => [] as unknown[]);
vi.mock("sharp", () => ({
  default: (input: Buffer, opts?: unknown) => {
    decodes.push(Buffer.from(input));
    options.push(opts);
    const chain = { rotate: () => chain, resize: () => chain, flatten: () => chain, jpeg: () => chain, toBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]) };
    return chain;
  },
}));

import { pageRenditionKey, RENDITION_MAGIC } from "../lib/page-rendition.js";
import type { Document } from "../models.js";
import { embedPageImages, type PageEmbedDeps } from "../stages/page-embed.js";

/** Council A: an uploaded image's own bytes are never decoded in the worker; page-image embedding reads only the OCR boundary's rendition. */
const CUSTOMER_BYTES = Buffer.from("customer original image bytes");
const PIXELS = Buffer.alloc(4 * 3 * 3, 0x7f);
const RENDITION = Buffer.concat([RENDITION_MAGIC, Buffer.from([0, 0, 0, 4, 0, 0, 0, 3]), PIXELS]);

function document(format: string, mimeType: string, pageCount = 2): Document {
  return {
    id: "doc-1", userId: "u", runId: "run-1", filename: "scan.png", mimeType, sourceKey: "k", status: "queued", extractionMode: "hybrid",
    pageCount, createdAt: new Date(), updatedAt: new Date(),
    fileFacts: { declaredMimeType: mimeType, sniffedMimeType: mimeType, mimeType, format, container: null, encoding: null, mismatch: "none" },
  } as unknown as Document;
}

function deps(objects: Map<string, Buffer>, rasters = vi.fn()) {
  const embedImages = vi.fn(async (images: unknown[]) => ({ vectors: images.map(() => [1, 0, 0, 0]), inputTokens: 10, costCents: 0.01 }));
  const sql = Object.assign(vi.fn(async () => []), { }) as unknown as PageEmbedDeps["sql"];
  (sql as unknown as { (strings: TemplateStringsArray, ...values: unknown[]): unknown }) ;
  return {
    deps: {
      sql: new Proxy(sql as object, { apply: async () => [], get: (_t, key) => (key === "then" ? undefined : () => []) }) as never,
      rasters: { renderSelectedPages: rasters },
      storage: { getBytes: vi.fn(async (key: string) => { const value = objects.get(key); if (!value) throw new Error("NoSuchKey"); return value; }), deleteKeys: vi.fn(async () => undefined) },
      embedder: { provider: "p", model: "m", dims: 4, embedImages },
      usage: { record: vi.fn(), chargeRichPage: vi.fn() },
    } as unknown as PageEmbedDeps,
    embedImages,
    rasters,
  };
}

const run = { id: "run-1", orgId: "o", projectId: "w", pipeline: { ...defaultPipelineFeatures, quality: "auto" as const } };

describe("page-embed on an uploaded image", () => {
  it("embeds the OCR boundary's rendition and never decodes the customer's own bytes", async () => {
    const doc = document("image", "image/png", 2);
    const { deps: d, embedImages, rasters } = deps(new Map([[pageRenditionKey(doc, 1), RENDITION]]));
    decodes.length = 0;
    options.length = 0;
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await embedPageImages(d, { document: doc, pages: [1, 2], run });
    expect(rasters).not.toHaveBeenCalled();
    // sharp receives only the rendition's pixels, as raw RGB with the pixel cap: no encoded image, so no decoder runs.
    expect(decodes).toEqual([PIXELS]);
    expect(options).toEqual([{ raw: { width: 4, height: 3, channels: 3 }, limitInputPixels: 1024 * 1024, failOn: "error" }]);
    expect(decodes.some((bytes) => bytes.equals(CUSTOMER_BYTES))).toBe(false);
    expect(embedImages).toHaveBeenCalledTimes(1);
    expect(result.embeddedPages).toEqual([1]);
    // Page 2 had no rendition: skipped and reported, not decoded from the original.
    expect(result.skippedWithoutRendition).toEqual([2]);
    expect(error.mock.calls.flat().join(" ")).toContain("without an OCR-boundary rendition");
    error.mockRestore();
  });

  it("re-validates a stored rendition at read time: a PNG, a short body or oversized dimensions reach no decoder", async () => {
    const doc = document("image", "image/png", 3);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4, 0, 0, 0, 3]);
    const huge = Buffer.concat([RENDITION_MAGIC, Buffer.from([0, 0, 0x10, 0, 0, 0, 0, 1])]);
    const { deps: d, embedImages } = deps(new Map([
      [pageRenditionKey(doc, 1), png], [pageRenditionKey(doc, 2), RENDITION.subarray(0, RENDITION.length - 1)], [pageRenditionKey(doc, 3), huge],
    ]));
    decodes.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await embedPageImages(d, { document: doc, pages: [1, 2, 3], run });
    expect(decodes).toEqual([]);
    expect(embedImages).not.toHaveBeenCalled();
    expect(result.skippedWithoutRendition).toEqual([1, 2, 3]);
  });

  it("skips loudly when no page has a rendition (VM missing or failed), decoding nothing", async () => {
    const doc = document("image", "image/jpeg", 1);
    const { deps: d, embedImages } = deps(new Map());
    decodes.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await embedPageImages(d, { document: doc, pages: [1], run });
    expect(result).toMatchObject({ stoppedBy: "no-vm-rendition", embeddedPages: [], skippedWithoutRendition: [1] });
    expect(decodes).toEqual([]);
    expect(embedImages).not.toHaveBeenCalled();
  });

  it("refuses a raster marked as the customer's original on the PDF path (backstop)", async () => {
    const doc = document("pdf", "application/pdf", 1);
    const rasters = vi.fn(async () => [{ pageNumber: 1, artifactKey: "k1", artifactUri: "s3://b/k1", widthPx: null, heightPx: null, sizeBytes: 3, cacheHit: true, mimeType: "image/jpeg", customerOriginal: true }]);
    const { deps: d } = deps(new Map([["k1", CUSTOMER_BYTES]]), rasters as never);
    decodes.length = 0;
    await expect(embedPageImages(d, { document: doc, pages: [1], run })).rejects.toThrow(/refused to decode the customer's original/);
    expect(decodes).toEqual([]);
  });
});

import { defaultPipelineFeatures } from "@docslurp/shared";
import { describe, expect, it, vi } from "vitest";

const decodes = vi.hoisted(() => vi.fn());
vi.mock("sharp", () => ({ default: (...args: unknown[]) => { decodes(...args); throw new Error("sharp decoded bytes in-process"); } }));

import type { Document } from "../models.js";
import { embedPageImages, type PageEmbedDeps } from "../stages/page-embed.js";

/** Council A: an uploaded image's page image is the customer's own bytes; it is never decoded by sharp/libvips in the worker. */
function deps(rasters: PageEmbedDeps["rasters"]["renderSelectedPages"]) {
  const embedImages = vi.fn();
  return {
    deps: {
      sql: Object.assign(vi.fn(async () => []), { }) as never,
      rasters: { renderSelectedPages: rasters },
      storage: { getBytes: vi.fn(async () => new Uint8Array([0xff, 0xd8, 0xff])), deleteKeys: vi.fn(async () => undefined) },
      embedder: { provider: "p", model: "m", dims: 4, embedImages },
      usage: { record: vi.fn(), chargeRichPage: vi.fn() },
    } as unknown as PageEmbedDeps,
    embedImages,
  };
}

const run = { id: "run-1", orgId: "o", workspaceId: "w", pipeline: { ...defaultPipelineFeatures, quality: "auto" as const } };

function document(format: string, mimeType: string): Document {
  return {
    id: "doc-1", userId: "u", runId: "run-1", filename: "scan.pdf", mimeType, sourceKey: "k", status: "queued", extractionMode: "hybrid",
    pageCount: 1, createdAt: new Date(), updatedAt: new Date(),
    fileFacts: { declaredMimeType: "application/pdf", sniffedMimeType: mimeType, mimeType, format, container: null, encoding: null, mismatch: "none" },
  } as unknown as Document;
}

describe("page-embed never decodes a customer's uploaded image in-process", () => {
  it("skips an image upload loudly, before rendering, decoding or embedding anything", async () => {
    const renderSelectedPages = vi.fn();
    const { deps: d, embedImages } = deps(renderSelectedPages);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await embedPageImages(d, { document: document("image", "image/jpeg"), pages: [1], run });
    expect(result).toMatchObject({ stoppedBy: "customer-image-not-decoded", embeddedPages: [] });
    expect(renderSelectedPages).not.toHaveBeenCalled();
    expect(decodes).not.toHaveBeenCalled();
    expect(embedImages).not.toHaveBeenCalled();
    expect(error.mock.calls.flat().join(" ")).toContain("customer image not decoded in-process");
    error.mockRestore();
  });

  it("refuses a raster marked as the customer's original even on a PDF path (backstop)", async () => {
    const renderSelectedPages = vi.fn(async () => [{ pageNumber: 1, artifactKey: "k1", artifactUri: "s3://b/k1", widthPx: null, heightPx: null, sizeBytes: 3, cacheHit: true, mimeType: "image/jpeg", customerOriginal: true }]);
    const { deps: d } = deps(renderSelectedPages as never);
    await expect(embedPageImages(d, { document: document("pdf", "application/pdf"), pages: [1], run })).rejects.toThrow(/refused to decode the customer's original/);
    expect(decodes).not.toHaveBeenCalled();
  });
});

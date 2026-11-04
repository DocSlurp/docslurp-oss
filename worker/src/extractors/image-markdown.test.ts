import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mediaMapSchema, mergeImageResult, parseImageAnchorLine, type EmbeddedImageFacts } from "@docslurp/shared";
import { embeddedImageGraph, markdownImageAnchors, validateEmbeddedImageSet } from "./embedded-images.js";
import { anchorImageMarkdownFile, anchorImagesInMarkdown } from "./image-markdown.js";
import type { EmbeddedImageSet } from "./plugins.js";
import { imageFact } from "../test/image-facts.js";

const webp = Buffer.from("UklGRh4AAABXRUJQVlA4TBEAAAAvAYAAAAdQqCrUsv+BiOh/AAA=", "base64");
const sha = createHash("sha256").update(webp).digest("hex");
const chartSignals = { version: "pixel-signals@1" as const, lumaMean: 216, lumaStdDev: 62, bilevel: false, quantizedColors: 24, topColorShare: 0.7, saturation: 54, entropy: 1.7, edgeShare: 0.045, inkShare: 0.29, textBands: 2, bandPitchSpread: null, alphaMean: null, dhash: "00183868e8a8a8a8", sample: [134, 100] as [number, number] };

// A second asset with different bytes (a flipped payload byte; the host checks the hash, not pixels).
const webp2 = Buffer.from(webp); webp2[26] ^= 0xff;
const sha2 = createHash("sha256").update(webp2).digest("hex");
function set(placements: EmbeddedImageFacts[], pageCount = 3): EmbeddedImageSet {
  return { pageCount, first: 1, last: pageCount, minWidth: 1, minHeight: 1, encoding: "lossless-webp", placementSource: "content-stream",
    assets: ([{ sha256: sha, width: 2, height: 3, mediaType: "image/webp", bytes: webp }, { sha256: sha2, width: 2, height: 3, mediaType: "image/webp", bytes: webp2 }] as EmbeddedImageSet["assets"])
      .filter((a) => placements.some((p) => p.sha256 === a.sha256)), placements };
}
const fact = (over: Partial<EmbeddedImageFacts> & { pageNumber: number; occurrence: number }) =>
  imageFact({ role: "image", width: 2, height: 3, sha256: sha, ...over });
const anchor = (block: number, blocks: number) => ({ block, blocks, method: "aligned" as const, matchedBlocks: blocks });
const MD = "Intro paragraph.\n\nSecond paragraph.\fPage two body.\n\nMore body.\fPage three.";
const producer = { id: "test-images", optionsDigest: "test" };

describe("anchorImagesInMarkdown", () => {
  it("puts each routed-in image at its block, leaves other bytes alone and names the asset by artifact id", () => {
    const { markdown, outcome } = anchorImagesInMarkdown(MD, set([
      fact({ pageNumber: 1, occurrence: 0, signals: chartSignals, anchor: anchor(1, 2), alt: { text: "Revenue chart", source: "marked-content" } }),
      fact({ pageNumber: 2, occurrence: 1, signals: { ...chartSignals, dhash: "0123456789abcdef" }, anchor: anchor(2, 2), sha256: sha2, source: { ...imageFact({ pageNumber: 1, occurrence: 0, role: "image", width: 2, height: 3, sha256: sha }).source, objectId: { num: 9, gen: 0 }, inline: false } }),
    ]), "doc-1");
    expect(markdown).toBe(`Intro paragraph.\n\n![Revenue chart](docslurp-artifact:doc-1:${sha}.webp#p1o0)\n\nSecond paragraph.\fPage two body.\n\nMore body.\n\n![](docslurp-artifact:doc-1:${sha2}.webp#p2o1)\fPage three.`);
    expect(outcome).toMatchObject({ anchored: 2, omitted: 0, blockMismatch: 0 });
    expect(markdownImageAnchors(markdown)).toEqual(new Map([["p1o0", 1], ["p2o1", 2]]));
  });

  it("omits decorative, blank and masked images but reports them", () => {
    const { markdown, outcome } = anchorImagesInMarkdown(MD, set([
      fact({ pageNumber: 1, occurrence: 0, signals: { ...chartSignals, quantizedColors: 1, lumaStdDev: 0, edgeShare: 0 }, anchor: anchor(0, 2) }),
      fact({ pageNumber: 2, occurrence: 1, signals: chartSignals, anchor: anchor(0, 2), sha256: sha2 }),
      fact({ pageNumber: 2, occurrence: 2, role: "smask", maskOf: 1, signals: null, signalsUnavailable: "mask", sha256: sha2 }),
    ]), "doc-1");
    expect(outcome).toMatchObject({ anchored: 1, omitted: 2 });
    expect(markdown.match(/docslurp-artifact:/g)).toHaveLength(1);
    expect(markdown).not.toContain("#p1o0");
  });

  it("does not trust a block index when the two sides count blocks differently, nor a missing position", () => {
    const { markdown, outcome } = anchorImagesInMarkdown(MD, set([fact({ pageNumber: 1, occurrence: 0, signals: chartSignals, anchor: anchor(1, 5) })]), "doc-1");
    expect(outcome.blockMismatch).toBe(1);
    expect(markdown.split("\f")[0]!.endsWith(`#p1o0)`)).toBe(true);        // end of the page, not block 1
    const unplaced = anchorImagesInMarkdown(MD, set([fact({ pageNumber: 1, occurrence: 0, signals: chartSignals, anchor: null })]), "doc-1");
    expect(unplaced.outcome.blockMismatch).toBe(1);
    expect(unplaced.markdown.split("\f")[0]!.endsWith(`#p1o0)`)).toBe(true);
  });

  it("a page-slot count that is not the document's leaves the Markdown untouched", () => {
    const { markdown, outcome } = anchorImagesInMarkdown("one\ftwo", set([fact({ pageNumber: 1, occurrence: 0, signals: chartSignals })], 3), "doc-1");
    expect(markdown).toBe("one\ftwo");
    expect(outcome.reason).toBe("page-slots");
  });

  it("orders several images before one block top to bottom, and a hostile alt cannot break the reference", () => {
    const placement = (y: number) => ({ ...imageFact({ pageNumber: 1, occurrence: 0, role: "image", width: 2, height: 3, sha256: sha }).placement as Extract<EmbeddedImageFacts["placement"], { status: "known" }>, bbox: [10, y, 100, y + 50] as [number, number, number, number] });
    const { markdown } = anchorImagesInMarkdown("Only block.\f\f", set([
      fact({ pageNumber: 1, occurrence: 0, signals: chartSignals, anchor: anchor(0, 1), placement: placement(300), alt: { text: "](https://evil.example) [x", source: "struct-figure" } }),
      fact({ pageNumber: 1, occurrence: 1, signals: { ...chartSignals, dhash: "0123456789abcdef" }, anchor: anchor(0, 1), placement: placement(100), sha256: sha2 }),
    ]), "d");
    const lines = markdown.split("\f")[0]!.split("\n").filter(Boolean);
    expect(lines.map((l) => parseImageAnchorLine(l)?.anchor)).toEqual(["p1o1", "p1o0", undefined]);
    expect(parseImageAnchorLine(lines[1]!)?.alt).toBe("](https://evil.example) [x");
  });

  it("a later OCR result merges at the anchor and is replaced, not duplicated", () => {
    const { markdown } = anchorImagesInMarkdown(MD, set([fact({ pageNumber: 1, occurrence: 0, signals: chartSignals, anchor: anchor(1, 2) })]), "doc-1");
    const once = mergeImageResult(markdown, { pageNumber: 1, occurrence: 0 }, { kind: "ocr", text: "Quarterly totals" }).markdown;
    const twice = mergeImageResult(once, { pageNumber: 1, occurrence: 0 }, { kind: "ocr", text: "Quarterly totals, corrected" }).markdown;
    expect(twice.match(/Image text \(OCR\)/g)).toHaveLength(1);
    expect(twice).toContain("> **Image text (OCR):** Quarterly totals, corrected");
  });
});

describe("file rewrite and media map", () => {
  it("rewrites the Markdown atomically and the media map reports exactly what the Markdown holds", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "image-md-"));
    try {
      const images = set([
        fact({ pageNumber: 1, occurrence: 0, signals: chartSignals, anchor: anchor(1, 2) }),
        fact({ pageNumber: 2, occurrence: 1, signals: { ...chartSignals, quantizedColors: 1, lumaStdDev: 0, edgeShare: 0 }, anchor: anchor(0, 2), sha256: sha2 }),
      ]);
      const md = path.join(dir, "out.md");
      await writeFile(md, MD);
      const outcome = await anchorImageMarkdownFile({ markdownPath: md, images, sourceDocumentId: "doc-1" });
      expect(outcome).toMatchObject({ anchored: 1, omitted: 1 });
      const graph = await embeddedImageGraph({ images, producer, sourcePath: "s.pdf", sourceDocumentId: "doc-1", sourceHash: "a".repeat(64), pageCount: 3, targets: ["document/media-map"], scratchDir: dir, markdownPath: md, recordUsage: vi.fn() });
      const mapRef = graph.artifacts.find((a) => a.kind === "document/media-map")!;
      const map = mediaMapSchema.parse(JSON.parse(await readFile(mapRef.uri, "utf8")));
      expect(map.placementSource).toBe("content-stream");
      expect(map.images.map((i) => [i.route.action, i.route.reason, i.markdown.included, i.markdown.block])).toEqual([["keep", "unclassified-figure", true, 1], ["skip", "blank-or-solid", false, null]]);
      expect(map.routing.counts).toEqual({ keep: 1, skip: 1 });
      expect(graph.stats).toMatchObject({ images: 2, routed: 0, placementKnown: 2, inMarkdown: 1 });
      expect(graph.steps).toEqual(["test-images"]);
      const asset = graph.artifacts.find((a) => a.kind === "page/embedded-image")!;
      expect(asset.producer.id).toBe("test-images");
      expect(asset.placements[0]).toMatchObject({ bbox: [72, 72, 372, 372], coordinateSpace: "pdf-points", fidelity: "exact" });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("a provider's image set is validated before it can become an artifact or a reference", () => {
  const good = () => set([fact({ pageNumber: 1, occurrence: 0, signals: chartSignals, anchor: anchor(0, 1) })], 1);
  it("accepts the unmodified set", () => expect(() => validateEmbeddedImageSet(good(), 1)).not.toThrow());
  it.each([
    ["an unknown field", (s: any) => { s.placements[0].extra = 1; }],
    ["a coverage above 1", (s: any) => { s.placements[0].placement.coverage = 3; }],
    ["a non-finite size", (s: any) => { s.placements[0].placement.widthPt = null; }],
    ["a free-text reason", (s: any) => { s.placements[0].placement = { status: "unknown", reason: "Has spaces <b>" }; }],
    ["a colour space outside the enum", (s: any) => { s.placements[0].source.colorSpace = "<script>"; }],
    ["a malformed perceptual hash", (s: any) => { s.placements[0].signals.dhash = "zz"; }],
    ["an anchor past its own block count", (s: any) => { s.placements[0].anchor.block = 9; }],
    ["alt text over the limit", (s: any) => { s.placements[0].alt = { text: "x".repeat(2000), source: "marked-content" }; }],
    ["a bounding box that is not ordered", (s: any) => { s.placements[0].placement.bbox = [10, 10, 5, 5]; }],
    ["an asset whose bytes do not hash to its name", (s: any) => { s.assets[0].bytes = webp2; }],
    ["a placement with no asset", (s: any) => { s.placements[0].sha256 = "f".repeat(64); }],
    ["a placement whose size disagrees with its asset", (s: any) => { s.placements[0].width = 9; }],
    ["a duplicate occurrence", (s: any) => { s.placements.push({ ...s.placements[0] }); }],
    ["a mask of an image that does not exist", (s: any) => { s.placements[0].role = "smask"; s.placements[0].maskOf = 7; s.placements[0].anchor = null; }],
    ["a page range that is not the document's", (s: any) => { s.last = 2; }],
    ["an unsupported media type", (s: any) => { s.assets[0].mediaType = "image/svg+xml"; }],
  ])("rejects %s", (_name, mutate) => {
    const value = good();
    mutate(value);
    expect(() => validateEmbeddedImageSet(value, 1)).toThrow();
  });
});

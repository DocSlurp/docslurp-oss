import { describe, expect, it } from "vitest";

import { IMAGE_ROUTING, planImageRouting, routeCounts } from "./image-routing.js";
import { embeddedImageFactsSchema, type EmbeddedImageFacts, type ImageClass, type PixelSignals } from "./media-map.js";

// Hand-built signals, not measurements: round values chosen to sit well inside one class each. The boundary tests below
// move one field at a time to the edge of its threshold and one step past it.
const flat: PixelSignals = { version: "pixel-signals@1", lumaMean: 255, lumaStdDev: 0, bilevel: true, quantizedColors: 1, topColorShare: 1, saturation: 0, entropy: 0, edgeShare: 0, inkShare: 0, textBands: 0, bandPitchSpread: null, alphaMean: null, dhash: "0000000000000000", sample: [8, 8] };
const textual: PixelSignals = { ...flat, lumaMean: 230, lumaStdDev: 30, bilevel: false, quantizedColors: 8, topColorShare: 0.7, entropy: 3, edgeShare: 0.2, inkShare: 0.1, textBands: 50, bandPitchSpread: 0.1, dhash: "1111111111111111" };
const photoish: PixelSignals = { ...flat, lumaMean: 128, lumaStdDev: 50, bilevel: false, quantizedColors: 512, topColorShare: 0.05, saturation: 80, entropy: 7, edgeShare: 0.1, inkShare: 0.3, textBands: 4, dhash: "f0e0c08010203040" };
const chartish: PixelSignals = { ...flat, lumaMean: 220, lumaStdDev: 60, bilevel: false, quantizedColors: 16, topColorShare: 0.6, saturation: 50, entropy: 2, edgeShare: 0.05, inkShare: 0.3, textBands: 4, dhash: "00ff00ff00ff00ff" };

function image(over: Partial<EmbeddedImageFacts> & { coverage?: number; bbox?: [number, number, number, number]; pageTextOps?: number } = {}): EmbeddedImageFacts {
  const { coverage = 0.3, bbox = [100, 200, 400, 500], pageTextOps = 0, ...rest } = over;
  return {
    pageNumber: 1, occurrence: 0, role: "image", width: 800, height: 600, sha256: "a".repeat(64),
    source: { objectId: { num: 10, gen: 0 }, inline: false, encoding: "jpeg", colorSpace: "rgb", components: 3, bitsPerComponent: 8, interpolate: false, ppi: [150, 150], streamBytes: 5000 },
    placement: { status: "known", validatedBy: "sequence", bbox, widthPt: bbox[2] - bbox[0], heightPt: bbox[3] - bbox[1], rotationDegrees: 0, mirrored: false, coverage,
      pageWidthPt: 612, pageHeightPt: 792, drawOrder: 0, pageDraws: 1, textOpsBefore: 0, pageTextOps, effectivePpi: [150, 150] },
    alt: null, signals: photoish, signalsUnavailable: null, anchor: null, ...rest,
  };
}

const plan = (images: EmbeddedImageFacts[], pageCount = 10) => planImageRouting(images, { pageCount });

describe("embedded image facts schema", () => {
  it("accepts a complete record and rejects unknown, out-of-range and malformed fields", () => {
    expect(embeddedImageFactsSchema.safeParse(image()).success).toBe(true);
    expect(embeddedImageFactsSchema.safeParse({ ...image(), extra: 1 }).success).toBe(false);
    expect(embeddedImageFactsSchema.safeParse(image({ sha256: "xyz" })).success).toBe(false);
    const hostile = image();
    (hostile.placement as { coverage: number }).coverage = 7;
    expect(embeddedImageFactsSchema.safeParse(hostile).success).toBe(false);
    const nan = image();
    (nan.placement as { widthPt: number }).widthPt = Number.NaN;
    expect(embeddedImageFactsSchema.safeParse(nan).success).toBe(false);
    expect(embeddedImageFactsSchema.safeParse(image({ placement: { status: "unknown", reason: "encrypted" } })).success).toBe(true);
    expect(embeddedImageFactsSchema.safeParse(image({ placement: { status: "unknown", reason: "Has Spaces!" } })).success).toBe(false);
    expect(embeddedImageFactsSchema.safeParse(image({ signals: { ...photoish, dhash: "nothex" } })).success).toBe(false);
  });
});

describe("planImageRouting", () => {
  it("routes by class: scan to ocr, chart to vision, photo to label, uncertain to keep, flat to skip", () => {
    const planned = plan([
      image({ pageNumber: 1, signals: textual, coverage: 0.95, width: 1700, height: 2200, sha256: "1".repeat(64), source: { ...image().source, objectId: { num: 1, gen: 0 }, encoding: "ccitt" } }),
      image({ pageNumber: 2, signals: chartish, sha256: "2".repeat(64), source: { ...image().source, objectId: { num: 2, gen: 0 } } }),
      image({ pageNumber: 3, signals: photoish, sha256: "3".repeat(64), source: { ...image().source, objectId: { num: 3, gen: 0 } } }),
      image({ pageNumber: 4, signals: null, signalsUnavailable: "pillow-unavailable", sha256: "4".repeat(64), source: { ...image().source, objectId: { num: 4, gen: 0 } } }),
      image({ pageNumber: 5, signals: flat, sha256: "5".repeat(64), source: { ...image().source, objectId: { num: 5, gen: 0 } } }),
    ]);
    expect(planned.map((p) => [p.classification.label, p.route.action, p.route.reason, p.markdownIncluded])).toEqual([
      ["text-scan", "ocr", "text-bearing-scan", true],
      ["chart-diagram", "vision", "chart-or-diagram", true],
      ["photo", "label", "photo", true],
      ["figure", "keep", "signals-unavailable", true],
      ["blank", "skip", "blank-or-solid", false],
    ]);
  });

  it("a scan that already has a text layer is kept, not read again, and left out of the Markdown", () => {
    const [p] = plan([image({ signals: textual, coverage: 0.95, pageTextOps: 400, width: 1700, height: 2200 })]);
    expect(p).toMatchObject({ classification: { label: "text-scan" }, route: { action: "keep", reason: "text-layer-present" }, markdownIncluded: false });
  });

  it("the same logo on many pages is decorative, once however it recurs (object, content, or re-encoded)", () => {
    const logo = (page: number, mutate: Parameters<typeof image>[0]) => image({ pageNumber: page, width: 200, height: 80, coverage: 0.02, bbox: [50, 50, 150, 90], signals: { ...chartish, dhash: "00183868e8a8a8a8" }, ...mutate });
    const byObject = plan([1, 2, 3, 4].map((p) => logo(p, {})));
    expect(byObject.every((p) => p.route.action === "skip" && p.route.reason.startsWith("decorative:repeated-object"))).toBe(true);
    const byContent = plan([1, 2, 3, 4].map((p) => logo(p, { source: { ...image().source, objectId: { num: 100 + p, gen: 0 } } })));
    expect(byContent[0]!.route.reason).toMatch(/^decorative:repeated-content/);
    const reencoded = plan([1, 2, 3, 4].map((p) => logo(p, { sha256: String(p).repeat(64), source: { ...image().source, objectId: { num: 100 + p, gen: 0 } }, signals: { ...chartish, dhash: p === 3 ? "00183868e8a8a8a9" : "00183868e8a8a8a8" } })));
    expect(reencoded[0]!.route.reason).toMatch(/^decorative:repeated-similar/);
    // On only two pages it is not furniture: the first routes, the second is a duplicate of it.
    const twice = plan([logo(1, { coverage: 0.3, bbox: [100, 200, 400, 500] }), logo(5, { coverage: 0.3, bbox: [100, 200, 400, 500] })]);
    expect(twice[0]!.route.action).not.toBe("skip");
    expect(twice[1]!.route).toEqual({ action: "skip", reason: "duplicate-of:1.0" });
  });

  it("a different scan on every page is never furniture", () => {
    const scans = [1, 2, 3, 4, 5].map((p) => image({ pageNumber: p, signals: textual, coverage: 0.95, width: 1700, height: 2200, sha256: String(p).repeat(64),
      source: { ...image().source, objectId: { num: 20 + p, gen: 0 } }, ...{ } }));
    // Eight bands in the same place on every page are text lines, but the pictures differ: hashes differ.
    scans.forEach((s, i) => { s.signals = { ...textual, dhash: `${(i + 1).toString(16).repeat(16)}` }; });
    expect(plan(scans).map((p) => p.route.action)).toEqual(["ocr", "ocr", "ocr", "ocr", "ocr"]);
  });

  it("tiny, rule and header or footer images are decorative; their shape decides, not the pixels", () => {
    const tiny = plan([image({ width: 24, height: 24, coverage: 0.001, bbox: [10, 10, 20, 20] })])[0]!;
    expect(tiny.route).toMatchObject({ action: "skip" });
    const rule = plan([image({ width: 2000, height: 20, coverage: 0.01, bbox: [50, 300, 560, 310] })])[0]!;
    expect(rule.route.reason).toBe("decorative:rule");
    const footer = plan([image({ width: 600, height: 120, coverage: 0.03, bbox: [200, 740, 400, 780] })])[0]!;
    expect(footer.route.reason).toBe("decorative:header-footer-band");
    const bigAtTop = plan([image({ coverage: 0.4, bbox: [0, 0, 612, 300] })])[0]!;
    expect(bigAtTop.route.action).not.toBe("skip");
  });

  it("masks are kept with their image, never routed or referenced", () => {
    const planned = plan([image(), image({ role: "smask", occurrence: 1, maskOf: 0, sha256: "b".repeat(64) })]);
    expect(planned[1]).toMatchObject({ classification: { label: "mask" }, route: { action: "keep", reason: "mask-of-image" }, markdownIncluded: false });
  });

  it("unknown placement never invents position-based decisions", () => {
    const p = plan([image({ placement: { status: "unknown", reason: "encrypted" }, signals: textual, width: 1700, height: 2200 })])[0]!;
    expect(p.classification.label).toBe("text-scan");
    const small = plan([image({ placement: { status: "unknown", reason: "encrypted" }, width: 40, height: 40 })])[0]!;
    expect(small.route.reason).toBe("decorative:tiny");
    const photo = plan([image({ placement: { status: "unknown", reason: "encrypted" }, width: 800, height: 120 })])[0]!;
    expect(photo.route.action).not.toBe("skip");
  });

  it("without raster statistics a stored-bilevel full-page image is still a scan, but a colour image is not guessed", () => {
    const stencil = plan([image({ role: "stencil", signals: null, signalsUnavailable: "decode-failed", coverage: 0.98, width: 2000, height: 2800, source: { ...image().source, encoding: "ccitt", colorSpace: "-" } })])[0]!;
    expect(stencil).toMatchObject({ classification: { label: "text-scan", confidence: 0.6 }, route: { action: "ocr" } });
    const colour = plan([image({ signals: null, signalsUnavailable: "pillow-unavailable", coverage: 0.98 })])[0]!;
    expect(colour.classification.label).toBe("figure");
  });

  it("caps routed images per page and per document, keeping the largest", () => {
    const many = Array.from({ length: 12 }, (_, i) => image({ pageNumber: 1, occurrence: i, sha256: i.toString(16).padStart(2, "0").repeat(32), coverage: 0.05 + i * 0.05,
      source: { ...image().source, objectId: { num: 50 + i, gen: 0 } }, signals: { ...photoish, dhash: i.toString(16).padStart(1, "0").repeat(16) } }));
    const planned = plan(many, 1);
    const labelled = planned.filter((p) => p.route.action === "label");
    expect(labelled).toHaveLength(IMAGE_ROUTING.maxRoutedPerPage);
    expect(planned.filter((p) => p.route.reason === "routing-cap:page").every((p) => p.route.action === "keep")).toBe(true);
    expect(planned[11]!.route.action).toBe("label");       // the largest survived
    expect(routeCounts(planned)).toEqual({ label: 8, keep: 4 });
    const wide = Array.from({ length: 80 }, (_, i) => image({ pageNumber: i + 1, sha256: (i + 1).toString(16).padStart(2, "0").repeat(32), source: { ...image().source, objectId: { num: 200 + i, gen: 0 } }, signals: { ...photoish, dhash: ((i + 1) * 7919).toString(16).padStart(16, "0") } }));
    expect(plan(wide, 400).filter((p) => p.route.action === "label")).toHaveLength(IMAGE_ROUTING.maxRoutedPerDocument);
  });
});

describe("what is not a photograph", () => {
  it("a colourful, text-laden screenshot is an unclassified figure, not a photo to caption", () => {
    const screenshot: PixelSignals = { ...photoish, quantizedColors: 200, topColorShare: 0.3, entropy: 5.5, edgeShare: 0.1, inkShare: 0.25, textBands: 40, bandPitchSpread: 0.8 };
    const [p] = plan([image({ signals: screenshot })]);
    expect(p!.classification.label).toBe("figure");
    expect(p!.route.action).toBe("keep");
  });
});

describe("every class and route boundary of the threshold table", () => {
  const T = IMAGE_ROUTING;
  const labelOf = (over: Parameters<typeof image>[0], pageCount = 10) => plan([image(over)], pageCount)[0]!.classification.label;
  /** At the threshold the image is `cls`; one step past it, it is not. */
  const flips = (cls: ImageClass, at: Parameters<typeof image>[0], past: Parameters<typeof image>[0]) => {
    expect(labelOf(at), "at the threshold").toBe(cls);
    expect(labelOf(past), "one step past it").not.toBe(cls);
  };
  const scan = (signals: Partial<PixelSignals>, over: Parameters<typeof image>[0] = {}) => ({ width: 1700, height: 2200, coverage: 0.95, signals: { ...textual, ...signals }, ...over });
  const chart = (signals: Partial<PixelSignals>, over: Parameters<typeof image>[0] = {}) => ({ signals: { ...chartish, ...signals }, ...over });
  const photo = (signals: Partial<PixelSignals>, over: Parameters<typeof image>[0] = {}) => ({ signals: { ...photoish, ...signals }, ...over });

  it("blank: one colour, a flat field, or an inkless scan", () => {
    expect(labelOf({ signals: { ...chartish, quantizedColors: 1 } })).toBe("blank");
    const field = { ...flat, quantizedColors: 2, inkShare: 0.01, dhash: "0123456789abcdef" };
    flips("blank", { signals: { ...field, lumaStdDev: T.blankMaxLumaStdDev, edgeShare: T.blankMaxEdgeShare } },
      { signals: { ...field, lumaStdDev: T.blankMaxLumaStdDev + 0.01, edgeShare: T.blankMaxEdgeShare } });
    flips("blank", { signals: { ...field, lumaStdDev: T.blankMaxLumaStdDev, edgeShare: T.blankMaxEdgeShare } },
      { signals: { ...field, lumaStdDev: T.blankMaxLumaStdDev, edgeShare: T.blankMaxEdgeShare + 0.0001 } });
    const paper = { ...field, inkShare: T.blankScanMaxInkShare, edgeShare: T.blankMaxEdgeShare, lumaStdDev: T.blankScanMaxLumaStdDev };
    flips("blank", { signals: paper }, { signals: { ...paper, inkShare: T.blankScanMaxInkShare + 0.0001 } });
    flips("blank", { signals: paper }, { signals: { ...paper, lumaStdDev: T.blankScanMaxLumaStdDev + 0.01 } });
    expect(plan([image({ signals: paper })])[0]!.route).toEqual({ action: "skip", reason: "blank-or-solid" });
  });

  it("decorative by shape: tiny, tiny on the page, rule, header or footer band", () => {
    flips("decorative", { width: T.tinyMaxSidePx, height: 300, coverage: T.tinyMaxCoverage }, { width: T.tinyMaxSidePx + 1, height: 300, coverage: T.tinyMaxCoverage });
    flips("decorative", { width: T.tinyMaxSidePx, height: 300, coverage: T.tinyMaxCoverage }, { width: T.tinyMaxSidePx, height: 300, coverage: T.tinyMaxCoverage + 0.001 });
    flips("decorative", { bbox: [100, 200, 100 + T.tinyMaxSidePt - 0.1, 500] }, { bbox: [100, 200, 100 + T.tinyMaxSidePt, 500] });
    flips("decorative", { width: 20 * T.ruleMinAspectRatio, height: 20 }, { width: 20 * T.ruleMinAspectRatio - 1, height: 20 });
    const band = T.furnitureBandShare * 792;
    flips("decorative", { coverage: T.furnitureBandMaxCoverage, bbox: [200, 10, 400, band] }, { coverage: T.furnitureBandMaxCoverage + 0.001, bbox: [200, 10, 400, band] });
    flips("decorative", { coverage: T.furnitureBandMaxCoverage, bbox: [200, 792 - band, 400, 780] }, { coverage: T.furnitureBandMaxCoverage, bbox: [200, 792 - band - 0.1, 400, 780] });
    expect(labelOf({ placement: { status: "unknown", reason: "encrypted" }, width: T.tinyMaxSidePx, height: T.tinyMaxSidePx })).toBe("decorative");
    expect(labelOf({ placement: { status: "unknown", reason: "encrypted" }, width: T.tinyMaxSidePx + 1, height: T.tinyMaxSidePx })).not.toBe("decorative");
  });

  it("decorative by repetition: the page count and share floors, and the near-duplicate hash and shape limits", () => {
    const pages = T.repeatedMinPages;
    const pageCount = Math.floor(pages / T.repeatedMinShare);
    const logo = (page: number, signals: Partial<PixelSignals> = {}, over: Parameters<typeof image>[0] = {}) => image({
      pageNumber: page, sha256: page.toString(16).padStart(64, "0"), source: { ...image().source, objectId: { num: 300 + page, gen: 0 } }, signals: { ...chartish, ...signals }, ...over,
    });
    const reasons = (images: EmbeddedImageFacts[], count: number) => planImageRouting(images, { pageCount: count }).map((p) => p.route.reason);
    const onPages = (n: number) => Array.from({ length: n }, (_, i) => logo(i + 1));
    expect(reasons(onPages(pages), pageCount)[0]).toBe(`decorative:repeated-similar-${pages}-pages`);
    expect(reasons(onPages(pages - 1), pageCount)[0]).toBe("chart-or-diagram");
    expect(reasons(onPages(pages), pageCount + 1)[0]).toBe("chart-or-diagram"); // under the share floor
    // Hamming distance: 0x0 -> 0xf flips four bits; one more nibble flips a fifth.
    const near = (dhash: string) => [logo(1), logo(2, { dhash }), logo(3, { dhash })];
    expect(reasons(near("f0ff00ff00ff00ff"), pageCount)[0]).toMatch(/^decorative:repeated-similar/);
    expect(reasons(near("f8ff00ff00ff00ff"), pageCount)[0]).toBe("chart-or-diagram");
    // Aspect ratio: 200x160 (1.25) against 180x160 (1.125) differs by exactly the limit (0.1); 179 wide is past it.
    const shaped = (width: number) => [logo(1, {}, { width: 200, height: 160 }), logo(2, {}, { width, height: 160 }), logo(3, {}, { width, height: 160 })];
    expect(T.nearDuplicateMaxAspectRatioDelta).toBe(0.1);
    expect(reasons(shaped(180), pageCount)[0]).toMatch(/^decorative:repeated-similar/);
    expect(reasons(shaped(179), pageCount)[0]).toBe("chart-or-diagram");
    // Flat pictures never count as near duplicates of each other.
    expect(reasons([1, 2, 3].map((p) => logo(p, { edgeShare: 0.0019, lumaStdDev: 30 })), pageCount)[0]).not.toMatch(/^decorative/);
  });

  it("text-scan: band count and regularity, ink share, page size and colour", () => {
    flips("text-scan", scan({ textBands: T.textScanMinBands }), scan({ textBands: T.textScanMinBands - 1 }));
    flips("text-scan", scan({ bandPitchSpread: T.textScanMaxBandPitchSpread }), scan({ bandPitchSpread: T.textScanMaxBandPitchSpread + 0.01 }));
    expect(labelOf(scan({ bandPitchSpread: null }))).toBe("text-scan");
    flips("text-scan", scan({ inkShare: T.textScanMinInkShare }), scan({ inkShare: T.textScanMinInkShare - 0.0001 }));
    flips("text-scan", scan({ inkShare: T.textScanMaxInkShare }), scan({ inkShare: T.textScanMaxInkShare + 0.01 }));
    flips("text-scan", scan({}, { coverage: T.textScanMinCoverage }), scan({}, { coverage: T.textScanMinCoverage - 0.01 }));
    const unplaced = { placement: { status: "unknown", reason: "encrypted" } } as const;
    flips("text-scan", scan({}, { ...unplaced, width: 1000, height: 800 }), scan({}, { ...unplaced, width: 999, height: 800 }));
    // Colour: any one of bilevel, few colours or low saturation is enough; all three failing is not a scan.
    const colourful = { quantizedColors: T.textScanMaxColors + 1, saturation: T.textScanMaxSaturation, bilevel: false };
    flips("text-scan", scan({ ...colourful, quantizedColors: T.textScanMaxColors }), scan(colourful));
    flips("text-scan", scan({ ...colourful, saturation: T.textScanMaxSaturation - 0.1 }), scan(colourful));
    expect(labelOf(scan({ ...colourful, bilevel: true }))).toBe("text-scan");
  });

  it("text-scan routes: ocr unless the page already has a text layer", () => {
    const routeOf = (pageTextOps: number) => plan([image(scan({}, { pageTextOps }))])[0]!.route;
    expect(routeOf(T.textLayerPresentMinTextOps)).toEqual({ action: "keep", reason: "text-layer-present" });
    expect(routeOf(T.textLayerPresentMinTextOps - 1)).toEqual({ action: "ocr", reason: "text-bearing-scan" });
  });

  it("text-scan without raster statistics: only a stored-bilevel image of page size", () => {
    const stored = (encoding: EmbeddedImageFacts["source"]["encoding"], coverage: number, role: EmbeddedImageFacts["role"] = "image") =>
      ({ role, coverage, signals: null, signalsUnavailable: "decode-failed", source: { ...image().source, encoding } });
    flips("text-scan", stored("ccitt", T.bilevelScanMinCoverage), stored("ccitt", T.bilevelScanMinCoverage - 0.01));
    expect(labelOf(stored("jbig2", T.bilevelScanMinCoverage))).toBe("text-scan");
    expect(labelOf(stored("image", T.bilevelScanMinCoverage, "stencil"))).toBe("text-scan");
    expect(labelOf(stored("jpeg", 1))).toBe("figure");
  });

  it("chart-diagram: colours, entropy, ground, edges, size and bands", () => {
    flips("chart-diagram", chart({ quantizedColors: T.chartMaxColors }), chart({ quantizedColors: T.chartMaxColors + 1 }));
    flips("chart-diagram", chart({ entropy: T.chartMaxEntropy }), chart({ entropy: T.chartMaxEntropy + 0.01 }));
    flips("chart-diagram", chart({ topColorShare: T.chartMinTopColorShare }), chart({ topColorShare: T.chartMinTopColorShare - 0.01 }));
    flips("chart-diagram", chart({ edgeShare: T.chartMinEdgeShare }), chart({ edgeShare: T.chartMinEdgeShare - 0.0001 }));
    flips("chart-diagram", chart({ edgeShare: T.chartMaxEdgeShare }), chart({ edgeShare: T.chartMaxEdgeShare + 0.01 }));
    flips("chart-diagram", chart({}, { width: T.chartMinSidePx, height: 600 }), chart({}, { width: T.chartMinSidePx - 1, height: 600 }));
    flips("chart-diagram", chart({}, { coverage: T.chartMinCoverage }), chart({}, { coverage: T.chartMinCoverage - 0.001 }));
    // Irregular bands so the text-scan shape does not decide first.
    flips("chart-diagram", chart({ textBands: T.chartMaxBands, bandPitchSpread: 0.9 }), chart({ textBands: T.chartMaxBands + 1, bandPitchSpread: 0.9 }));
    expect(labelOf(chart({ textBands: T.textScanMinBands, bandPitchSpread: 0.1 }))).not.toBe("chart-diagram");
    expect(plan([image(chart({}))])[0]!.route).toEqual({ action: "vision", reason: "chart-or-diagram" });
  });

  it("photo: colours, entropy, no dominant ground, few bands and room", () => {
    flips("photo", photo({ quantizedColors: T.photoMinColors }), photo({ quantizedColors: T.photoMinColors - 1 }));
    flips("photo", photo({ entropy: T.photoMinEntropy }), photo({ entropy: T.photoMinEntropy - 0.01 }));
    flips("photo", photo({ topColorShare: T.photoMaxTopColorShare }), photo({ topColorShare: T.photoMaxTopColorShare + 0.01 }));
    flips("photo", photo({ textBands: T.photoMaxBands }), photo({ textBands: T.photoMaxBands + 1 }));
    flips("photo", photo({}, { width: T.chartMinSidePx, height: 600 }), photo({}, { width: T.chartMinSidePx - 1, height: 600 }));
    expect(plan([image(photo({}))])[0]!.route).toEqual({ action: "label", reason: "photo" });
    expect(plan([image(photo({ entropy: T.photoMinEntropy - 0.01 }))])[0]!.route).toEqual({ action: "keep", reason: "unclassified-figure" });
  });
});

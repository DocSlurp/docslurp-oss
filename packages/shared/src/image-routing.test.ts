import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { IMAGE_ROUTING, planImageRouting, routeCounts } from "./image-routing.js";
import { embeddedImageFactsSchema, type EmbeddedImageFacts, type ImageClass, type PixelSignals } from "./media-map.js";

type Corpus = { entries: Array<{ label: string; width: number; height: number; coverage: number; encoding: EmbeddedImageFacts["source"]["encoding"]; role: "image"; signals: PixelSignals | null }> };
const corpus = JSON.parse(readFileSync(new URL("../test-vectors/image-routing-corpus.json", import.meta.url), "utf8")) as Corpus;

const flat: PixelSignals = { version: "pixel-signals@1", lumaMean: 255, lumaStdDev: 0, bilevel: true, quantizedColors: 1, topColorShare: 1, saturation: 0, entropy: 0, edgeShare: 0, inkShare: 0, textBands: 0, bandPitchSpread: null, alphaMean: null, dhash: "0000000000000000", sample: [8, 8] };
const textual: PixelSignals = { ...flat, lumaMean: 233, lumaStdDev: 34, quantizedColors: 10, topColorShare: 0.67, entropy: 3, edgeShare: 0.3, inkShare: 0.12, textBands: 40, bandPitchSpread: 0.04, dhash: "90909090909090d0" };
const photoish: PixelSignals = { ...flat, lumaMean: 142, lumaStdDev: 21, bilevel: false, quantizedColors: 305, topColorShare: 0.013, saturation: 94, entropy: 6.4, edgeShare: 0.005, dhash: "f0e0c08010203040" };
const chartish: PixelSignals = { ...flat, lumaMean: 216, lumaStdDev: 62, bilevel: false, quantizedColors: 24, topColorShare: 0.7, saturation: 54, entropy: 1.7, edgeShare: 0.045, inkShare: 0.29, textBands: 2, dhash: "00183868e8a8a8a8" };

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
    const screenshot: PixelSignals = { ...photoish, quantizedColors: 195, topColorShare: 0.29, entropy: 5.45, edgeShare: 0.1, inkShare: 0.27, textBands: 41, bandPitchSpread: 0.78 };
    const [p] = plan([image({ signals: screenshot })]);
    expect(p!.classification.label).toBe("figure");
    expect(p!.route.action).toBe("keep");
  });
});

describe("classification accuracy on the authored raster corpus", () => {
  const labels: Record<string, ImageClass> = { "text-scan": "text-scan", "chart-diagram": "chart-diagram", photo: "photo", blank: "blank" };
  const results = corpus.entries.map((entry, index) => {
    const planned = plan([image({
      occurrence: 0, pageNumber: index + 1, width: entry.width, height: entry.height, coverage: entry.coverage, signals: entry.signals,
      sha256: index.toString(16).padStart(4, "0").repeat(16), bbox: [60, 80, 60 + 400 * entry.coverage, 80 + 400 * entry.coverage],
      source: { ...image().source, encoding: entry.encoding, objectId: { num: index + 1, gen: 0 } },
    })], 200)[0]!;
    return { expected: labels[entry.label]!, got: planned.classification.label };
  });

  it("meets the recorded per-class floors (print the confusion matrix with VITEST_VERBOSE_ROUTING=1)", () => {
    const classes = ["text-scan", "chart-diagram", "photo", "blank"] as const;
    const matrix: Record<string, Record<string, number>> = {};
    for (const r of results) { matrix[r.expected] ??= {}; matrix[r.expected]![r.got] = (matrix[r.expected]![r.got] ?? 0) + 1; }
    if (process.env.VITEST_VERBOSE_ROUTING) console.log(JSON.stringify(matrix, null, 1));
    for (const cls of classes) {
      const rows = results.filter((r) => r.expected === cls);
      const recall = rows.filter((r) => r.got === cls).length / rows.length;
      expect(recall, `${cls} recall`).toBeGreaterThanOrEqual(0.9);
    }
    const accuracy = results.filter((r) => r.expected === r.got).length / results.length;
    expect(accuracy).toBeGreaterThanOrEqual(0.92);
    // A photo is never called a scan or a chart's text-like bands, and vice versa: cross-confusion between the content classes.
    const confused = (a: string, b: string) => results.filter((r) => r.expected === a && r.got === b).length;
    expect(confused("photo", "text-scan") + confused("text-scan", "photo") + confused("chart-diagram", "text-scan")).toBe(0);
  });
});

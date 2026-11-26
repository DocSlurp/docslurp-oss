import { describe, expect, it } from "vitest";

import { plannedPdftoppmDimensions } from "../lib/raster-bounds.js";
import { parsePdfPageSizes } from "../pipeline/pdf-asset-cache.js";
import { parsePageSizesArtifact, serializePageSizes, type PageSizeBinding } from "../pipeline/pdf-page-sizes.js";

// DocSlurp/app issue 599: a render's pixel size comes from the host's own plan (pdfinfo's size and rotation, the edge the host
// chose), never from the PNG header the parser VM wrote.
describe("planned pdftoppm dimensions", () => {
  // Measured with poppler's pdftoppm (-png -cropbox -scale-to EDGE) on synthetic pages; 722 renders across 176 page sizes,
  // four rotations and seven edges matched the plan exactly. A sample of them, including the cases that need care.
  it.each([
    { size: [612, 792, 0], edge: 4000, px: [3091, 4000] },
    { size: [612, 792, 90], edge: 4000, px: [4000, 3091] },
    { size: [595.28, 841.89, 0], edge: 999, px: [707, 999] },
    { size: [1000, 300, 270], edge: 1275, px: [383, 1275] },
    { size: [200.5, 100.25, 0], edge: 999, px: [999, 500] },
    // The scaled long side lands just above an integer in floating point; pdftoppm still renders it at exactly the edge.
    { size: [160.612, 1283.6, 0], edge: 1001, px: [126, 1001] },
    { size: [2101.12, 1760.69, 0], edge: 1001, px: [1001, 839] },
    // A square page scales by its height: the width can come out a pixel wider.
    { size: [1283.6, 1283.6, 0], edge: 1001, px: [1002, 1001] },
    { size: [1283.6, 1283.6, 90], edge: 1001, px: [1001, 1002] },
    { size: [612, 612, 0], edge: 333, px: [334, 333] },
  ])("$size at edge $edge renders $px", ({ size: [widthPt, heightPt, rotate], edge, px }) => {
    expect(plannedPdftoppmDimensions({ widthPt: widthPt!, heightPt: heightPt!, rotate }, edge)).toEqual({ widthPx: px[0], heightPx: px[1] });
  });

  it("is unknown without a rotation or with nonsense input, never guessed", () => {
    expect(plannedPdftoppmDimensions({ widthPt: 612, heightPt: 792 }, 1650)).toBeNull();
    expect(plannedPdftoppmDimensions({ widthPt: 612, heightPt: 792, rotate: 45 }, 1650)).toBeNull();
    expect(plannedPdftoppmDimensions({ widthPt: Number.NaN, heightPt: 792, rotate: 0 }, 1650)).toBeNull();
    expect(plannedPdftoppmDimensions({ widthPt: 612, heightPt: 792, rotate: 0 }, 0)).toBeNull();
  });

  it("never exceeds the edge on the long side, whatever the page", () => {
    for (const [w, h] of [[1, 100_000], [100_000, 1], [3, 5000], [14_400, 14_400]] as const) {
      for (const rotate of [0, 90, 180, 270]) {
        const planned = plannedPdftoppmDimensions({ widthPt: w, heightPt: h, rotate }, 4000)!;
        expect(Math.min(planned.widthPx, planned.heightPx)).toBeGreaterThanOrEqual(1);
        expect(Math.max(planned.widthPx, planned.heightPx)).toBeLessThanOrEqual(4001);
      }
    }
  });
});

describe("pdfinfo rotation", () => {
  it("reads each page's rotation with its size", () => {
    const stdout = [
      "Title:           Page 9 rot: 90", "Pages:           3",
      "Page    1 size: 612 x 792 pts (letter)", "Page    1 rot:  0",
      "Page    2 size: 612 x 792 pts (letter)", "Page    2 rot:  90",
      "Page    3 size: 1000 x 300 pts", "Page    3 rot:  45",
    ].join("\n");
    const sizes = parsePdfPageSizes(stdout, 1, 3);
    expect(sizes.get(1)).toEqual({ widthPt: 612, heightPt: 792, rotate: 0 });
    expect(sizes.get(2)).toEqual({ widthPt: 612, heightPt: 792, rotate: 90 });
    // Not a rotation pdftoppm applies: unknown, so the render reports no planned size.
    expect(sizes.get(3)).toEqual({ widthPt: 1000, heightPt: 300 });
  });

  it("reads the unnumbered single-page form", () => {
    expect(parsePdfPageSizes("Pages:           1\nPage size:      612 x 792 pts (letter)\nPage rot:       270\n", 1, 1).get(1)).toEqual({ widthPt: 612, heightPt: 792, rotate: 270 });
  });

  it("stores rotations in the page-size artifact and still reads an artifact written without them", () => {
    const binding: PageSizeBinding = { runId: "run-1", userId: "user-1", documentId: "doc-1", sourceKey: "raw/doc-1", sourceSha256: "a".repeat(64), artifactRoot: "user-1/run-1", pageCount: 3 };
    const written = serializePageSizes(binding, new Map([[1, { widthPt: 612, heightPt: 792, rotate: 90 as const }], [2, { widthPt: 612, heightPt: 792 }]]));
    const parsed = parsePageSizesArtifact(written, binding);
    expect(parsed).toEqual({ ok: true, sizes: new Map([[1, { widthPt: 612, heightPt: 792, rotate: 90 }], [2, { widthPt: 612, heightPt: 792 }]]) });
    const forged = Buffer.from(written.toString("utf8").replace("[1,612,792,90]", "[1,612,792,45]"));
    expect(parsePageSizesArtifact(forged, binding)).toEqual({ ok: false, reason: "page" });
  });
});

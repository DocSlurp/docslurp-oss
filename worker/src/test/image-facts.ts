import type { EmbeddedImageFacts } from "@docslurp/shared";

/** A minimal valid producer record: a known mid-page placement and no statistics; override what a test cares about. */
export function imageFact(over: Partial<EmbeddedImageFacts> & Pick<EmbeddedImageFacts, "pageNumber" | "occurrence" | "role" | "width" | "height" | "sha256">): EmbeddedImageFacts {
  return {
    source: { objectId: null, inline: true, encoding: "image", colorSpace: "rgb", components: 3, bitsPerComponent: 8, interpolate: false, ppi: [null, null], streamBytes: null },
    placement: { status: "known", validatedBy: "sequence", bbox: [72, 72, 372, 372], widthPt: 300, heightPt: 300, rotationDegrees: 0, mirrored: false, coverage: 0.19,
      pageWidthPt: 612, pageHeightPt: 792, drawOrder: 0, pageDraws: 1, textOpsBefore: 0, pageTextOps: 0, effectivePpi: [1, 1] },
    alt: null, signals: null, signalsUnavailable: "pillow-unavailable", anchor: null,
    ...over,
  };
}

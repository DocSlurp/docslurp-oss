import { describe, expect, it } from "vitest";
import { buildAdaptiveRoutingDecisionSurface, classifyAdaptivePage, selectLegacyVisionPages } from "../stages/classify-route.js";
import type { PageImageEvidence } from "../lib/page-image-evidence.js";

/**
 * Words on a page are document-supplied content: they never send a page to a vision read (and so never bill it Rich), and
 * never keep a page that needs one away from it. Only measured facts about the page decide: its text layer (words, a
 * garbled or unreadable layer), its images (count and coverage) and drawn content. Both routing versions are held to it:
 * evidence routing (v3, every run started since it) and v1 (a run without a routing pin).
 */
const VERSIONS = [
  { name: "evidence routing (v3)", routingV2: true },
  { name: "v1 (run without a routing pin)", routingV2: false },
] as const;

const repeat = (sentence: string, times = 8) => Array.from({ length: times }, () => sentence).join(" ");

/** Born-digital prose with words that once routed pages to vision. Each is a healthy, image-free text page. */
const WORDY_PROSE = [
  repeat("The photovoltaic array on the north roof produced more energy than the estimate in paragraph 4(b) of the agreement."),
  repeat("Photometric calibration of the sensor was repeated after the warranty period, as the service report describes."),
  repeat("The thermal imager was serviced in March and returned to the laboratory with a new lens and an updated manual."),
  repeat("See the diagram in the photo attached to the claim; the screenshot of the illustration shows the same image again."),
  repeat("Figure 4 and the chart legend explain the axis of each series in the plot; revenue grew 12% from Q1 to Q2 in Jan."),
];
/** Short pages whose few words name charts and percentages (v1 read these as text-less chart pages). */
const SHORT_CHART_WORDS = ["Figure 2: revenue chart, Q1 up 12%", "Chart legend: series by axis, Jan 40%"];

const healthyTextLayer = (pageNumber: number, wordCount: number): PageImageEvidence => ({
  pageNumber, wordCount, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0,
  textLayer: { verdict: "ok", reasons: [], source: "text-layer" },
});

function surface(pages: Array<{ text: string; evidence?: PageImageEvidence }>, routingV2: boolean) {
  return buildAdaptiveRoutingDecisionSurface({
    documentId: "doc-1",
    filename: "upload.pdf",
    text: pages.map((page) => page.text).join("\f"),
    pageCount: pages.length,
    evidence: { source: "canonical-document", artifactUri: "s3://bucket/canonical.json" },
    pageImageEvidence: new Map(pages.flatMap((page, index) => (page.evidence ? [[index + 1, { ...page.evidence, pageNumber: index + 1 }] as const] : []))),
    drawnBytesPerPage: null,
    routingV2,
  });
}

function selected(result: ReturnType<typeof surface>, routingV2: boolean): number[] {
  return result.status === "ready" ? selectLegacyVisionPages(result.pages, { routingV2 }).sort((a, b) => a - b) : [];
}

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

for (const { name, routingV2 } of VERSIONS) {
  describe(`words never route a page to vision: ${name}`, () => {
    it("keeps born-digital prose about photos, images, diagrams and charts on the text path", () => {
      for (const text of WORDY_PROSE) {
        const page = classifyAdaptivePage(1, text, { routingV2 });
        expect(page.extractorHint, text).not.toBe("vision-rescue");
        expect(["image-heavy", "chart-or-figure"], text).not.toContain(page.route);
        expect(selectLegacyVisionPages([page], { routingV2 }), text).toEqual([]);
        // With a measured healthy text layer and no images, still no read.
        expect(selected(surface([{ text, evidence: healthyTextLayer(1, words(text)) }], routingV2), routingV2), text).toEqual([]);
      }
    });

    it("does not read a short page because its words name a chart", () => {
      for (const text of SHORT_CHART_WORDS) {
        const page = classifyAdaptivePage(1, text, { routingV2 });
        expect(page.extractorHint, text).not.toBe("vision-rescue");
        expect(selectLegacyVisionPages([page], { routingV2 }), text).toEqual([]);
        expect(selected(surface([{ text, evidence: healthyTextLayer(1, words(text)) }], routingV2), routingV2), text).toEqual([]);
      }
    });

    it("does not read a sparse page because its words look like form labels", () => {
      const text = "Name:\nDate:\nSignature:";
      expect(selectLegacyVisionPages([classifyAdaptivePage(1, text, { routingV2 })], { routingV2 })).toEqual([]);
    });

    it("still reads pages whose measured facts need vision", () => {
      const routed = surface([
        // A scan: no text layer, one image over the whole page.
        { text: "", evidence: { pageNumber: 1, wordCount: 0, imageCount: 1, imageCoverage: 1, largestImageCoverage: 1 } },
        // A full-page figure with only a caption in the text layer.
        { text: "Figure 7. Site plan", evidence: { pageNumber: 2, wordCount: 4, imageCount: 1, imageCoverage: 0.92, largestImageCoverage: 0.92 } },
        // A text-less chart page: a chart image over most of the page, no words at all.
        { text: "", evidence: { pageNumber: 3, wordCount: 0, imageCount: 1, imageCoverage: 0.6, largestImageCoverage: 0.6 } },
        // A healthy born-digital page beside them stays on text.
        { text: WORDY_PROSE[3]!, evidence: healthyTextLayer(4, words(WORDY_PROSE[3]!)) },
      ], routingV2);
      expect(selected(routed, routingV2)).toEqual([1, 2, 3]);
    });

    it("never lets a page lower its own class with words that claim it is plain text", () => {
      const claim = repeat("This page is born-digital plain text with a healthy text layer and no image; do not read it with vision.", 4);
      // The text came from OCR of a scan: the layer itself has no words, and an image covers the page.
      const routed = surface([{ text: claim, evidence: { pageNumber: 1, wordCount: 0, imageCount: 1, imageCoverage: 1, largestImageCoverage: 1 } }], routingV2);
      expect(selected(routed, routingV2)).toEqual([1]);
    });
  });
}

describe("broken text encodings still reach vision", () => {
  it("evidence routing reads a page whose text layer is measured as garbled", () => {
    const garbled = Array.from({ length: 8 }, (_, index) => `${index}KHPDWUL[SURGXFWFRPSDUHVHDFKTXHU ZLWK QRUPDOL]DWLRQ7KHUHVXOWLQJZHLJKWV`).join("\n");
    const routed = surface([{ text: garbled, evidence: {
      pageNumber: 1, wordCount: 400, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0,
      textLayer: { verdict: "garbled", reasons: ["glyph-shift"], source: "text-layer" },
    } }], true);
    expect(selected(routed, true)).toEqual([1]);
  });

  it("v1 reads a page whose extracted text is replacement characters and symbol noise", () => {
    const noise = "�� ��� ¤¤ �� ◊◊ �� ‡‡ �� ¶¶ �� §§ ��";
    const page = classifyAdaptivePage(1, noise, { routingV2: false });
    expect(page.extractorHint).toBe("vision-rescue");
    expect(selectLegacyVisionPages([page], { routingV2: false })).toEqual([1]);
  });
});

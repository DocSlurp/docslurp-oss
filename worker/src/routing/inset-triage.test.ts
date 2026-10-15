import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { ImageFact } from "@docslurp/shared";

import type { DecisionClient } from "./decision-client.js";
import {
  DEFAULT_INSET_TRIAGE_CONFIG,
  adjustPageTrust,
  buildInsetQuestions,
  buildInsetState,
  cropInset,
  insetCropRect,
  insetLabel,
  insetSkipReason,
  needsTranscriptionScore,
  parseInsetAnswers,
  roleForKind,
  triageInsets,
  type InsetAssessment,
} from "./inset-triage.js";
import { catalogModel } from "./routing-test-fixtures.js";

const model = catalogModel("perplexity/pplx-decider-v1.1-27b");
const PAGE = { widthPt: 612, heightPt: 792 };

function fact(index: number, x: number, y: number, width: number, height: number): ImageFact {
  return { index, bbox: { x, y, width, height }, coverage: (width * height) / (PAGE.widthPt * PAGE.heightPt) };
}

async function pageRender(): Promise<Buffer> {
  // 612x792 pt page rendered at 2 px/pt: white with a red block where the first inset sits.
  return await sharp({ create: { width: 1224, height: 1584, channels: 3, background: "#ffffff" } })
    .composite([{ input: await sharp({ create: { width: 400, height: 200, channels: 3, background: "#ff0000" } }).png().toBuffer(), left: 128, top: 300 }])
    .png()
    .toBuffer();
}

function choice(probabilities: Record<string, number>) {
  const [top] = Object.entries(probabilities).sort((a, b) => b[1] - a[1]);
  return { type: "choice" as const, choice: top![0], confidence: top![1], probabilities };
}

describe("free skip rules", () => {
  it("skips tiny, hairline and extreme-aspect images; keeps ordinary insets", () => {
    expect(insetSkipReason(fact(0, 10, 10, 8, 8))).toBe("tiny");
    expect(insetSkipReason({ index: 1, bbox: { x: 0, y: 0, width: 500, height: 10 }, coverage: 0.02 })).toBe("sliver");
    expect(insetSkipReason({ index: 2, bbox: { x: 0, y: 0, width: 600, height: 40 }, coverage: 0.05 })).toBe("aspect");
    expect(insetSkipReason(fact(3, 64, 140, 300, 200))).toBeNull();
  });
});

describe("crop geometry", () => {
  it("maps a point bbox to render pixels with padding and clips to the page", () => {
    const rect = insetCropRect({ x: 64, y: 150, width: 200, height: 100 }, PAGE, { width: 1224, height: 1584 }, 0.05);
    expect(rect).toEqual({ left: 108, top: 290, width: 440, height: 220 });
    const edge = insetCropRect({ x: 0, y: 0, width: 612, height: 792 }, PAGE, { width: 1224, height: 1584 }, 0.1);
    expect(edge).toEqual({ left: 0, top: 0, width: 1224, height: 1584 });
  });

  it("cuts the inset and resizes it to the tile long edge", async () => {
    const crop = await cropInset(await pageRender(), fact(0, 64, 150, 200, 100), PAGE, { ...DEFAULT_INSET_TRIAGE_CONFIG, padding: 0 });
    const meta = await sharp(crop.png).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(384);
    const { data } = await sharp(crop.png).raw().toBuffer({ resolveWithObject: true });
    expect([data[0], data[1], data[2]]).toEqual([255, 0, 0]);
  });
});

describe("questions and parsing", () => {
  it("keys questions per opaque image label with the image_kind choice", () => {
    const qs = buildInsetQuestions([insetLabel(0), insetLabel(1)], ["contains_table"]);
    expect(Object.keys(qs)).toEqual(["i01_image_kind", "i01_contains_table", "i02_image_kind", "i02_contains_table"]);
    expect(qs.i01_image_kind).toMatchObject({ type: "choice" });
    const state = buildInsetState([{ imageIndex: 0, bbox: { x: 0, y: 0, width: 1, height: 1 }, png: new Uint8Array([1]) }], ["I01"]);
    expect(state[0]).toBe("Image I01:");
  });

  it("derives kind, needs-transcription mass and role", () => {
    const parsed = parseInsetAnswers({ i01_image_kind: choice({ "table-as-image": 0.6, "scanned-text": 0.2, logo: 0.2 }) }, "I01", []);
    expect(parsed.kind).toBe("table-as-image");
    expect(parsed.needsTranscription).toBeCloseTo(0.8);
    expect(parsed.role).toBe("table");
    expect(() => parseInsetAnswers({}, "I01", [])).toThrow(/missing image_kind/);
    expect(needsTranscriptionScore({ logo: 1 })).toBe(0);
  });

  it("maps every kind to an assignment role", () => {
    expect(roleForKind("chart-graph")).toBe("chart-data");
    expect(roleForKind("equation-image")).toBe("math");
    expect(roleForKind("handwriting")).toBe("ocr");
    expect(roleForKind("decorative-photo")).toBe("image-label");
    expect(roleForKind("none")).toBe("skip");
  });
});

describe("triage + page trust adjustment", () => {
  it("asks once per surviving inset, skips tiny ones and flags the page", async () => {
    const calls: string[][] = [];
    const client: DecisionClient = {
      async ask(_model, state, questions) {
        calls.push(Object.keys(questions));
        expect((state as unknown[]).filter((p) => typeof p !== "string")).toHaveLength(1);
        return {
          answers: { i01_image_kind: choice({ "equation-image": 0.9, none: 0.1 }) },
          usage: { inputTokens: 300, outputTokens: 0 },
          latencyMs: 400,
          costCents: 0.001,
          model: "m",
          provider: "p",
        };
      },
    };
    const result = await triageInsets(client, model, {
      images: [fact(0, 64, 150, 200, 100), fact(1, 10, 10, 6, 6)],
      pageSizePt: PAGE,
      pageRender: await pageRender(),
    });
    expect(calls).toEqual([["i01_image_kind"]]);
    expect(result.skipped).toEqual([{ imageIndex: 1, reason: "tiny" }]);
    expect(result.usage.inputTokens).toBe(300);
    const adjust = adjustPageTrust(result.assessments);
    expect(adjust.canAcceptTextOnly).toBe(false);
    expect(adjust.insets).toEqual([expect.objectContaining({ imageIndex: 0, role: "math" })]);
  });

  it("cuts insets from native clips and only loads the full-page render when a clip is unavailable", async () => {
    const client: DecisionClient = {
      async ask(_m, _s, questions) {
        return { answers: Object.fromEntries(Object.keys(questions).map((k) => [k, choice({ "decorative-photo": 0.9, none: 0.1 })])) as never, usage: { inputTokens: 1, outputTokens: 0 }, latencyMs: 1, costCents: 0, model: "m", provider: "p" };
      },
    };
    const clip = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#00f" } }).png().toBuffer();
    const boxes: unknown[] = [];
    let loads = 0;
    const input = { images: [fact(0, 64, 150, 200, 100)], pageSizePt: PAGE };
    await triageInsets(client, model, { ...input, pageRender: async () => { loads += 1; return await pageRender(); }, renderClip: async (box) => { boxes.push(box); return clip; } });
    expect(loads).toBe(0);
    expect(boxes).toEqual([expect.objectContaining({ x: expect.any(Number), width: expect.any(Number) })]);
    await triageInsets(client, model, { ...input, pageRender: async () => { loads += 1; return await pageRender(); }, renderClip: async () => null });
    expect(loads).toBe(1);
  });

  it("keeps text-only acceptance for decorative insets and ignores whole-page scans", () => {
    const base = { bbox: { x: 0, y: 0, width: 10, height: 10 }, kindProbabilities: {}, flags: {} };
    const photo: InsetAssessment = { ...base, imageIndex: 0, coverage: 0.1, kind: "decorative-photo", needsTranscription: 0.02, role: "image-label" };
    const chart: InsetAssessment = { ...base, imageIndex: 1, coverage: 0.1, kind: "chart-graph", needsTranscription: 0.05, role: "chart-data" };
    const scan: InsetAssessment = { ...base, imageIndex: 2, coverage: 1, kind: "scanned-text", needsTranscription: 0.99, role: "ocr" };
    const adjust = adjustPageTrust([photo, chart, scan]);
    expect(adjust.canAcceptTextOnly).toBe(true);
    expect(adjust.fullPageInsets).toEqual([2]);
    expect(adjust.insets.map((i) => i.role)).toEqual(["image-label", "chart-data"]);
  });
});

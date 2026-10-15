/**
 * Image-scoped triage: a decision model looks at each inset image (a crop of the rendered page cut from the
 * probe's image bbox) instead of the whole-page thumbnail.
 *
 * Why: a page thumbnail is too coarse to see that a small inset is a table, an equation or a block of
 * scanned text, so whole-page questions barely separate pages whose native text layer is complete from
 * pages whose content lives in an image. A crop at 256-512 px long edge shows the inset at readable scale.
 *
 * Outcome per inset: an image kind (none / decorative-photo / logo / chart-graph / diagram / table-as-image /
 * equation-image / scanned-text / handwriting), a "needs transcription" probability and the assignment role
 * it implies. Page-level trust adjustment: if any inset needs transcription, the page cannot be
 * accept-text-only; the planner gets one image-scoped assignment per inset instead.
 *
 * Question wording is generic (criteria describe image classes). It must stay free of fixture names,
 * expected values and benchmark schemas.
 */

import type { AssignmentRole, BBox, DecisionModel, ImageFact, ImageKind } from "@docslurp/shared";
import sharp from "sharp";

import { prepareThumbnail, type TileLongEdge } from "./contact-sheet.js";
import {
  imageDataUrlPart,
  type DecisionAnswer,
  type DecisionCallResult,
  type DecisionClient,
  type DecisionQuestion,
  type DecisionStatePart,
} from "./decision-client.js";

export const INSET_IMAGE_KINDS: readonly ImageKind[] = [
  "none",
  "decorative-photo",
  "logo",
  "chart-graph",
  "diagram",
  "table-as-image",
  "equation-image",
  "scanned-text",
  "handwriting",
] as const;

/** Kinds whose content is not in the native text layer even when that layer is complete for the body text. */
export const TRANSCRIPTION_KINDS: readonly ImageKind[] = [
  "scanned-text",
  "table-as-image",
  "equation-image",
  "handwriting",
] as const;

/**
 * Short generic class descriptions. Descriptive multi-sentence criteria scored the same on the development
 * and calibration insets at +40% input tokens and a lower probability on the gold class, so the short form ships.
 */
export const INSET_KIND_CRITERIA: Record<ImageKind, string> = {
  none: "no image content",
  "decorative-photo": "photograph or illustration",
  logo: "logo or icon",
  "chart-graph": "chart or graph",
  diagram: "diagram or flowchart",
  "table-as-image": "table",
  "equation-image": "mathematical equation",
  "scanned-text": "scanned or photographed text",
  handwriting: "handwriting",
};

/** Optional yes/no flags (off by default: they added tokens and ranked "needs transcription" below the choice mass). */
export const INSET_FLAG_QUESTIONS = {
  contains_text:
    "Does the image contain a passage of readable text (sentences, paragraphs, lines of a document) that must be transcribed, as opposed to a short brand name, a chart label or decoration?",
  contains_table: "Does the image contain a data table, a grid of rows and columns of cell values?",
  contains_math: "Does the image contain a mathematical expression or equation?",
  contains_chart_values: "Does the image contain a chart or graph whose plotted data values would need to be read?",
} as const;
export type InsetFlag = keyof typeof INSET_FLAG_QUESTIONS;

export interface InsetTriageConfig {
  /** Crop long edge in px sent to the decision model. */
  tileLongEdge: TileLongEdge;
  /** Padding around the bbox as a fraction of the bbox width/height. */
  padding: number;
  /** Crops per decision call (named images "I01", "I02", ...). */
  batchSize: number;
  /** Extra yes/no flags asked next to the image_kind choice. */
  flags: readonly InsetFlag[];
  /** P(needs transcription) at or above this means the inset must be transcribed. */
  needsTranscriptionThreshold: number;
  /** Insets at or above this page coverage are whole-page scans: the page-level text-layer logic owns them. */
  fullPageCoverage: number;
  /** Free skip rules. */
  minCoverage: number;
  minSidePt: number;
  maxAspect: number;
}

export const DEFAULT_INSET_TRIAGE_CONFIG: InsetTriageConfig = {
  tileLongEdge: 384,
  padding: 0.05,
  batchSize: 1,
  flags: [],
  needsTranscriptionThreshold: 0.5,
  fullPageCoverage: 0.85,
  minCoverage: 0.004,
  minSidePt: 18,
  maxAspect: 12,
};

export function insetLabel(index: number): string {
  return `I${String(index + 1).padStart(2, "0")}`;
}

/** Free pre-filter: tiny, sliver-shaped or hairline images never earn a paid question. Returns the reason. */
export function insetSkipReason(image: ImageFact, config: InsetTriageConfig = DEFAULT_INSET_TRIAGE_CONFIG): string | null {
  const { width, height } = image.bbox;
  if (image.coverage < config.minCoverage) return "tiny";
  if (Math.min(width, height) < config.minSidePt) return "sliver";
  if (Math.max(width, height) / Math.max(Math.min(width, height), 1e-6) > config.maxAspect) return "aspect";
  return null;
}

export interface PixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** bbox padded by `padding` of its size on each side, clipped to the page (PDF points, top-left origin). */
export function paddedInsetBox(bbox: BBox, pageSizePt: { widthPt: number; heightPt: number }, padding: number): BBox {
  const x0 = Math.max(0, bbox.x - padding * bbox.width);
  const y0 = Math.max(0, bbox.y - padding * bbox.height);
  const x1 = Math.min(pageSizePt.widthPt, bbox.x + bbox.width * (1 + padding));
  const y1 = Math.min(pageSizePt.heightPt, bbox.y + bbox.height * (1 + padding));
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/** bbox (PDF points, top-left origin) -> padded pixel rect on a render of the page, clipped to the render. */
export function insetCropRect(
  bbox: BBox,
  pageSizePt: { widthPt: number; heightPt: number },
  renderPx: { width: number; height: number },
  padding: number,
): PixelRect {
  const sx = renderPx.width / pageSizePt.widthPt;
  const sy = renderPx.height / pageSizePt.heightPt;
  const x0 = Math.max(0, bbox.x - padding * bbox.width);
  const y0 = Math.max(0, bbox.y - padding * bbox.height);
  const x1 = Math.min(pageSizePt.widthPt, bbox.x + bbox.width * (1 + padding));
  const y1 = Math.min(pageSizePt.heightPt, bbox.y + bbox.height * (1 + padding));
  const left = Math.min(renderPx.width - 1, Math.max(0, Math.floor(x0 * sx)));
  const top = Math.min(renderPx.height - 1, Math.max(0, Math.floor(y0 * sy)));
  const width = Math.max(1, Math.min(renderPx.width - left, Math.ceil(x1 * sx) - left));
  const height = Math.max(1, Math.min(renderPx.height - top, Math.ceil(y1 * sy) - top));
  return { left, top, width, height };
}

export interface InsetCrop {
  imageIndex: number;
  bbox: BBox;
  /** PNG at the configured long edge. */
  png: Uint8Array;
}

/** Cuts one inset out of a rendered page (file path or encoded bytes) and normalizes it to the tile long edge. */
export async function cropInset(
  pageRender: string | Uint8Array,
  image: ImageFact,
  pageSizePt: { widthPt: number; heightPt: number },
  config: InsetTriageConfig = DEFAULT_INSET_TRIAGE_CONFIG,
): Promise<InsetCrop> {
  const meta = await sharp(pageRender).metadata();
  if (!meta.width || !meta.height) throw new Error("page render has no dimensions");
  const rect = insetCropRect(image.bbox, pageSizePt, { width: meta.width, height: meta.height }, config.padding);
  const cut = await sharp(pageRender).extract(rect).png().toBuffer();
  const tile = await prepareThumbnail({ pageNumber: image.index + 1, source: cut }, config.tileLongEdge);
  return { imageIndex: image.index, bbox: image.bbox, png: tile.png };
}

// ---- questions + state -----------------------------------------------------

/** Normalizes an already-cut inset image (e.g. a native clip render) to the tile long edge. */
export async function insetCropFromImage(image: ImageFact, source: Uint8Array, config: InsetTriageConfig = DEFAULT_INSET_TRIAGE_CONFIG): Promise<InsetCrop> {
  const tile = await prepareThumbnail({ pageNumber: image.index + 1, source }, config.tileLongEdge);
  return { imageIndex: image.index, bbox: image.bbox, png: tile.png };
}

/** Question set for named crops: `<label>_image_kind` (choice) plus one `<label>_<flag>` noul per flag. */
export function buildInsetQuestions(
  labels: readonly string[],
  flags: readonly InsetFlag[] = [],
): Record<string, DecisionQuestion> {
  const questions: Record<string, DecisionQuestion> = {};
  for (const label of labels) {
    const key = label.toLowerCase();
    questions[`${key}_image_kind`] = {
      type: "choice",
      instructions: `Image ${label}: what does this image show?`,
      criteria: { ...INSET_KIND_CRITERIA },
    };
    for (const flag of flags) {
      questions[`${key}_${flag}`] = {
        type: "noul",
        instructions: `Image ${label}: ${INSET_FLAG_QUESTIONS[flag]}`,
        criteria: { true: "yes", false: "no" },
      };
    }
  }
  return questions;
}

export function buildInsetState(crops: readonly InsetCrop[], labels: readonly string[]): DecisionStatePart[] {
  const parts: DecisionStatePart[] = [];
  crops.forEach((crop, i) => {
    parts.push(`Image ${labels[i]}:`, imageDataUrlPart(crop.png));
  });
  return parts;
}

// ---- parsing + roles ---------------------------------------------------------

export interface InsetAssessment {
  imageIndex: number;
  coverage: number;
  bbox: BBox;
  kind: ImageKind;
  kindProbabilities: Partial<Record<ImageKind, number>>;
  flags: Partial<Record<InsetFlag, number>>;
  /** P(the inset's content must be transcribed): mass on scanned-text / table-as-image / equation-image / handwriting. */
  needsTranscription: number;
  role: AssignmentRole;
}

export function roleForKind(kind: ImageKind): AssignmentRole {
  switch (kind) {
    case "chart-graph":
      return "chart-data";
    case "diagram":
      return "diagram";
    case "table-as-image":
      return "table";
    case "equation-image":
      return "math";
    case "scanned-text":
    case "handwriting":
      return "ocr";
    case "decorative-photo":
    case "logo":
      return "image-label";
    case "none":
      return "skip";
  }
}

export function needsTranscriptionScore(probabilities: Partial<Record<ImageKind, number>>): number {
  let mass = 0;
  for (const kind of TRANSCRIPTION_KINDS) mass += probabilities[kind] ?? 0;
  return Math.min(1, mass);
}

function topKind(probabilities: Partial<Record<ImageKind, number>>): ImageKind {
  let best: ImageKind = "none";
  let bestP = -1;
  for (const kind of INSET_IMAGE_KINDS) {
    const p = probabilities[kind] ?? 0;
    if (p > bestP) {
      best = kind;
      bestP = p;
    }
  }
  return best;
}

/** Parses the answers for one label; a missing or mistyped answer throws (a half-parsed triage skews routing). */
export function parseInsetAnswers(
  answers: Record<string, DecisionAnswer>,
  label: string,
  flags: readonly InsetFlag[],
): Pick<InsetAssessment, "kind" | "kindProbabilities" | "flags" | "needsTranscription" | "role"> {
  const key = label.toLowerCase();
  const kindAnswer = answers[`${key}_image_kind`];
  if (!kindAnswer || kindAnswer.type !== "choice") throw new Error(`inset triage: missing image_kind answer for ${label}`);
  const kindProbabilities: Partial<Record<ImageKind, number>> = {};
  for (const kind of INSET_IMAGE_KINDS) {
    const p = kindAnswer.probabilities[kind];
    if (typeof p === "number") kindProbabilities[kind] = p;
  }
  const parsedFlags: Partial<Record<InsetFlag, number>> = {};
  for (const flag of flags) {
    const answer = answers[`${key}_${flag}`];
    if (!answer || answer.type !== "noul") throw new Error(`inset triage: missing ${flag} answer for ${label}`);
    parsedFlags[flag] = answer.noul;
  }
  const kind = topKind(kindProbabilities);
  return {
    kind,
    kindProbabilities,
    flags: parsedFlags,
    needsTranscription: needsTranscriptionScore(kindProbabilities),
    role: roleForKind(kind),
  };
}

// ---- triage + page-level adjustment -------------------------------------------

export interface InsetTriageResult {
  assessments: InsetAssessment[];
  skipped: Array<{ imageIndex: number; reason: string }>;
  calls: number;
  usage: { inputTokens: number; outputTokens: number };
  costCents: number;
  latencyMs: number;
}

/**
 * Asks the decision model about every inset that survives the free skip rules. Crops are sent
 * `batchSize` at a time as named images; billing note: perplexity-style models multiply tokens by
 * state x questions, Clef/Jev-style endpoints do not.
 */
export async function triageInsets(
  client: DecisionClient,
  model: DecisionModel,
  input: {
    images: readonly ImageFact[];
    pageSizePt: { widthPt: number; heightPt: number };
    /** Full-page render to cut insets from; may be a lazy loader, only called when a clip is unavailable. */
    pageRender: string | Uint8Array | (() => Promise<string | Uint8Array | null>);
    /**
     * Renders just the padded inset box with the native raster engine (PDF_RASTER_ENGINE); null falls back to
     * cutting `pageRender`, so a full-page raster is only produced when a clip cannot be.
     */
    renderClip?: (box: BBox, image: ImageFact) => Promise<Uint8Array | null>;
  },
  config: InsetTriageConfig = DEFAULT_INSET_TRIAGE_CONFIG,
  opts: { signal?: AbortSignal } = {},
): Promise<InsetTriageResult> {
  const skipped: InsetTriageResult["skipped"] = [];
  const asked: ImageFact[] = [];
  for (const image of input.images) {
    const reason = insetSkipReason(image, config);
    if (reason) skipped.push({ imageIndex: image.index, reason });
    else asked.push(image);
  }
  const result: InsetTriageResult = {
    assessments: [],
    skipped,
    calls: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    costCents: 0,
    latencyMs: 0,
  };
  let renderPromise: Promise<string | Uint8Array | null> | undefined;
  const loadRender = (): Promise<string | Uint8Array | null> => {
    const source = input.pageRender;
    renderPromise ??= typeof source === "function" ? source() : Promise.resolve(source);
    return renderPromise;
  };
  const perCall = Math.max(1, Math.min(config.batchSize, model.modalities.maxImagesPerRequest || config.batchSize));
  for (let start = 0; start < asked.length; start += perCall) {
    const chunk = asked.slice(start, start + perCall);
    const labels = chunk.map((_, i) => insetLabel(i));
    const crops = await Promise.all(chunk.map(async (image) => {
      const clip = input.renderClip
        ? await input.renderClip(paddedInsetBox(image.bbox, input.pageSizePt, config.padding), image).catch(() => null)
        : null;
      if (clip) return insetCropFromImage(image, clip, config);
      const render = await loadRender();
      if (!render) throw new Error("page render unavailable");
      return cropInset(render, image, input.pageSizePt, config);
    }));
    const response: DecisionCallResult = await client.ask(
      model,
      buildInsetState(crops, labels),
      buildInsetQuestions(labels, config.flags),
      opts,
    );
    result.calls += 1;
    result.usage.inputTokens += response.usage.inputTokens;
    result.usage.outputTokens += response.usage.outputTokens;
    result.costCents += response.costCents;
    result.latencyMs += response.latencyMs;
    chunk.forEach((image, i) => {
      result.assessments.push({
        imageIndex: image.index,
        coverage: image.coverage,
        bbox: image.bbox,
        ...parseInsetAnswers(response.answers, labels[i]!, config.flags),
      });
    });
  }
  return result;
}

export interface InsetPlanEntry {
  imageIndex: number;
  bbox: BBox;
  role: AssignmentRole;
  reason: string;
}

export interface InsetTrustAdjustment {
  /** False when any inset needs transcription: the native text layer alone cannot cover the page. */
  canAcceptTextOnly: boolean;
  /** One image-scoped plan entry per non-skip inset (the planner turns each into an image-scope assignment). */
  insets: InsetPlanEntry[];
  /** Whole-page raster insets (coverage >= fullPageCoverage): excluded from the trust adjustment. */
  fullPageInsets: number[];
  maxNeedsTranscription: number;
}

export function adjustPageTrust(
  assessments: readonly InsetAssessment[],
  config: Pick<InsetTriageConfig, "needsTranscriptionThreshold" | "fullPageCoverage"> = DEFAULT_INSET_TRIAGE_CONFIG,
): InsetTrustAdjustment {
  let maxNeeds = 0;
  const insets: InsetPlanEntry[] = [];
  const fullPageInsets: number[] = [];
  for (const a of assessments) {
    if (a.coverage >= config.fullPageCoverage) {
      fullPageInsets.push(a.imageIndex);
      continue;
    }
    maxNeeds = Math.max(maxNeeds, a.needsTranscription);
    if (a.role === "skip") continue;
    const mustTranscribe = a.needsTranscription >= config.needsTranscriptionThreshold;
    insets.push({
      imageIndex: a.imageIndex,
      bbox: a.bbox,
      role: a.role,
      reason: mustTranscribe
        ? `inset ${a.kind} must be transcribed (p=${a.needsTranscription.toFixed(2)})`
        : `inset ${a.kind}`,
    });
  }
  return { canAcceptTextOnly: maxNeeds < config.needsTranscriptionThreshold, insets, fullPageInsets, maxNeedsTranscription: maxNeeds };
}

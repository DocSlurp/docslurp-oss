/**
 * Batched page triage with a decision model.
 *
 * Builds per-page question sets (attributes + capabilities + trust_text_layer
 * + image_kind choice) keyed `p07_<question>`, packs pages into requests that
 * respect the model's question and image limits, adds per-page TEXT FACTS from
 * the cheap native pass, and parses the answers back to `DecisionAnswers`.
 * Text-only models get a text state (facts + feature summary + text-layer
 * excerpt) instead of images. Missing, unexpected or mistyped answers reject
 * the whole request: a half-parsed triage would silently skew routing.
 */

import {
  decisionQuestionIds,
  imageKinds,
  type DecisionAnswers,
  type DecisionFormat,
  type DecisionModel,
  type DecisionQuestionId,
  type ImageKind,
  type ImageKindProbabilities,
  type PageInput,
  type TextFacts,
} from "@docslurp/shared";

import type {
  DecisionAnswer,
  DecisionCallResult,
  DecisionClient,
  DecisionQuestion,
  DecisionState,
  DecisionStatePart,
} from "./decision-client.js";
import { answerSignals, DecisionDegenerateError, detectDegenerate } from "./health/degenerate.js";
import {
  buildImageStateParts,
  pageLabel,
  type PageThumbnails,
  type TileLongEdge,
} from "./contact-sheet.js";

export const MAX_IMAGE_KIND_QUESTIONS_PER_PAGE = 4;

/**
 * Minimal content question set (TL1 + W4): the typed questions the free probe cannot answer. There is
 * deliberately no whole-page trust question (TL1: it hurts) and no image_kind choice (insets are
 * triaged as crops, see inset-triage.ts).
 */
export const CONTENT_QUESTION_IDS = ["plain_ocr_sufficient", "needs_math_extraction", "needs_table_structure"] as const;

/** Excerpt length of the native text layer shown next to the thumbnail (W4/TL1: 400 chars). */
export const CONTENT_EXCERPT_CHARS = 400;

/** Text-only models see no thumbnail, so their text state carries a longer excerpt (the evaluated range was ~1500 chars). */
export const TEXT_STATE_EXCERPT_CHARS = 1200;

const QUESTION_TEXT: Record<DecisionQuestionId, string> = {
  has_math: "Does this page contain mathematical formulas or equations?",
  has_table: "Does this page contain a data table?",
  degraded: "Is this page degraded (noisy scan, skew, stains, faded or low-contrast print)?",
  low_resolution: "Is this page rendered or scanned at a resolution too low to read small text reliably?",
  handwriting: "Does this page contain handwriting?",
  multi_column: "Is the main text laid out in multiple columns?",
  figure_heavy: "Is a large part of this page taken up by figures, charts, diagrams or photos?",
  text_layer_ok: "Is the page's embedded text layer likely to be present and readable?",
  native_text_faithful:
    "Given the page image and the text facts, is the native text layer a faithful transcription of the visible text?",
  plain_ocr_sufficient: "Would plain OCR capture this page's content without losing structure that matters?",
  needs_math_extraction: "Does this page need math-capable extraction to preserve its equations?",
  needs_table_structure: "Does this page need table-structure extraction to preserve its tables?",
  trust_text_layer:
    "Should the native text extraction be trusted as the full content of this page (a text-only page)?",
};

const IMAGE_KIND_CRITERIA: Record<ImageKind, string> = {
  none: "No image content",
  "decorative-photo": "Decorative photograph or illustration with no data content",
  logo: "Logo, icon or brand mark",
  "chart-graph": "Chart or graph encoding data",
  diagram: "Diagram, flowchart or schematic",
  "table-as-image": "A table rendered as an image",
  "equation-image": "Equation or formula rendered as an image",
  "scanned-text": "Scanned or photographed text",
  handwriting: "Handwritten content",
};

export class TriageParseError extends Error {
  constructor(message: string, readonly missing: string[] = [], readonly unexpected: string[] = []) {
    super(message);
    this.name = "TriageParseError";
  }
}

// ---- Facts ----------------------------------------------------------------

/** "P03: 412 words, 0 images, text layer ok" / "P05: unknown (no text layer)". */
export function textFactsLine(pageNumber: number, facts: TextFacts): string {
  const label = pageLabel(pageNumber);
  if (facts.textLayerStatus === "absent") return `${label}: unknown (no text layer)`;
  if (facts.wordCount === null && facts.textLayerStatus === "unknown") return `${label}: unknown`;
  const words = facts.wordCount === null ? "unknown words" : `${facts.wordCount} words`;
  const count = facts.imageCount;
  let images: string;
  if (count === null) images = "images unknown";
  else if (count === 0) images = "0 images";
  else {
    const cover = facts.imageCoverage === null ? "" : ` covering ${Math.round(facts.imageCoverage * 100)}%`;
    images = `${count} image${count === 1 ? "" : "s"}${cover}`;
  }
  const layer = facts.textLayerStatus === "ok" ? "text layer ok" : `text layer ${facts.textLayerStatus}`;
  return `${label}: ${words}, ${images}, ${layer}`;
}

export function featureSummaryLine(page: PageInput): string {
  const f = page.features;
  return (
    `${pageLabel(f.pageNumber)} features: chars=${f.native.charCount} fonts=${f.native.fontCount} ` +
    `mathGlyphRatio=${f.native.mathGlyphRatio} tableRuleScore=${f.native.tableRuleScore} ` +
    `unmappedGlyphRatio=${f.native.unmappedGlyphRatio} garbled=${f.native.garbled} ` +
    `imageCoverage=${f.raster.imageCoverage} fullPageImage=${f.raster.fullPageImage} ` +
    `vectorDrawings=${f.raster.vectorDrawingCount}`
  );
}

export function textFactsBlock(pages: readonly PageInput[]): string {
  return [
    "TEXT FACTS from the native text extraction (cheap pass):",
    ...pages.map((page) => textFactsLine(page.features.pageNumber, page.textFacts)),
  ].join("\n");
}

// ---- shouldTriage ---------------------------------------------------------

export interface TriageDecision {
  triage: boolean;
  reason: string;
}

const MATH_RATIO_TRIAGE_FLOOR = 0.02;

/** Skip rule: nothing to look at when every page has a healthy text layer and no images. */
export function shouldTriage(pages: readonly PageInput[]): TriageDecision {
  if (pages.length === 0) return { triage: false, reason: "no-pages" };
  for (const page of pages) {
    const { textFacts, features } = page;
    if (textFacts.textLayerStatus !== "ok") return { triage: true, reason: `page-${features.pageNumber}-text-layer-${textFacts.textLayerStatus}` };
    if (textFacts.imageCount === null || textFacts.imageCount > 0 || page.images.length > 0) {
      return { triage: true, reason: `page-${features.pageNumber}-has-images` };
    }
    if (features.native.garbled || features.raster.fullPageImage) {
      return { triage: true, reason: `page-${features.pageNumber}-suspect-layer` };
    }
    if (features.native.mathGlyphRatio >= MATH_RATIO_TRIAGE_FLOOR) {
      return { triage: true, reason: `page-${features.pageNumber}-math-glyphs` };
    }
  }
  return { triage: false, reason: "all-pages-healthy-text-no-images" };
}

// ---- Questions ------------------------------------------------------------

const KEY_PATTERN = /^p(\d+)_(.+)$/;

export function questionKey(pageNumber: number, question: string): string {
  return `p${String(pageNumber).padStart(2, "0")}_${question}`;
}

function imageKindCriteria(): Record<string, string | null> {
  return { ...IMAGE_KIND_CRITERIA };
}

/** Number of image_kind questions a page contributes. */
export function imageKindSlots(page: PageInput): Array<number | null> {
  const count = page.textFacts.imageCount;
  if (count === 0 && page.images.length === 0) return [];
  if (page.images.length > 0) {
    return page.images.slice(0, MAX_IMAGE_KIND_QUESTIONS_PER_PAGE).map((image) => image.index);
  }
  return [null];
}

export function buildPageQuestions(
  page: PageInput,
  questionIds: readonly DecisionQuestionId[] = decisionQuestionIds,
  includeImageKind = true,
): Record<string, DecisionQuestion> {
  const n = page.features.pageNumber;
  const label = pageLabel(n);
  const out: Record<string, DecisionQuestion> = {};
  for (const id of questionIds) {
    out[questionKey(n, id)] = { type: "noul", instructions: `For page ${label}: ${QUESTION_TEXT[id]}` };
  }
  for (const slot of includeImageKind ? imageKindSlots(page) : []) {
    const key = slot === null ? questionKey(n, "image_kind") : questionKey(n, `image_kind_${slot}`);
    const which = slot === null ? "the main image on" : `image #${slot} on`;
    out[key] = {
      type: "choice",
      instructions: `For page ${label}: what kind of content is ${which} the page?`,
      criteria: imageKindCriteria(),
    };
  }
  return out;
}

export function questionsPerPage(
  page: PageInput,
  questionIds: readonly DecisionQuestionId[] = decisionQuestionIds,
  includeImageKind = true,
): number {
  return questionIds.length + (includeImageKind ? imageKindSlots(page).length : 0);
}

// ---- Parsing --------------------------------------------------------------

export interface ParsedPageAnswers {
  probabilities: Partial<Record<DecisionQuestionId, number>>;
  imageKind: Array<{ imageIndex: number | null; probabilities: ImageKindProbabilities }>;
}

/**
 * Maps `p07_<q>` answers back to per-page results. Requires exactly the
 * requested keys: missing, unexpected and wrongly typed answers throw.
 */
export function parseTriageAnswers(
  requested: Record<string, DecisionQuestion>,
  answers: Record<string, DecisionAnswer>,
): Map<number, ParsedPageAnswers> {
  const missing = Object.keys(requested).filter((key) => !(key in answers));
  const unexpected = Object.keys(answers).filter((key) => !(key in requested));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new TriageParseError(
      `triage answers mismatch: ${missing.length} missing, ${unexpected.length} unexpected`,
      missing,
      unexpected,
    );
  }
  const pages = new Map<number, ParsedPageAnswers>();
  const seen = new Set<string>();
  for (const [key, question] of Object.entries(requested)) {
    if (seen.has(key)) throw new TriageParseError(`duplicate triage key ${key}`);
    seen.add(key);
    const match = KEY_PATTERN.exec(key);
    if (!match) throw new TriageParseError(`unparseable triage key ${key}`);
    const pageNumber = Number(match[1]);
    const name = match[2]!;
    const answer = answers[key]!;
    if (answer.type !== question.type) throw new TriageParseError(`answer type mismatch for ${key}`);
    const page = pages.get(pageNumber) ?? { probabilities: {}, imageKind: [] };
    pages.set(pageNumber, page);
    if (answer.type === "noul") {
      if (!(decisionQuestionIds as readonly string[]).includes(name)) {
        throw new TriageParseError(`unknown question ${name} in key ${key}`);
      }
      page.probabilities[name as DecisionQuestionId] = answer.noul;
    } else if (answer.type === "choice") {
      const kindMatch = /^image_kind(?:_(\d+))?$/.exec(name);
      if (!kindMatch) throw new TriageParseError(`unknown choice question ${name} in key ${key}`);
      const probabilities: ImageKindProbabilities = {};
      for (const [option, p] of Object.entries(answer.probabilities)) {
        if ((imageKinds as readonly string[]).includes(option)) probabilities[option as ImageKind] = p;
      }
      page.imageKind.push({ imageIndex: kindMatch[1] === undefined ? null : Number(kindMatch[1]), probabilities });
    } else {
      throw new TriageParseError(`unsupported answer type for ${key}`);
    }
  }
  return pages;
}

// ---- Triage ---------------------------------------------------------------

export interface TriageOptions {
  format?: DecisionFormat;
  /** Pages per request for grid/named-images (4, 9 or 16); capped by question and image limits. */
  pagesPerCall?: number;
  tileLongEdge?: TileLongEdge | number;
  questionIds?: readonly DecisionQuestionId[];
  /** Ask the per-image image_kind choice questions (default true; content triage turns it off). */
  imageKindQuestions?: boolean;
  thumbnails?: PageThumbnails;
  /** Native text-layer excerpts per page number, used by text-state mode. */
  textExcerpts?: ReadonlyMap<number, string>;
  excerptChars?: number;
  concurrency?: number;
  signal?: AbortSignal;
  /** Called for each successful request, e.g. to record usage. */
  onCall?: (result: DecisionCallResult, info: { pages: number[]; format: DecisionFormat; model: DecisionModel }) => void;
}

export interface Triage {
  triagePages(pages: PageInput[], opts?: TriageOptions): Promise<Map<number, DecisionAnswers>>;
}

export interface TriageBatch {
  pages: PageInput[];
  questions: Record<string, DecisionQuestion>;
}

/** Splits pages into requests under the question, image and pagesPerCall limits. */
export function planTriageBatches(
  pages: readonly PageInput[],
  model: DecisionModel,
  format: DecisionFormat,
  opts: Pick<TriageOptions, "pagesPerCall" | "questionIds" | "imageKindQuestions"> = {},
): TriageBatch[] {
  const seenPages = new Set<number>();
  for (const page of pages) {
    const n = page.features.pageNumber;
    if (seenPages.has(n)) throw new TriageParseError(`duplicate page number ${n} in triage input`);
    seenPages.add(n);
  }
  const maxPages =
    format === "per-page"
      ? 1
      : Math.max(1, opts.pagesPerCall ?? 9);
  const imageCap = format === "named-images" ? Math.max(1, model.modalities.maxImagesPerRequest) : Infinity;
  const batches: TriageBatch[] = [];
  let current: TriageBatch | null = null;
  for (const page of pages) {
    const questions = buildPageQuestions(page, opts.questionIds, opts.imageKindQuestions ?? true);
    const size = Object.keys(questions).length;
    if (size > model.maxQuestionsPerRequest) {
      throw new TriageParseError(`page ${page.features.pageNumber} alone needs ${size} questions (> ${model.maxQuestionsPerRequest})`);
    }
    if (
      current &&
      current.pages.length < maxPages &&
      current.pages.length < imageCap &&
      Object.keys(current.questions).length + size <= model.maxQuestionsPerRequest
    ) {
      current.pages.push(page);
      Object.assign(current.questions, questions);
    } else {
      current = { pages: [page], questions: { ...questions } };
      batches.push(current);
    }
  }
  return batches;
}

function chooseFormat(model: DecisionModel, requested: DecisionFormat | undefined): DecisionFormat {
  if (!model.modalities.image) return "text-state";
  return requested ?? "named-images";
}

function textState(batch: TriageBatch["pages"], opts: TriageOptions): DecisionState {
  const limit = opts.excerptChars ?? 1200;
  const parts: DecisionStatePart[] = [textFactsBlock(batch), batch.map(featureSummaryLine).join("\n")];
  for (const page of batch) {
    const excerpt = opts.textExcerpts?.get(page.features.pageNumber)?.trim();
    parts.push(
      `Page ${pageLabel(page.features.pageNumber)} text-layer excerpt:\n` +
        (excerpt ? excerpt.slice(0, limit) : "(none)"),
    );
  }
  return parts;
}

async function buildState(
  format: DecisionFormat,
  batch: TriageBatch,
  opts: TriageOptions,
): Promise<{ state: DecisionState; tilePx: number | null }> {
  if (format === "text-state") return { state: textState(batch.pages, opts), tilePx: null };
  const { images, tilePx } = await buildImageStateParts(format, batch.pages, opts.thumbnails, opts.tileLongEdge ?? 384);
  // Facts line and a short native-text excerpt next to the thumbnail (W4/TL1: the excerpt lets the model
  // compare what the layer says with what the page shows).
  const excerpts = opts.textExcerpts && opts.excerptChars
    ? batch.pages.map((page) => {
        const excerpt = opts.textExcerpts!.get(page.features.pageNumber)?.replace(/\s+/g, " ").trim();
        return `Page ${pageLabel(page.features.pageNumber)} native text excerpt: ${excerpt ? JSON.stringify(excerpt.slice(0, opts.excerptChars)) : '"" (empty)'}`;
      })
    : [];
  return { state: [textFactsBlock(batch.pages), ...excerpts, ...images], tilePx };
}

async function runPool<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export function createTriage(deps: { client: DecisionClient; model: DecisionModel }): Triage {
  return {
    async triagePages(pages, opts = {}) {
      const { client, model } = deps;
      const format = chooseFormat(model, opts.format);
      if (format !== "text-state" && !model.modalities.image) {
        throw new TriageParseError(`${model.id} is text-only; use text-state`);
      }
      const batches = planTriageBatches(pages, model, format, opts);
      const results = new Map<number, DecisionAnswers>();
      const pooled: number[] = [];
      await runPool(batches, opts.concurrency ?? 3, async (batch) => {
        const { state, tilePx } = await buildState(format, batch, opts);
        const result = await client.ask(model, state, batch.questions, { signal: opts.signal });
        opts.onCall?.(result, { pages: batch.pages.map((p) => p.features.pageNumber), format, model });
        // A model that answers many distinct questions identically (or all ~0.5) is not reading the
        // state: discard the whole triage so the router can fall through to a healthy model.
        const signals = answerSignals(result.answers);
        const degenerate = detectDegenerate(signals);
        if (degenerate) throw new DecisionDegenerateError(model.id, degenerate);
        pooled.push(...signals);
        const parsed = parseTriageAnswers(batch.questions, result.answers);
        for (const [pageNumber, answer] of parsed) {
          results.set(pageNumber, {
            probabilities: answer.probabilities,
            choices: answer.imageKind.length > 0 ? { image_kind: answer.imageKind } : {},
            source: {
              decisionModel: model.id,
              format,
              pagesPerCall: batch.pages.length,
              tilePx,
            },
          });
        }
      });
      // Small requests cannot be judged alone; the pooled answers of the whole triage can.
      const pooledVerdict = detectDegenerate(pooled);
      if (pooledVerdict) throw new DecisionDegenerateError(model.id, pooledVerdict);
      return results;
    },
  };
}

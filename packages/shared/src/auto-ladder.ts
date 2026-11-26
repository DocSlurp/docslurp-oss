import { z } from "zod";

import type { QualityMode } from "./quality.js";

/*
 * The Auto ladder: in `auto` quality every page is read on a rung, and the highest rung allowed is the public quality
 * level (extraction-config.ts): `ocr` is Fastest (the default), `intelligent` is Smartest, `fast` is Fastest with
 * "Read scans" off.
 *
 * - `fast`: the file's own text layer and structure (native extraction): Markdown, images, metadata. No model reads the page.
 * - `ocr`: transcription of pixels: scanned and image pages, text drawn as paths, table rescue. Read by the OCR engine
 *   (its recogniser and escalation), the page image reader, or plain page transcription by the run's vision route.
 * - `intelligent`: pages whose meaning is in a figure: charts, diagrams, image-heavy pages, read by the hosted vision model.
 *   Page triage no longer sends a page here from its words (the `chart-or-figure` and `image-heavy` routes, DocSlurp/app issue
 *   601): a page reaches it when the quality promotes its read (smartest), or from triage an earlier release stored.
 *
 * A page's rung comes from page triage (which pages need a read, and why) and is recorded per page with its reason.
 * Two project limits (`pipeline.ladder`) cap it: the highest rung allowed, and the largest share of a document's pages
 * that may go above `fast` and above `ocr`. A capped page stays on the highest rung it is allowed: a chart page under
 * `maxRung: "ocr"` is transcribed, a scan under `maxRung: "fast"` is kept as its page image (as Fast keeps it). Limits
 * never fail a document and never change prices: a page bills Rich only when a model reads it, as without limits.
 * They apply to `auto` only (Fast reads no page).
 *
 * Under Smartest (`intelligent`) there is no OCR step: a page triage would send to `ocr` (a scan, an image page, text
 * drawn as paths or in a broken font, a table rescue) is read on `intelligent` by the vision model. A page an
 * above-ocr share cap lowers is read on `ocr` instead. Under Fastest (`ocr`) no page reaches a vision model.
 */

export const LADDER_RUNGS = ["fast", "ocr", "intelligent"] as const;
export const ladderRungSchema = z.enum(LADDER_RUNGS);
export type LadderRung = z.infer<typeof ladderRungSchema>;

export const LADDER_RUNG_RANK: Record<LadderRung, number> = { fast: 0, ocr: 1, intelligent: 2 };

const shareSchema = z.number().finite().min(0).max(1);

export const ladderEscalationShareSchema = z.strictObject({
  /** Largest share (0..1) of a document's pages that may be read by any model (OCR or vision). */
  aboveFast: shareSchema.nullable().optional(),
  /**
   * Largest share (0..1) of a document's pages that may be read on the intelligent rung (a vision model on a figure).
   * Above `aboveFast` it caps nothing more (effectiveLadder): every page above ocr is also above fast. Not refused, so a
   * project's share and an upload's tighter one always merge into a valid ladder.
   */
  aboveOcr: shareSchema.nullable().optional(),
});
export type LadderEscalationShare = z.infer<typeof ladderEscalationShareSchema>;

export const pipelineLadderSchema = z.strictObject({
  /** Highest rung a page may be read on: `ocr` (the default) is Fastest, `intelligent` is Smartest, `fast` reads no page. */
  maxRung: ladderRungSchema.default("ocr"),
  /** Escalation share caps per document; unset (the default) caps nothing. */
  maxEscalationShare: ladderEscalationShareSchema.nullable().optional(),
});
export type PipelineLadder = z.infer<typeof pipelineLadderSchema>;

/** The rung an unset `maxRung` means: Fastest. */
export const DEFAULT_LADDER_MAX_RUNG: LadderRung = "ocr";
export const defaultPipelineLadder: PipelineLadder = { maxRung: DEFAULT_LADDER_MAX_RUNG };

type LadderPipeline = { quality?: QualityMode | null; ladder?: Partial<PipelineLadder> | null };

/** The ladder limits in force for a run's pipeline, normalized: a zero share lowers the highest rung. */
export interface EffectiveLadder {
  /** True when any limit can change what Auto reads (quality auto and a rung below intelligent or a share cap). Fastest is always active. */
  active: boolean;
  maxRung: LadderRung;
  /** Share caps in force (undefined: no cap). */
  aboveFast?: number;
  aboveOcr?: number;
}

// Unset (undefined or null) caps nothing; a stored value that is set but not a finite number fails closed to 0.
const share = (value: unknown): number | undefined =>
  value === undefined || value === null ? undefined
  : typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;

export function effectiveLadder(pipeline: LadderPipeline | null | undefined): EffectiveLadder {
  if ((pipeline?.quality ?? "auto") !== "auto") return { active: false, maxRung: "intelligent" };
  const ladder = pipeline?.ladder ?? null;
  const parsed = ladderRungSchema.safeParse(ladder?.maxRung);
  // Unset is the default (ocr, Fastest); a value that is set but not a rung fails closed to the tightest rung.
  let maxRung: LadderRung = parsed.success ? parsed.data : ladder?.maxRung === undefined || ladder?.maxRung === null ? DEFAULT_LADDER_MAX_RUNG : "fast";
  let aboveFast = share(ladder?.maxEscalationShare?.aboveFast);
  let aboveOcr = share(ladder?.maxEscalationShare?.aboveOcr);
  // A share of 0 is a rung limit: no page may go above that rung.
  if (aboveFast === 0) maxRung = "fast";
  if (aboveOcr === 0 && LADDER_RUNG_RANK[maxRung] > LADDER_RUNG_RANK.ocr) maxRung = "ocr";
  // Caps on rungs above the highest allowed one cap nothing; a share of 1 caps nothing.
  if (maxRung === "fast" || aboveFast === 1) aboveFast = undefined;
  if (LADDER_RUNG_RANK[maxRung] < LADDER_RUNG_RANK.intelligent || aboveOcr === 1) aboveOcr = undefined;
  if (aboveFast !== undefined && aboveOcr !== undefined && aboveOcr >= aboveFast) aboveOcr = undefined;
  const active = maxRung !== "intelligent" || aboveFast !== undefined || aboveOcr !== undefined;
  return {
    active,
    maxRung,
    ...(aboveFast !== undefined ? { aboveFast } : {}),
    ...(aboveOcr !== undefined ? { aboveOcr } : {}),
  };
}

/**
 * True when the run reads as Smartest: `auto` with the intelligent rung allowed. A page that needs a read then goes to
 * the vision model with no OCR step first (extraction leaves scans and image pages to vision).
 */
export function ladderSkipsOcr(pipeline: LadderPipeline | null | undefined): boolean {
  return (pipeline?.quality ?? "auto") === "auto" && effectiveLadder(pipeline).maxRung === "intelligent";
}

/** True when no page may reach a vision model: Fastest (`ocr`) or Fastest with Read scans off (`fast`), or quality `fast`. */
export function ladderForbidsVision(pipeline: LadderPipeline | null | undefined): boolean {
  if ((pipeline?.quality ?? "auto") !== "auto") return true;
  return effectiveLadder(pipeline).maxRung !== "intelligent";
}

/**
 * The quality a run reads pages with: Auto capped at the `fast` rung reads exactly as Fast (text layer only, pages
 * without one kept as page images). Every other pipeline keeps its quality. Prices are unchanged: billing follows reads.
 */
export function pageReadingQuality(pipeline: LadderPipeline | null | undefined): QualityMode {
  const quality = pipeline?.quality ?? "auto";
  return quality === "auto" && effectiveLadder(pipeline).maxRung === "fast" ? "fast" : quality;
}

/** `pipeline` with its quality replaced by pageReadingQuality (the worker reads a run's pipeline through this). */
export function withLadderPageQuality<T extends LadderPipeline>(pipeline: T): T {
  const quality = pageReadingQuality(pipeline);
  return quality === (pipeline.quality ?? "auto") ? pipeline : { ...pipeline, quality };
}

/** True when `after`'s limits allow some page a higher rung than `before`'s (a higher rung or a larger or removed share). */
export function ladderAllowsMore(before: LadderPipeline, after: LadderPipeline): boolean {
  const was = effectiveLadder({ quality: "auto", ladder: before.ladder ?? null });
  const now = effectiveLadder({ quality: "auto", ladder: after.ladder ?? null });
  if (LADDER_RUNG_RANK[now.maxRung] > LADDER_RUNG_RANK[was.maxRung]) return true;
  const larger = (a: number | undefined, b: number | undefined) => (b ?? 1) > (a ?? 1);
  return larger(was.aboveFast, now.aboveFast) || larger(was.aboveOcr, now.aboveOcr);
}

/**
 * `pipeline` as a run executes it under its ladder limits: the page-reading quality (withLadderPageQuality) and, below
 * the intelligent rung, chart & diagram export without its model tier (`models` becomes `free`, which reads no chart
 * with a model). The worker reads every run pipeline through this; estimates price the same.
 */
export function applyLadderLimits<T extends LadderPipeline & { chartExport?: { tier?: string | null } | null }>(pipeline: T): T {
  const next = withLadderPageQuality(pipeline);
  if (ladderChartExportTier(pipeline, next.chartExport?.tier) === next.chartExport?.tier) return next;
  return { ...next, chartExport: { ...next.chartExport, tier: "free" } };
}

/** A chart export tier under the ladder: `models` becomes `free` while any ladder limit is in force. */
export function ladderChartExportTier<T extends string | null | undefined>(pipeline: LadderPipeline | null | undefined, tier: T): T | "free" {
  // Chart export reads its candidates outside the page plan, so any ladder limit (a rung below intelligent, or a share
  // cap) keeps it on the free tier, which reads no chart with a model.
  return tier === "models" && effectiveLadder(pipeline).active ? "free" : tier;
}

/**
 * The stricter of two ladders, limit by limit: the lower `maxRung` and, for each share, the smaller one (unset means no
 * cap). A run override from a caller who cannot edit the project goes through this with the project's stored ladder, so
 * it can only tighten the project's limits, never loosen them.
 */
export function tighterLadder(project: Partial<PipelineLadder> | null | undefined, run: Partial<PipelineLadder> | null | undefined): PipelineLadder {
  // Unset is the default (ocr); a value that is set but not a rung fails closed to the tightest rung.
  const rung = (value: unknown): LadderRung => (ladderRungSchema.safeParse(value).success ? value as LadderRung : value === undefined || value === null ? DEFAULT_LADDER_MAX_RUNG : "fast");
  const a = rung(project?.maxRung);
  const b = rung(run?.maxRung);
  const maxRung = LADDER_RUNG_RANK[a] <= LADDER_RUNG_RANK[b] ? a : b;
  const pick = (x: unknown, y: unknown): number | undefined => {
    const values = [share(x), share(y)].filter((value): value is number => value !== undefined);
    return values.length ? Math.min(...values) : undefined;
  };
  const aboveFast = pick(project?.maxEscalationShare?.aboveFast, run?.maxEscalationShare?.aboveFast);
  let aboveOcr = pick(project?.maxEscalationShare?.aboveOcr, run?.maxEscalationShare?.aboveOcr);
  if (aboveFast !== undefined && aboveOcr !== undefined && aboveOcr > aboveFast) aboveOcr = aboveFast;
  return {
    maxRung,
    ...(aboveFast !== undefined || aboveOcr !== undefined
      ? { maxEscalationShare: { ...(aboveFast !== undefined ? { aboveFast } : {}), ...(aboveOcr !== undefined ? { aboveOcr } : {}) } }
      : {}),
  };
}

/**
 * A run pipeline from a caller who cannot change the project's spend settings, held to the project's ladder: the ladder
 * no looser than the project's (tighterLadder), so the run never reads on a higher rung (Smartest over a Fastest
 * project), and, while the project has a limit, quality no higher than the project's. Editors (`mayLoosen`) keep the
 * run pipeline as asked.
 */
export function clampRunLadder<T extends { quality: QualityMode; ladder?: Partial<PipelineLadder> | null }>(
  run: T,
  project: { quality?: QualityMode | null; ladder?: Partial<PipelineLadder> | null } | null | undefined,
  mayLoosen: boolean,
): T {
  if (mayLoosen) return run;
  const ladder = tighterLadder(project?.ladder ?? null, run.ladder ?? null);
  const projectQuality = project?.quality ?? "auto";
  // A project stored as `fast` (text only, Read scans off) limits too: its ladder is inactive, but a run on `auto` would
  // turn on paid OCR reads the caller may not choose.
  const projectLimited = projectQuality === "fast" || effectiveLadder({ quality: projectQuality, ladder: project?.ladder ?? null }).active;
  const rank: Record<QualityMode, number> = { fast: 0, auto: 1 };
  const quality = projectLimited && rank[run.quality] > rank[projectQuality] ? projectQuality : run.quality;
  return { ...run, quality, ladder };
}

/**
 * Pages of a `pageCount`-page document a share allows: floor(share x pages), and at least one page when the share is
 * above 0, so a small file (a one-page scan, an image, an Office file before its pages are measured) can still be read.
 */
export function ladderShareBudget(shareValue: number | undefined, pageCount: number): number {
  const pages = Math.max(0, Math.floor(Number.isFinite(pageCount) ? pageCount : 0));
  if (shareValue === undefined) return pages;
  if (shareValue <= 0 || pages === 0) return 0;
  return Math.max(1, Math.min(pages, Math.floor(shareValue * pages + 1e-9)));
}

/**
 * Whether reads outside a document's ladder plan may run: query-time materialization, the document map's siphon OCR,
 * page-image embeddings. They have no document-wide plan to count against, so under an above-fast share they read
 * nothing (fail closed). Page-image embedding (visual indexing, the coarse fallback) reads every page it embeds, so it
 * runs only with no ladder limit at all (`offPlanEmbeddings`).
 */
export function ladderAllowsOffPlanReads(pipeline: LadderPipeline | null | undefined): { pageReads: boolean; pageEmbeddings: boolean } {
  const ladder = effectiveLadder(pipeline);
  return { pageReads: ladder.aboveFast === undefined, pageEmbeddings: !ladder.active };
}

/** What the ladder allows one document, from its page count. */
export interface DocumentLadderPolicy {
  ladder: EffectiveLadder;
  /** The quality this document reads with: `fast` when no page of it may go above fast. */
  quality: QualityMode;
  /** Pages that may go above fast (pageCount when uncapped). */
  aboveFastBudget: number;
  /** Pages that may go above ocr (pageCount when uncapped; 0 when maxRung is below intelligent). */
  aboveOcrBudget: number;
  /** True when the above-fast cap is smaller than the document: extraction may read only some of its pages. */
  aboveFastBinding: boolean;
}

export function documentLadderPolicy(pipeline: LadderPipeline | null | undefined, pageCount: number): DocumentLadderPolicy {
  const ladder = effectiveLadder(pipeline);
  const pages = Math.max(1, Math.floor(Number.isFinite(pageCount) ? pageCount : 1));
  const quality = pageReadingQuality(pipeline);
  const aboveFastBudget = ladder.maxRung === "fast" ? 0 : ladderShareBudget(ladder.aboveFast, pages);
  const aboveOcrBudget = LADDER_RUNG_RANK[ladder.maxRung] < LADDER_RUNG_RANK.intelligent ? 0 : Math.min(aboveFastBudget, ladderShareBudget(ladder.aboveOcr, pages));
  return {
    ladder,
    quality: quality === "auto" && aboveFastBudget === 0 ? "fast" : quality,
    aboveFastBudget,
    aboveOcrBudget,
    aboveFastBinding: aboveFastBudget < pages,
  };
}

/** One page triage selected for a read, and what it needs. */
export interface LadderPageNeed {
  pageNumber: number;
  need: Exclude<LadderRung, "fast">;
  /** Why the page needs that rung (a triage route or signal), for the record. */
  reason: string;
  /** The page has no usable native text: a read is its only text, so it escalates first. */
  lacksText: boolean;
  /** Triage confidence (0..1) in the page's decision: higher escalates first. */
  confidence: number;
}

export type LadderCap = "max-rung" | "share-above-fast" | "share-above-ocr";

export interface LadderPageDecision {
  pageNumber: number;
  /** The rung triage asked for (`fast` for pages it did not select). */
  need: LadderRung;
  /** The rung the page is read on after the limits. */
  rung: LadderRung;
  reason: string;
  /** The limit that lowered the page, when one did. */
  cappedBy?: LadderCap;
}

export interface LadderPlan {
  decisions: LadderPageDecision[];
  /** Pages read above fast (rung ocr or intelligent), ascending. */
  escalated: number[];
  /** Pages on the intelligent rung, ascending. */
  intelligent: number[];
  /** Pages lowered by a limit, ascending. */
  capped: number[];
  counts: Record<LadderRung, number>;
  budgets: { aboveFast: number; aboveOcr: number; alreadyEscalated: number };
}

const priority = (left: LadderPageNeed, right: LadderPageNeed): number =>
  Number(right.lacksText) - Number(left.lacksText)
  || right.confidence - left.confidence
  || left.pageNumber - right.pageNumber;

/**
 * Assigns every page of a document its rung. `needs` are the pages triage selected; every other page is `fast`.
 * `alreadyEscalated` are pages an earlier stage of this run already read above fast (the OCR of scanned pages during
 * extraction): they count against the above-fast cap first and stay escalated. Deterministic: the same inputs give the
 * same plan, so a stage that plans fan-out and the activities that execute it agree. Pages escalate in priority order:
 * pages without native text, then higher triage confidence, then document order.
 */
export function planLadder(args: {
  pageCount: number;
  needs: readonly LadderPageNeed[];
  policy: Pick<DocumentLadderPolicy, "aboveFastBudget" | "aboveOcrBudget" | "ladder">;
  alreadyEscalated?: Iterable<number>;
}): LadderPlan {
  const pageCount = Math.max(1, Math.floor(args.pageCount) || 1);
  const inRange = (page: number) => Number.isInteger(page) && page >= 1 && page <= pageCount;
  const already = new Set([...(args.alreadyEscalated ?? [])].filter(inRange));
  const byPage = new Map<number, LadderPageNeed>();
  for (const need of args.needs) if (inRange(need.pageNumber) && !byPage.has(need.pageNumber)) byPage.set(need.pageNumber, need);
  const needs = [...byPage.values()];
  const decisions = new Map<number, LadderPageDecision>();
  const { aboveFastBudget, aboveOcrBudget } = args.policy;
  const allowIntelligent = LADDER_RUNG_RANK[args.policy.ladder.maxRung] >= LADDER_RUNG_RANK.intelligent;

  // Above fast: pages already read count first; the rest of the budget goes in priority order.
  let remaining = Math.max(0, aboveFastBudget - already.size);
  const admitted: LadderPageNeed[] = [];
  for (const need of needs.filter((entry) => already.has(entry.pageNumber)).sort(priority)) admitted.push(need);
  for (const need of needs.filter((entry) => !already.has(entry.pageNumber)).sort(priority)) {
    if (args.policy.ladder.maxRung !== "fast" && remaining > 0) {
      admitted.push(need);
      remaining -= 1;
    } else {
      decisions.set(need.pageNumber, {
        pageNumber: need.pageNumber, need: need.need, rung: "fast", reason: need.reason,
        cappedBy: args.policy.ladder.maxRung === "fast" ? "max-rung" : "share-above-fast",
      });
    }
  }
  // Smartest has no OCR step: a page that needs a read at all needs the vision model (an above-ocr cap still lowers it).
  if (allowIntelligent) {
    for (let index = 0; index < admitted.length; index += 1) {
      const need = admitted[index]!;
      if (need.need === "ocr" && !already.has(need.pageNumber)) admitted[index] = { ...need, need: "intelligent", reason: `smartest:${need.reason}` };
    }
  }
  // Above ocr: intelligent needs keep the rung in priority order while the budget lasts.
  let intelligentLeft = aboveOcrBudget;
  for (const need of [...admitted].sort(priority)) {
    if (need.need !== "intelligent") {
      decisions.set(need.pageNumber, { pageNumber: need.pageNumber, need: need.need, rung: "ocr", reason: need.reason });
    } else if (allowIntelligent && intelligentLeft > 0) {
      intelligentLeft -= 1;
      decisions.set(need.pageNumber, { pageNumber: need.pageNumber, need: "intelligent", rung: "intelligent", reason: need.reason });
    } else {
      decisions.set(need.pageNumber, {
        pageNumber: need.pageNumber, need: "intelligent", rung: "ocr", reason: need.reason,
        cappedBy: allowIntelligent ? "share-above-ocr" : "max-rung",
      });
    }
  }
  // A page an earlier stage read above fast that triage did not select again stays recorded as escalated.
  for (const page of already) {
    if (!decisions.has(page)) decisions.set(page, { pageNumber: page, need: "ocr", rung: "ocr", reason: "read-during-extraction" });
  }
  const ordered = [...decisions.values()].sort((a, b) => a.pageNumber - b.pageNumber);
  const counts: Record<LadderRung, number> = { fast: pageCount, ocr: 0, intelligent: 0 };
  for (const decision of ordered) {
    if (decision.rung === "fast") continue;
    counts.fast -= 1;
    counts[decision.rung] += 1;
  }
  return {
    decisions: ordered,
    escalated: ordered.filter((decision) => decision.rung !== "fast").map((decision) => decision.pageNumber),
    intelligent: ordered.filter((decision) => decision.rung === "intelligent").map((decision) => decision.pageNumber),
    capped: ordered.filter((decision) => decision.cappedBy).map((decision) => decision.pageNumber),
    counts,
    budgets: { aboveFast: aboveFastBudget, aboveOcr: aboveOcrBudget, alreadyEscalated: already.size },
  };
}

/** Compact per-document summary of a plan, for stage stats (page lists truncated; the manifest keeps every page). */
export function ladderPlanSummary(plan: LadderPlan, ladder: EffectiveLadder, limit = 200): Record<string, unknown> {
  const cappedBy: Partial<Record<LadderCap, number>> = {};
  for (const decision of plan.decisions) if (decision.cappedBy) cappedBy[decision.cappedBy] = (cappedBy[decision.cappedBy] ?? 0) + 1;
  return {
    limits: { maxRung: ladder.maxRung, ...(ladder.aboveFast !== undefined ? { aboveFast: ladder.aboveFast } : {}), ...(ladder.aboveOcr !== undefined ? { aboveOcr: ladder.aboveOcr } : {}) },
    counts: plan.counts,
    budgets: plan.budgets,
    cappedPages: plan.capped.length,
    cappedBy,
    pages: plan.decisions.slice(0, limit).map((decision) => ({
      page: decision.pageNumber, need: decision.need, rung: decision.rung, reason: decision.reason,
      ...(decision.cappedBy ? { cappedBy: decision.cappedBy } : {}),
    })),
    ...(plan.decisions.length > limit ? { pagesTruncated: plan.decisions.length - limit } : {}),
  };
}

/**
 * The page mix an estimate should price under the ladder: pages beyond the above-fast share move from the read classes
 * (`complex`, `scanned`) to `text`, so a capped page is never estimated as Rich. Fractions are normalized first.
 */
export function ladderEstimateMix<T extends { text?: number; complex?: number; scanned?: number }>(
  mix: T,
  pipeline: LadderPipeline | null | undefined,
): T {
  const ladder = effectiveLadder(pipeline);
  if (!ladder.active || ladder.aboveFast === undefined) return mix;
  const text = Math.max(0, mix.text ?? 0);
  const complex = Math.max(0, mix.complex ?? 0);
  const scanned = Math.max(0, mix.scanned ?? 0);
  const total = text + complex + scanned;
  if (total <= 0) return mix;
  const read = (complex + scanned) / total;
  if (read <= ladder.aboveFast) return mix;
  const scale = ladder.aboveFast / read;
  const nextComplex = (complex / total) * scale;
  const nextScanned = (scanned / total) * scale;
  return { ...mix, text: 1 - nextComplex - nextScanned, complex: nextComplex, scanned: nextScanned };
}

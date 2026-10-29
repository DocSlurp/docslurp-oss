/**
 * Cheap per-page source facts for the ingest report: how much plain text each
 * page's native text layer holds and how many embedded images it draws, plus
 * the vision outcome per page. Facts are best effort: a failure here never
 * fails the document, it only leaves the report saying "not recorded".
 *
 * Kill switch: WORKER_PAGE_FACTS=false skips recording entirely.
 */
import type { CommandRunner } from "../tools/runner.js";

/**
 * `rejected`: vision ran but its output was rejected (degenerate, refusal, truncated) and the page
 * kept usable native or OCR text; a rejected page without usable text is `failed`. `guarded`: the
 * run's vision attempt guard (page bound, rejection breaker, org attempt bound) refused the page.
 */
export type PageVisionStatus = "extracted" | "failed" | "rejected" | "guarded" | "not-selected" | "over-cap" | "cost-cap";

/** Why a selected page has no vision output (vision-extract `VisionPageSkip`). */
export interface VisionPageOutcome {
  outcome:
    | "rejected"
    | "failed"
    | "page-attempt-limit"
    | "rejection-breaker"
    | "org-attempt-limit"
    | "unscoped-run"
    | "no-attempt-ledger"
    | "blank-render"
    /** Nominated only by drawn-content bytes and its render could not be confirmed to hold ink. */
    | "unverified-render";
  /** The page has usable native or OCR text to keep when vision gives nothing. */
  fallbackText: boolean;
}

export function visionStatusForOutcome(outcome: VisionPageOutcome): PageVisionStatus {
  switch (outcome.outcome) {
    case "rejected":
      return outcome.fallbackText ? "rejected" : "failed";
    case "page-attempt-limit":
    case "rejection-breaker":
    case "org-attempt-limit":
    case "unscoped-run":
    case "no-attempt-ledger":
      return "guarded";
    case "blank-render":
    case "unverified-render":
      return "not-selected";
    default:
      return "failed";
  }
}

export interface PageFactUpsert {
  documentId: string;
  pageNumber: number;
  runId: string;
  /** Undefined keeps the stored value; the stage that knows a fact writes it. */
  textBytes?: number | null;
  wordCount?: number | null;
  imageCount?: number | null;
  factsSource?: string | null;
  visionStatus?: PageVisionStatus | null;
  visionTextBytes?: number | null;
}

/** Hard ceiling on rows per document so a pathological page count stays cheap. */
export const PAGE_FACTS_MAX_PAGES = 5_000;
/**
 * Pages probed with poppler per PDF (WORKER_PAGE_FACTS_MAX_PAGES, default 300).
 * Later pages are reported as "not recorded"; a 2,700-page catalog would
 * otherwise cost tens of CPU seconds next to extraction.
 */
export function pageFactsProbePages(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.WORKER_PAGE_FACTS_MAX_PAGES);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(PAGE_FACTS_MAX_PAGES, Math.trunc(parsed)) : 300;
}
const PAGE_FACTS_TIMEOUT_MS = 20_000;

export function pageFactsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.WORKER_PAGE_FACTS?.trim().toLowerCase();
  return !(raw === "false" || raw === "0" || raw === "off");
}

/** Whitespace-collapsed UTF-8 byte length: layout padding and blank lines do not count as text. */
export function plainTextBytes(text: string): number {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed ? Buffer.byteLength(collapsed, "utf8") : 0;
}

export function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Splits pdftotext output on form feeds, keeping empty pages in place (unlike
 * splitTextIntoPages, which drops them). Returns null when the page count does
 * not line up, so no page gets another page's numbers.
 */
export function splitFormFeedPages(text: string, pageCount: number): string[] | null {
  // pdftotext ends every page, including the last, with a form feed.
  const body = text.replace(/[^\S\f]+$/, "");
  const parts = (body.endsWith("\f") ? body.slice(0, -1) : body).split("\f");
  return parts.length === pageCount ? parts : null;
}

/**
 * Parses `pdfimages -list` into image counts per page. Only `image` rows count;
 * `mask`, `smask` and `stencil` rows are parts of another image.
 */
export function parsePdfImagesList(stdout: string): Map<number, number> {
  const counts = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 3 || !/^\d+$/.test(fields[0]!) || !/^\d+$/.test(fields[1]!)) continue;
    if (fields[2] !== "image") continue;
    const page = Number(fields[0]);
    counts.set(page, (counts.get(page) ?? 0) + 1);
  }
  return counts;
}

/** Builds per-page rows from the text layer and image list of a PDF. */
export function buildPdfPageFacts(args: {
  documentId: string;
  runId: string;
  pageCount: number;
  pageText: string | null;
  imagesList: string | null;
}): PageFactUpsert[] {
  const pageCount = Math.min(Math.max(0, Math.trunc(args.pageCount)), PAGE_FACTS_MAX_PAGES);
  if (pageCount === 0) return [];
  const pages = args.pageText === null ? null : splitFormFeedPages(args.pageText, pageCount);
  const images = args.imagesList === null ? null : parsePdfImagesList(args.imagesList);
  if (!pages && !images) return [];
  const source = [pages ? "pdftotext" : null, images ? "pdfimages" : null].filter(Boolean).join("+");
  return Array.from({ length: pageCount }, (_, index) => {
    const pageNumber = index + 1;
    const text = pages?.[index];
    return {
      documentId: args.documentId,
      runId: args.runId,
      pageNumber,
      textBytes: text === undefined ? null : plainTextBytes(text),
      wordCount: text === undefined ? null : wordCount(text),
      imageCount: images ? images.get(pageNumber) ?? 0 : null,
      factsSource: source,
    };
  });
}

/**
 * Runs pdftotext and pdfimages -list (both poppler, no pixel decoding) and
 * returns per-page facts, or [] when neither tool produced usable output.
 */
export async function probePdfPageFacts(args: {
  runner: CommandRunner;
  sourcePath: string;
  documentId: string;
  runId: string;
  pageCount: number;
  signal?: AbortSignal;
  /**
   * Called with the pending `pdfimages -list` output (pages 1..lastPage, null on failure) as
   * soon as it starts, so other per-page evidence (page triage) can reuse the same run.
   */
  onImagesList?: (listing: { lastPage: number; stdout: Promise<string | null> }) => void;
  /**
   * Called with the pending `pdftotext` output (pages 1..lastPage, null on failure), so page
   * triage can tell a page's native text layer apart from text OCR produced for it.
   */
  onPageText?: (listing: { lastPage: number; stdout: Promise<string | null> }) => void;
}): Promise<PageFactUpsert[]> {
  const pageCount = Math.min(Math.max(0, args.pageCount), pageFactsProbePages());
  if (pageCount === 0) return [];
  const capture = async (plan: Awaited<ReturnType<CommandRunner["pageText"]>>) => {
    if (!plan.available) return null;
    try {
      const result = await args.runner.run({ ...plan, pages: pageCount, timeoutMs: PAGE_FACTS_TIMEOUT_MS }, args.signal);
      return result.stdout;
    } catch (error) {
      console.warn(`[page-facts] ${plan.binary} failed document=${args.documentId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
  const imagesListing = args.runner.listImages(args.sourcePath, pageCount).then(capture);
  args.onImagesList?.({ lastPage: pageCount, stdout: imagesListing });
  const pageTextListing = args.runner.pageText(args.sourcePath, pageCount).then(capture);
  args.onPageText?.({ lastPage: pageCount, stdout: pageTextListing });
  const [pageText, imagesList] = await Promise.all([pageTextListing, imagesListing]);
  return buildPdfPageFacts({ documentId: args.documentId, runId: args.runId, pageCount, pageText, imagesList });
}

/**
 * Vision outcome per page for one document. `selected` pages the triage chose (in priority order),
 * `processed` pages that returned text, `cap` the per-document page limit.
 */
export function buildVisionPageFacts(args: {
  documentId: string;
  runId: string;
  pageCount: number;
  selected: number[];
  processed: Array<{ pageNumber: number; text?: string | null }>;
  cap: number;
  costCapped?: boolean;
  /** Why attempted pages without output have none; absent pages read as `failed`. */
  outcomes?: ReadonlyMap<number, VisionPageOutcome>;
}): PageFactUpsert[] {
  const pageCount = Math.min(Math.max(0, Math.trunc(args.pageCount)), PAGE_FACTS_MAX_PAGES);
  const processed = new Map(args.processed.map((page) => [page.pageNumber, page.text ?? ""]));
  // `selected` is in vision's priority order (pages without native text first); the
  // per-document cap keeps a prefix of it, so do not re-sort before slicing.
  const selected = [...new Set(args.selected)].filter((page) => page >= 1 && page <= pageCount);
  const attempted = new Set(selected.slice(0, Math.max(0, args.cap)));
  const selectedSet = new Set(selected);
  return Array.from({ length: pageCount }, (_, index) => {
    const pageNumber = index + 1;
    const text = processed.get(pageNumber);
    const visionStatus: PageVisionStatus = args.costCapped
      ? "cost-cap"
      : text !== undefined
        ? "extracted"
        : !selectedSet.has(pageNumber)
          ? "not-selected"
          : !attempted.has(pageNumber)
            ? "over-cap"
            : args.outcomes?.has(pageNumber)
              ? visionStatusForOutcome(args.outcomes.get(pageNumber)!)
              : "failed";
    return {
      documentId: args.documentId,
      runId: args.runId,
      pageNumber,
      visionStatus,
      visionTextBytes: text === undefined ? null : plainTextBytes(text),
    };
  });
}

/** Best-effort write; a failure is logged and never fails the stage. */
export async function recordPageFacts(
  store: { upsertPageFacts?(rows: readonly PageFactUpsert[]): Promise<void> } | undefined,
  rows: readonly PageFactUpsert[],
): Promise<void> {
  if (rows.length === 0 || !store?.upsertPageFacts || !pageFactsEnabled()) return;
  try {
    await store.upsertPageFacts(rows);
  } catch (error) {
    console.warn(`[page-facts] write failed document=${rows[0]?.documentId ?? "unknown"}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

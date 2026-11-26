/*
 * The page basis of a run's documents (GLOSSARY.md "Page basis"): the pages each document is split, indexed and billed on
 * (documents.page_count with page_count_source, and documents.billing_pages with billing_pages_method), and the spend check
 * that every change to them owes. Measuring code reports what it measured (`record`); this module decides which column
 * changes, applies the floors, keeps the in-memory document and run in step with the database, and re-checks the run's spend
 * across every document of the run, so concurrent documents cannot each fit the balance alone and together overdraw it.
 *
 * Every WorkflowState carries one. It is bound to the run's store when the state is hydrated (WorkflowState.bindStore); until
 * then it is unbound and refuses every operation (fail closed): there is no code path on which a missing store skips a check.
 */
import {
  PAGE_READ_METRICS,
  dedupCopiesBill,
  pageCredits,
  pageUpgradeCredits,
  runMeasuredPagesCredits,
  speedBoostMultiplier,
  type RunMeasuredPages,
} from "@docslurp/shared";

import { SpendCheckUnavailableError } from "../db/spend-check.js";
import type { PageEquivalentRow } from "../db/page-equivalents.js";
import { RunPolicyError } from "../lib/document-failure.js";
import { extraCreditsForMeasuredPages, type PageCountMethod } from "../lib/office-page-count.js";
import type { Document, ProjectRun } from "../models.js";

/** The run a spend check is made for: its organization is charged, its user is named on the pause event. */
export interface PageBasisRun {
  id: string;
  orgId: string | null;
  projectId?: string | null;
  userId: string;
}

/**
 * What the run measured above admission's priced counts and no charge covers yet, over every document of the run except one
 * (the database's run_measured_pages, migration 0190), plus that one document's charged pages.
 */
export interface RunMeasurements extends RunMeasuredPages {
  /** Distinct pages of the excluded document a page-read charge already covers. */
  documentChargedPages: number;
}

export interface SpendOutcome { paused: boolean; blocked: boolean }

/**
 * The persistence and balance port a PageBasis runs over. Every method is required: an adapter that lacks one is a type
 * error, never a skipped check. Adapters: db/page-basis-ledger.ts (Postgres) and pipeline/page-basis-memory.ts (tests).
 * Every write is scoped to the run's own, non-deduplicated document.
 */
export interface PageBasisLedger {
  /** documents.page_count = pages, page_count_source = 'counted'. False when the document is not the run's own. */
  setPageCount(runId: string, documentId: string, pages: number, executionGeneration?: string | null): Promise<boolean>;
  /** documents.billing_pages = pages, billing_pages_method = method. False when the document is not the run's own. */
  setBillingPages(runId: string, documentId: string, pages: number, method: string): Promise<boolean>;
  /** Raises per-page equivalents and billing_pages (db/page-equivalents.ts recordPageEquivalents); returns billing_pages. */
  recordPageEquivalents(runId: string, documentId: string, rows: readonly PageEquivalentRow[], allowance: number): Promise<number | null>;
  /** Raises a whole-document text format's billing_pages (db/page-equivalents.ts recordWholeDocumentPages); returns billing_pages. */
  recordWholeDocumentPages(runId: string, documentId: string, pages: number): Promise<number | null>;
  /**
   * The one run-wide sum every spend check weighs: Fast pages of the run's paged, non-media documents above their intake count
   * and frames of its multi-frame images no page-read charge covers, over every document except `excludeDocumentId` (whose
   * pages the caller adds from its own state), and that document's charged pages. Failed documents never bill and are not
   * counted; content-deduplicated copies count at their recorded classes (`ocrPages`, `richPages`) unless the copy billing
   * flag is off. `readMetrics` are the page-read charge metrics.
   */
  runMeasurements(runId: string, excludeDocumentId: string | null, readMetrics: readonly string[]): Promise<RunMeasurements>;
  /**
   * Pauses the run when `credits` more would take the organization below what a running job needs. Throws
   * SpendCheckUnavailableError (retryable) when it cannot decide or cannot pause. `blocked` without `paused`: the run was
   * already paused or stopped by something else.
   */
  checkCharge(run: PageBasisRun, credits: number): Promise<SpendOutcome>;
  /** The largest n in 1..max whose `creditsFor(n)` the balance covers, else 0. Read-only. Throws SpendCheckUnavailableError. */
  largestFundedCharge(run: PageBasisRun, max: number, creditsFor: (n: number) => number): Promise<number>;
  /** Pauses the run for funds without a balance check. Throws SpendCheckUnavailableError when the pause cannot be written. */
  pauseForFunds(run: PageBasisRun, reason: string): Promise<SpendOutcome>;
}

/** What a measurement found. `record` decides the columns, floors and spend check from the kind. */
export type PageMeasurement =
  /** Structural pages counted from the bytes or the extraction (PDF page tree, processed PDF pages, the text rule): page_count. */
  | { kind: "page-count"; pages: number }
  /** Frames the OCR boundary read from a multi-frame image: page_count, checked at the OCR page rate. */
  | { kind: "image-frames"; frames: number }
  /** Office, slide, sheet or EPUB pages counted from the extractor's output: billing_pages (page_count is left alone). */
  | { kind: "billing-pages"; pages: number; method: PageCountMethod; format: string }
  /** Pages of a paged document (PDF page, image frame) that measured above one page: raises billing_pages. */
  | { kind: "page-equivalents"; rows: readonly PageEquivalentRow[]; allowance: number }
  /** A whole-document text format's text-rule total over everything extracted: raises billing_pages. */
  | { kind: "whole-document"; pages: number };

export interface PageBasisChange {
  /** The ledger wrote the document (false: not the run's own document, e.g. a deduplicated copy). */
  persisted: boolean;
  pageCount: number;
  billingPages: number | null;
}

/** A charge asked about before the work that incurs it. */
export type PageCharge =
  /** OCR reads of `pages` pages not yet charged (an image's first frame, a batch of a scanned PDF). */
  | { kind: "page-read"; mode: "ocr"; pages: number }
  /** Per page: the upgrade of a page already read by OCR to a Rich read (escalation). */
  | { kind: "page-upgrade"; from: "ocr"; to: "rich" }
  /** Per frame: an image's OCR frames past what admission priced, with every other image of the run's uncharged frames. */
  | { kind: "image-frames"; document: Document };

/**
 * The run is out of funds for measured pages: the run was paused (`paused`), or found already paused or stopped. A run-policy
 * stop: the document stays unfinished and runs again once the run resumes.
 */
export class UnfundedPagesError extends RunPolicyError {
  constructor(message: string, readonly paused: boolean, readonly credits: number, readonly intakePages: number) {
    super(message);
  }
}

/** A page basis invariant broke (a missing pipeline or document, an impossible count): refused loudly, nothing recorded or charged. */
export class PageBasisInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PageBasisInvariantError";
  }
}

/**
 * The page basis was used before a store was bound (WorkflowState.bindStore): a wiring fault, refused loudly. It is a spend
 * check that cannot decide, so every caller treats it as one: retryable, never a verdict on the document, never a skipped check.
 */
export class PageBasisUnboundError extends SpendCheckUnavailableError {
  constructor(runId: string, operation: string) {
    super(`page basis of run ${runId} is not bound to a store; refusing ${operation}`);
    this.name = "PageBasisUnboundError";
  }
}

/** What a PageBasis reads from its workflow state: the run (mutated in place) and the charges still buffered in this activity. */
export interface PageBasisState {
  /** The generation claimed by the activity input, including legacy activities without a generation. */
  readonly executionGeneration?: string | null;
  readonly run: ProjectRun;
  readonly usageLedger: { readonly pendingBillableCents: number };
}

/** The page count admission priced for a document: durable (migration 0130), never the count a measurement wrote. */
export function intakePagesOf(document: Pick<Document, "pageCount" | "intakePageCount">): number {
  const intake = document.intakePageCount ?? document.pageCount;
  return Math.max(1, Math.trunc(Number(intake)) || 1);
}

/**
 * Whether a document is a content-deduplicated copy: it points at the document whose conversion it reuses, or carries the
 * billing facts intake recorded from it (its original may have been deleted since, which clears the pointer).
 */
export function isDedupCopy(document: Pick<Document, "dedupedFromDocumentId" | "copyOcrPages" | "copyRichPages" | "copyMediaPages">): boolean {
  return Boolean(document.dedupedFromDocumentId)
    || document.copyOcrPages != null || document.copyRichPages != null || document.copyMediaPages != null;
}

function isMediaDocument(document: Pick<Document, "mimeType">): boolean {
  const mime = (document.mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  return mime.startsWith("audio/") || mime.startsWith("video/");
}

/**
 * The pages one document owes above what admission priced and no charge covers, by the same rule as run_measured_pages:
 * an image's frames past the larger of its intake and its charged pages (OCR), any other non-media document's billing or page
 * count past its intake (Fast). Audio and video bill by duration elsewhere.
 */
function documentMeasuredPages(document: Document, chargedPages: number, intake: number): RunMeasuredPages {
  const mime = (document.mimeType ?? "").split(";")[0]!.trim().toLowerCase();
  if (mime.startsWith("audio/") || mime.startsWith("video/")) return { fastPages: 0, ocrFrames: 0 };
  const pageCount = Math.max(0, Math.trunc(Number(document.pageCount)) || 0);
  if (mime.startsWith("image/")) {
    return { fastPages: 0, ocrFrames: pageCount > 1 ? Math.max(0, pageCount - Math.max(intake, chargedPages)) : 0 };
  }
  const measured = document.billingPages ?? pageCount;
  return { fastPages: Math.max(0, Math.trunc(Number(measured)) - Math.trunc(intake)), ocrFrames: 0 };
}

export class PageBasis {
  private readonly ledger: PageBasisLedger;

  constructor(private readonly state: PageBasisState, ledger: PageBasisLedger) {
    // The type requires a ledger; a value cast past it (an untyped store) still never skips a check: it refuses every one.
    this.ledger = ledger ?? unboundLedger(() => state.run.id);
  }

  /** A page basis bound to no store: every operation throws PageBasisUnboundError (fail closed). */
  static unbound(state: PageBasisState): PageBasis {
    return new PageBasis(state, unboundLedger(() => state.run.id));
  }

  /**
   * Record what a measurement found for a document of this run: persist the right columns (after the floors), update the
   * in-memory document and run, and re-check the run's spend. Every check weighs one run-wide sum (runMeasurements: Fast pages
   * and uncharged image frames of every document of the run) plus this document's own pages and, for Office pages and image
   * frames, its feature extra, so the order documents are measured in never decides whether the run overdraws. Throws
   * UnfundedPagesError (the run is paused or stopped) or SpendCheckUnavailableError (retryable) before anything is charged.
   *  - page-count: page_count; authorized whenever it stands above intake, on every attempt (a retry that finds the raised
   *    count already persisted is checked again), never skipped because the in-memory count already matched.
   *  - image-frames: page_count; frames past intake are checked at the OCR rate, on every attempt.
   *  - billing-pages: billing_pages, never below an intake count taken from the bytes.
   *  - page-equivalents / whole-document: raise billing_pages (never lowered), then `authorize`.
   */
  async record(document: Document, measurement: PageMeasurement): Promise<PageBasisChange> {
    const run = this.state.run;
    switch (measurement.kind) {
      case "page-count": {
        const pages = measurement.pages;
        if (!Number.isSafeInteger(pages) || pages < 0) throw new PageBasisInvariantError(`invalid page count ${pages} for document ${document.id}`);
        const before = Math.max(1, Math.trunc(Number(document.pageCount)) || 1);
        const persisted = await this.ledger.setPageCount(run.id, document.id, pages, this.state.executionGeneration);
        document.pageCount = pages;
        document.pageCountSource = "counted";
        run.pagesTotal = Math.max(0, (Number(run.pagesTotal) || 0) + pages - before);
        await this.authorize(document);
        return { persisted, pageCount: pages, billingPages: document.billingPages ?? null };
      }
      case "image-frames":
        return await this.recordImageFrames(document, measurement.frames);
      case "billing-pages":
        return await this.recordBillingPages(document, measurement);
      case "page-equivalents":
      case "whole-document": {
        const billingPages = measurement.kind === "page-equivalents"
          ? await this.ledger.recordPageEquivalents(run.id, document.id, measurement.rows, measurement.allowance)
          : await this.ledger.recordWholeDocumentPages(run.id, document.id, measurement.pages);
        if (billingPages !== null && billingPages > (Number(document.billingPages) || 0)) {
          document.billingPages = billingPages;
          document.billingPagesMethod = "page-equivalents";
        }
        // Every time, not only when this call raised billing_pages: a retry after a failed check finds it stored already.
        await this.authorize(document);
        return { persisted: billingPages !== null, pageCount: document.pageCount, billingPages };
      }
    }
  }

  /**
   * Authorize a document's measured pages, on every attempt (a retry that finds the measurement already persisted included):
   * when the document measured above what admission priced, check the balance for everything the run measured above its
   * intake counts and has not been charged (the one run-wide sum), none of which is charged before completion or the read.
   * Never inferred from page_count_source or from whether this attempt changed a count.
   */
  async authorize(document: Document): Promise<{ checkedPages: number } | null> {
    const measured = Math.max(Number(document.billingPages) || 0, Math.trunc(Number(document.pageCount)) || 0);
    if (!(measured > intakePagesOf(document))) return null;
    const run = this.chargeableRun();
    const owed = await this.runOwed(document, intakePagesOf(document));
    if (!(owed.credits > 0)) return { checkedPages: 0 };
    const outcome = await this.checkCharge(run, owed.credits);
    if (outcome.paused || outcome.blocked) {
      console.warn(`[page-auth] run=${run.id} document=${document.id} stopped: ${owed.pages} measured pages above intake owe ${owed.credits.toFixed(2)} credits more than the balance holds (paused=${outcome.paused})`);
      throw unfunded(document, outcome.paused, owed.credits, intakePagesOf(document));
    }
    return { checkedPages: owed.pages };
  }

  /**
   * Authorize the run's content-deduplicated copies among `documents`. A copy reads and measures nothing (intake seeded its
   * checkpoints from its original), so no measuring stage authorizes its pages, yet the completion charge bills them
   * (db/page-base-fee.ts). Called by the first stage of every run (format-detect), on every attempt: when a copy's pages
   * stand above what admission priced, or it is an audio or video copy with media pages, the balance is checked once for
   * everything the run owes that no charge covers yet (the run-wide sum, copies included at their recorded classes), the
   * copies' media pages and the charges buffered in this activity. An unfunded run is paused (UnfundedPagesError) exactly as
   * an original's measured pages pause it; nothing is charged here. Off with the copy billing flag (copies bill nothing).
   */
  async authorizeCopies(documents: readonly Document[]): Promise<{ checkedPages: number } | null> {
    const copies = documents.filter(isDedupCopy);
    if (copies.length === 0 || !dedupCopiesBill()) return null;
    let mediaPages = 0;
    let above = false;
    for (const copy of copies) {
      if (isMediaDocument(copy)) {
        mediaPages += Math.max(0, Math.trunc(Number(copy.copyMediaPages)) || 0);
        continue;
      }
      const measured = Math.max(Number(copy.billingPages) || 0, Math.trunc(Number(copy.pageCount)) || 0);
      if (measured > intakePagesOf(copy)) above = true;
    }
    if (!above && mediaPages === 0) return null;
    const run = this.chargeableRun();
    const all = await this.ledger.runMeasurements(run.id, null, PAGE_READ_METRICS);
    const credits = runMeasuredPagesCredits(all, this.speedBoost())
      + (mediaPages > 0 ? pageCredits("rich", mediaPages) * this.boost() : 0)
      + this.state.usageLedger.pendingBillableCents;
    const pages = all.fastPages + all.ocrFrames + (all.ocrPages ?? 0) + (all.richPages ?? 0) + mediaPages;
    if (!(credits > 0)) return { checkedPages: 0 };
    const outcome = await this.checkCharge(run, credits);
    if (outcome.paused || outcome.blocked) {
      console.warn(`[page-auth] run=${run.id} stopped: ${copies.length} deduplicated copies; ${pages} pages above intake owe ${credits.toFixed(2)} credits more than the balance holds (paused=${outcome.paused})`);
      throw new UnfundedPagesError(`Credits do not cover the pages of this run's deduplicated copies; run ${outcome.paused ? "paused" : "stopped"}`, outcome.paused, credits, 0);
    }
    return { checkedPages: pages };
  }

  /**
   * Before work that incurs `charge`: whether the balance covers it plus the charges still buffered in this activity, pausing
   * the run when it does not. Throws SpendCheckUnavailableError (retryable) when it cannot decide.
   */
  async fund(charge: Extract<PageCharge, { kind: "page-read" }>): Promise<{ funded: boolean; paused: boolean; credits: number }> {
    const run = this.chargeableRun();
    const pages = Math.max(1, charge.pages);
    if (!Number.isSafeInteger(pages)) throw new PageBasisInvariantError(`invalid page-read count ${charge.pages}`);
    // The read, the charges still buffered here, and everything the run measured that no charge covers yet: a read never
    // spends balance a measured document of the run already owes at completion.
    const owed = await this.runOwedAll();
    const credits = runMeasuredPagesCredits({ fastPages: 0, ocrFrames: pages }, this.speedBoost()) + this.state.usageLedger.pendingBillableCents + owed;
    const outcome = await this.checkCharge(run, credits);
    return { funded: !outcome.paused && !outcome.blocked, paused: outcome.paused, credits };
  }

  /**
   * How many units of `charge` (pages, frames) the run can afford, 0..max, counting the charges still buffered in this
   * activity and, for image frames, everything else the run measured and has not been charged. Read-only: nothing is paused.
   * An image is always granted its first frame (`fund` covered it before the read). Throws SpendCheckUnavailableError when it
   * cannot decide.
   */
  async affordable(charge: Exclude<PageCharge, { kind: "page-read" }>, max: number): Promise<number> {
    const run = this.chargeableRun();
    const pending = this.state.usageLedger.pendingBillableCents;
    if (charge.kind === "page-upgrade") {
      const perPage = pageUpgradeCredits(charge.from, charge.to) * this.boost();
      const owed = await this.runOwedAll();
      return await this.ledger.largestFundedCharge(run, max, (n) => perPage * n + pending + owed);
    }
    const pipeline = this.pipeline();
    // What admission priced (durable), never the frames a previous attempt recorded as the page count.
    const intake = intakePagesOf(charge.document);
    const others = await this.ledger.runMeasurements(run.id, charge.document.id, PAGE_READ_METRICS);
    const othersOwe = runMeasuredPagesCredits(others, this.speedBoost());
    const frames = await this.ledger.largestFundedCharge(run, max,
      (n) => extraCreditsForMeasuredPages(pipeline, intake, n, null, { mode: "ocr" }) + othersOwe + pending);
    return Math.max(1, Math.min(max, frames));
  }

  /** Pause the run for funds without a balance check. Throws SpendCheckUnavailableError when no pause can be made. */
  async pauseForFunds(reason: string): Promise<SpendOutcome> {
    const run = this.chargeableRun();
    const outcome = await this.ledger.pauseForFunds(run, reason);
    if (typeof outcome?.paused !== "boolean") throw new SpendCheckUnavailableError(`run ${run.id} pause for ${reason} returned no outcome`);
    return outcome;
  }

  private async recordImageFrames(document: Document, frames: number): Promise<PageBasisChange> {
    // Validated before anything is written or the run total moves: a frame count that is not a positive integer is refused.
    if (!Number.isSafeInteger(frames) || frames < 1) throw new PageBasisInvariantError(`invalid frame count ${frames} for image ${document.id}`);
    const run = this.state.run;
    // What admission priced (durable, migration 0130): a retry finds the frames an earlier attempt recorded as the page count,
    // and must still authorize them; it never treats them as already priced.
    const intake = intakePagesOf(document);
    const recorded = Math.max(1, Math.trunc(document.pageCount) || 1);
    let persisted = false;
    if (document.pageCount !== frames) {
      persisted = await this.ledger.setPageCount(run.id, document.id, frames, this.state.executionGeneration);
      console.log(`[ocr] image-frames document=${document.id} pages=${frames} intake=${document.pageCount}`);
      document.pageCount = frames;
    }
    // The run's page total counted the page basis recorded so far.
    if (frames !== recorded) run.pagesTotal = Math.max(0, Number(run.pagesTotal) || 0) + frames - recorded;
    const change = { persisted, pageCount: document.pageCount, billingPages: document.billingPages ?? null };
    if (frames <= intake) return change;
    const pipeline = this.pipeline();
    const own = extraCreditsForMeasuredPages(pipeline, intake, frames, null, { mode: "ocr" });
    if (!(own > 0)) return change;
    const chargeable = this.chargeableRun();
    // The frames themselves are in the run-wide sum (uncharged frames past intake); only the feature extra is added here.
    const features = own - extraCreditsForMeasuredPages(pipeline, intake, frames, null, { mode: "ocr", features: false });
    const owed = await this.runOwed(document, intake);
    const credits = features + owed.credits;
    const outcome = await this.checkCharge(chargeable, credits);
    if (outcome.paused || outcome.blocked) throw unfunded(document, outcome.paused, credits, intake);
    return change;
  }

  private async recordBillingPages(document: Document, measurement: Extract<PageMeasurement, { kind: "billing-pages" }>): Promise<PageBasisChange> {
    const run = this.state.run;
    if (!Number.isSafeInteger(measurement.pages) || measurement.pages < 0) {
      throw new PageBasisInvariantError(`invalid billing pages ${measurement.pages} for document ${document.id}`);
    }
    const pipeline = this.pipeline();
    const intakePages = document.pageCount;
    // Never bill below a page basis intake counted from the bytes; an assumed intake (these formats' one page) is no floor, so
    // an empty file measures 0 pages.
    const floor = document.pageCountSource === "counted" ? Math.max(1, Math.floor(intakePages) || 1) : 0;
    const pages = Math.max(measurement.pages, floor);
    console.log(`[page-count] document=${document.id} format=${measurement.format} counted by ${measurement.method}: ${pages} pages (intake ${intakePages})`);
    const persisted = await this.ledger.setBillingPages(run.id, document.id, pages, measurement.method);
    document.billingPages = pages;
    document.billingPagesMethod = measurement.method;
    const change = { persisted, pageCount: document.pageCount, billingPages: pages };
    // The Fast fee on measured pages is charged only when the run completes, so the balance shows none of them yet: the one
    // run-wide sum adds every document of the run. Features are charged as their stages run (and checked there), so only this
    // document's feature extra is added.
    const own = extraCreditsForMeasuredPages(pipeline, intakePages, pages, measurement.method);
    if (!(own > 0)) return change;
    const chargeable = this.chargeableRun();
    const features = own - extraCreditsForMeasuredPages(pipeline, intakePages, pages, measurement.method, { features: false });
    const owed = await this.runOwed(document, intakePagesOf(document));
    const credits = features + owed.credits;
    const outcome = await this.checkCharge(chargeable, credits);
    if (outcome.paused || outcome.blocked) {
      console.warn(`[page-count] run=${run.id} document=${document.id} stopped (paused=${outcome.paused}): measured ${pages} pages (intake ${intakePages}) owes ${credits.toFixed(2)} more credits than the balance holds`);
      throw unfunded(document, outcome.paused, credits, intakePages);
    }
    return change;
  }

  /**
   * What the run owes for measured pages no charge covers yet: every other document of the run (durable, run_measured_pages)
   * plus this document from its in-memory state, so a document whose write the ledger did not take (a deduplicated copy) or
   * an attempt racing another is still counted.
   */
  private async runOwed(document: Document, intake: number): Promise<{ credits: number; pages: number }> {
    const others = await this.ledger.runMeasurements(this.state.run.id, document.id, PAGE_READ_METRICS);
    const own = documentMeasuredPages(document, Math.max(0, Number(others.documentChargedPages) || 0), intake);
    const total = { fastPages: others.fastPages + own.fastPages, ocrFrames: others.ocrFrames + own.ocrFrames, ocrPages: others.ocrPages ?? 0, richPages: others.richPages ?? 0 };
    return { credits: runMeasuredPagesCredits(total, this.speedBoost()), pages: total.fastPages + total.ocrFrames + total.ocrPages + total.richPages };
  }

  /** What the run owes for measured pages no charge covers yet, over every document (durable, run_measured_pages). */
  private async runOwedAll(): Promise<number> {
    const all = await this.ledger.runMeasurements(this.state.run.id, null, PAGE_READ_METRICS);
    return runMeasuredPagesCredits(all, this.speedBoost());
  }

  /** The ledger's charge check; a credit amount that is not a finite number is refused, never read as nothing owed. */
  private async checkCharge(run: PageBasisRun, credits: number): Promise<SpendOutcome> {
    if (!Number.isFinite(credits)) throw new SpendCheckUnavailableError(`run ${run.id} charge check got a non-finite amount (${credits})`);
    return await this.ledger.checkCharge(run, credits);
  }

  private pipeline(): ProjectRun["pipeline"] {
    const pipeline = this.state.run.pipeline;
    if (!pipeline) throw new PageBasisInvariantError(`run ${this.state.run.id} has no pipeline to price measured pages with`);
    return pipeline;
  }

  /**
   * The run as a spend check needs it. Every run row has a user (project_runs.user_id is NOT NULL); a run without one cannot
   * be charged or paused, so it is refused (retryable), never skipped. The organization is checked by the ledger: a run with
   * none is refused there.
   */
  private chargeableRun(): PageBasisRun {
    const run = this.state.run;
    if (!run.userId) {
      console.error(`[spend-check] charge-refused run=${run.id} org=${run.orgId ?? "none"} reason=no-user retryable=true`);
      throw new SpendCheckUnavailableError(`run ${run.id} has no user to check a charge for`);
    }
    return { id: run.id, orgId: run.orgId ?? null, projectId: run.projectId ?? null, userId: run.userId };
  }

  private speedBoost(): boolean {
    return this.state.run.pipeline?.speedBoost === true;
  }

  private boost(): number {
    return speedBoostMultiplier(this.speedBoost());
  }
}

function unfunded(document: Document, paused: boolean, credits: number, intakePages: number): UnfundedPagesError {
  return new UnfundedPagesError(`Credits do not cover the measured pages of document ${document.id}; run ${paused ? "paused" : "stopped"}`, paused, credits, intakePages);
}

function unboundLedger(runId: () => string): PageBasisLedger {
  const refuse = (operation: string): never => {
    console.error(`[page-basis] refused run=${runId()} operation=${operation}: no store bound`);
    throw new PageBasisUnboundError(runId(), operation);
  };
  return {
    setPageCount: async () => refuse("setPageCount"),
    setBillingPages: async () => refuse("setBillingPages"),
    recordPageEquivalents: async () => refuse("recordPageEquivalents"),
    recordWholeDocumentPages: async () => refuse("recordWholeDocumentPages"),
    runMeasurements: async () => refuse("runMeasurements"),
    checkCharge: async () => refuse("checkCharge"),
    largestFundedCharge: async () => refuse("largestFundedCharge"),
    pauseForFunds: async () => refuse("pauseForFunds"),
  };
}

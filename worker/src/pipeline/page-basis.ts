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
  pageCredits,
  pageUpgradeCredits,
  speedBoostMultiplier,
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

/** A document of the run the worker measured (billing_pages set) that still bills at completion. */
export interface MeasuredRunDocument { pageCount: number; billingPages: number; method: string | null }

/** A multi-frame image of the run whose counted frames raised its page count, with the pages a page-read charge already covers. */
export interface CountedImageFrames { documentId: string; pageCount: number; chargedPages: number }

export interface SpendOutcome { paused: boolean; blocked: boolean }

/**
 * The persistence and balance port a PageBasis runs over. Every method is required: an adapter that lacks one is a type
 * error, never a skipped check. Adapters: db/page-basis-ledger.ts (Postgres) and pipeline/page-basis-memory.ts (tests).
 * Every write is scoped to the run's own, non-deduplicated document.
 */
export interface PageBasisLedger {
  /** documents.page_count = pages, page_count_source = 'counted'. False when the document is not the run's own. */
  setPageCount(runId: string, documentId: string, pages: number): Promise<boolean>;
  /** documents.billing_pages = pages, billing_pages_method = method. False when the document is not the run's own. */
  setBillingPages(runId: string, documentId: string, pages: number, method: string): Promise<boolean>;
  /** Raises per-page equivalents and billing_pages (db/page-equivalents.ts recordPageEquivalents); returns billing_pages. */
  recordPageEquivalents(runId: string, documentId: string, rows: readonly PageEquivalentRow[], allowance: number): Promise<number | null>;
  /** Raises a whole-document text format's billing_pages (db/page-equivalents.ts recordWholeDocumentPages); returns billing_pages. */
  recordWholeDocumentPages(runId: string, documentId: string, pages: number): Promise<number | null>;
  /** Pages of the run's paged, non-media documents measured above what admission priced (documents.intake_page_count). */
  measuredPagesAboveIntake(runId: string): Promise<number>;
  /** The run's documents with billing_pages set that still bill at completion. */
  measuredDocuments(runId: string): Promise<MeasuredRunDocument[]>;
  /** The run's multi-frame images whose page count was raised above one, with their pages already charged. */
  countedImageFrames(runId: string): Promise<CountedImageFrames[]>;
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
  readonly run: ProjectRun;
  readonly usageLedger: { readonly pendingBillableCents: number };
}

/** The page count admission priced for a document: durable (migration 0130), never the count a measurement wrote. */
export function intakePagesOf(document: Pick<Document, "pageCount" | "intakePageCount">): number {
  const intake = document.intakePageCount ?? document.pageCount;
  return Math.max(1, Math.trunc(Number(intake)) || 1);
}

/**
 * The credits a document's measurement owes once the run's other measured documents are counted: its own feature extra plus the
 * larger of its own base extra and the run's (whose rows include this document once it is recorded). The one place the run-wide
 * sum is taken, for measured Office pages and for counted image frames alike.
 */
function runWideCredits(own: number, ownBase: number, runBase: number): number {
  return own - ownBase + Math.max(ownBase, runBase);
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
   * in-memory document and run, and re-check the run's spend for what the change owes. Throws UnfundedPagesError (the run is
   * paused or stopped) or SpendCheckUnavailableError (retryable) before anything is charged for the new pages.
   *  - page-count: page_count; a raise is authorized like `authorize`, a lowering never is.
   *  - image-frames: page_count; frames past intake are checked at the OCR rate with the run's other images' uncharged frames.
   *  - billing-pages: billing_pages, never below an intake count taken from the bytes; the Fast extra is checked with every
   *    measured document of the run, the feature extra for this document alone.
   *  - page-equivalents / whole-document: raise billing_pages (never lowered), then `authorize`.
   */
  async record(document: Document, measurement: PageMeasurement): Promise<PageBasisChange> {
    const run = this.state.run;
    switch (measurement.kind) {
      case "page-count": {
        const pages = measurement.pages;
        if (!Number.isSafeInteger(pages) || pages < 0) throw new Error(`invalid page count ${pages} for document ${document.id}`);
        const before = Math.max(1, Math.trunc(Number(document.pageCount)) || 1);
        const persisted = await this.ledger.setPageCount(run.id, document.id, pages);
        document.pageCount = pages;
        document.pageCountSource = "counted";
        run.pagesTotal = Math.max(0, (Number(run.pagesTotal) || 0) + pages - before);
        if (pages > before) await this.authorize(document);
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
   * when the document measured above what admission priced, check the balance for every Fast page the run measured above its
   * intake counts (durable state), none of which is charged before completion. Never inferred from page_count_source.
   */
  async authorize(document: Document): Promise<{ checkedPages: number } | null> {
    const measured = Math.max(Number(document.billingPages) || 0, Math.trunc(Number(document.pageCount)) || 0);
    if (!(measured > intakePagesOf(document))) return null;
    const run = this.chargeableRun();
    const pages = await this.ledger.measuredPagesAboveIntake(run.id);
    if (!(pages > 0)) return { checkedPages: 0 };
    const credits = pageCredits("fast", pages) * this.boost();
    const outcome = await this.ledger.checkCharge(run, credits);
    if (outcome.paused || outcome.blocked) {
      console.warn(`[page-auth] run=${run.id} document=${document.id} stopped: ${pages} measured pages above intake owe ${credits.toFixed(2)} credits more than the balance holds (paused=${outcome.paused})`);
      throw unfunded(document, outcome.paused, credits, intakePagesOf(document));
    }
    return { checkedPages: pages };
  }

  /**
   * Before work that incurs `charge`: whether the balance covers it plus the charges still buffered in this activity, pausing
   * the run when it does not. Throws SpendCheckUnavailableError (retryable) when it cannot decide.
   */
  async fund(charge: Extract<PageCharge, { kind: "page-read" }>): Promise<{ funded: boolean; paused: boolean; credits: number }> {
    const run = this.chargeableRun();
    const credits = pageCredits(charge.mode, Math.max(1, charge.pages)) * this.boost() + this.state.usageLedger.pendingBillableCents;
    const outcome = await this.ledger.checkCharge(run, credits);
    return { funded: !outcome.paused && !outcome.blocked, paused: outcome.paused, credits };
  }

  /**
   * How many units of `charge` (pages, frames) the run can afford, 0..max, counting the charges still buffered in this
   * activity and, for image frames, every other image of the run's uncharged frames. Read-only: nothing is paused. An image
   * is always granted its first frame (`fund` covered it before the read). Throws SpendCheckUnavailableError when it cannot decide.
   */
  async affordable(charge: Exclude<PageCharge, { kind: "page-read" }>, max: number): Promise<number> {
    const run = this.chargeableRun();
    const pending = this.state.usageLedger.pendingBillableCents;
    if (charge.kind === "page-upgrade") {
      const perPage = pageUpgradeCredits(charge.from, charge.to) * this.boost();
      return await this.ledger.largestFundedCharge(run, max, (n) => perPage * n + pending);
    }
    const pipeline = this.state.run.pipeline;
    // What admission priced (durable), never the frames a previous attempt recorded as the page count.
    const intake = intakePagesOf(charge.document);
    const others = (await this.ledger.countedImageFrames(run.id))
      .filter((row) => row.documentId !== charge.document.id)
      .reduce((sum, row) => sum + extraCreditsForMeasuredPages(pipeline, Math.max(1, row.chargedPages), row.pageCount, null, { mode: "ocr", features: false }), 0);
    const frames = await this.ledger.largestFundedCharge(run, max,
      (n) => extraCreditsForMeasuredPages(pipeline, intake, n, null, { mode: "ocr" }) + others + pending);
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
    const run = this.state.run;
    // What admission priced (durable, migration 0130): a retry finds the frames an earlier attempt recorded as the page count,
    // and must still authorize them; it never treats them as already priced.
    const intake = intakePagesOf(document);
    const recorded = Math.max(1, Math.trunc(document.pageCount) || 1);
    let persisted = false;
    if (Number.isSafeInteger(frames) && frames >= 1 && document.pageCount !== frames) {
      persisted = await this.ledger.setPageCount(run.id, document.id, frames);
      console.log(`[ocr] image-frames document=${document.id} pages=${frames} intake=${document.pageCount}`);
      document.pageCount = frames;
    }
    // The run's page total counted the page basis recorded so far.
    if (frames !== recorded) run.pagesTotal = Math.max(0, Number(run.pagesTotal) || 0) + frames - recorded;
    const change = { persisted, pageCount: document.pageCount, billingPages: document.billingPages ?? null };
    if (frames <= intake) return change;
    const pipeline = run.pipeline;
    const own = extraCreditsForMeasuredPages(pipeline, intake, frames, null, { mode: "ocr" });
    if (!(own > 0)) return change;
    const chargeable = this.chargeableRun();
    const ownRead = extraCreditsForMeasuredPages(pipeline, intake, frames, null, { mode: "ocr", features: false });
    // Frames of the run's images no page-read charge covers yet (page 1 was priced at admission).
    const runRead = (await this.ledger.countedImageFrames(run.id))
      .reduce((sum, row) => sum + extraCreditsForMeasuredPages(pipeline, Math.max(1, row.chargedPages), row.pageCount, null, { mode: "ocr", features: false }), 0);
    const credits = runWideCredits(own, ownRead, runRead);
    const outcome = await this.ledger.checkCharge(chargeable, credits);
    if (outcome.paused || outcome.blocked) throw unfunded(document, outcome.paused, credits, intake);
    return change;
  }

  private async recordBillingPages(document: Document, measurement: Extract<PageMeasurement, { kind: "billing-pages" }>): Promise<PageBasisChange> {
    const run = this.state.run;
    const intakePages = document.pageCount;
    // Never bill below a page basis intake counted from the bytes; an assumed intake (these formats' one page) is no floor, so
    // an empty file measures 0 pages.
    const floor = document.pageCountSource === "counted" ? Math.max(1, Math.floor(intakePages) || 1) : 0;
    const pages = Math.max(measurement.pages, floor);
    if (!Number.isSafeInteger(pages) || pages < 0) throw new Error(`invalid billing pages ${pages} for document ${document.id}`);
    console.log(`[page-count] document=${document.id} format=${measurement.format} counted by ${measurement.method}: ${pages} pages (intake ${intakePages})`);
    const persisted = await this.ledger.setBillingPages(run.id, document.id, pages, measurement.method);
    document.billingPages = pages;
    document.billingPagesMethod = measurement.method;
    const change = { persisted, pageCount: document.pageCount, billingPages: pages };
    // Admission priced the intake count. The Fast fee on measured pages is charged only when the run completes, so the balance
    // shows no measured document's extra pages yet: the run's measured documents are added, not just this one. Features are
    // charged as their stages run (and checked there), so only this document's feature extra is added.
    const pipeline = run.pipeline;
    const own = extraCreditsForMeasuredPages(pipeline, intakePages, pages, measurement.method);
    if (!(own > 0)) return change;
    const chargeable = this.chargeableRun();
    const ownFast = extraCreditsForMeasuredPages(pipeline, intakePages, pages, measurement.method, { features: false });
    const runFast = (await this.ledger.measuredDocuments(run.id))
      .reduce((sum, row) => sum + extraCreditsForMeasuredPages(pipeline, row.pageCount, row.billingPages, row.method, { features: false }), 0);
    const credits = runWideCredits(own, ownFast, runFast);
    const outcome = await this.ledger.checkCharge(chargeable, credits);
    if (outcome.paused || outcome.blocked) {
      console.warn(`[page-count] run=${run.id} document=${document.id} stopped (paused=${outcome.paused}): measured ${pages} pages (intake ${intakePages}) owes ${credits.toFixed(2)} more credits than the balance holds`);
      throw unfunded(document, outcome.paused, credits, intakePages);
    }
    return change;
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

  private boost(): number {
    return speedBoostMultiplier(this.state.run.pipeline?.speedBoost === true);
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
    measuredPagesAboveIntake: async () => refuse("measuredPagesAboveIntake"),
    measuredDocuments: async () => refuse("measuredDocuments"),
    countedImageFrames: async () => refuse("countedImageFrames"),
    checkCharge: async () => refuse("checkCharge"),
    largestFundedCharge: async () => refuse("largestFundedCharge"),
    pauseForFunds: async () => refuse("pauseForFunds"),
  };
}

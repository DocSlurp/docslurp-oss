/*
 * In-memory adapter of the page basis ledger (pipeline/page-basis.ts), for tests and tools without a database. It models the
 * documents table's page columns, a run's charged page reads, the organization's available balance and the run's pause state
 * with the same rules as the Postgres adapter (db/page-basis-ledger.ts): writes scoped to the run's own, non-deduplicated
 * document; monotone page equivalents; a charge blocked once it would take the balance below `floor`.
 */
import { DEFAULT_PAGE_EQUIVALENT_ALLOWANCE, defaultPipelineFeatures } from "@docslurp/shared";

import { SpendCheckUnavailableError } from "../db/spend-check.js";
import type { PageEquivalentRow } from "../db/page-equivalents.js";
import type { Document, ProjectRun } from "../models.js";
import { PageBasis, type CountedImageFrames, type MeasuredRunDocument, type PageBasisLedger, type PageBasisRun, type PageBasisState, type SpendOutcome } from "./page-basis.js";

/** One documents row, as far as the page basis reads it. */
export interface MemoryPageBasisDocument {
  id: string;
  runId: string;
  mimeType: string;
  status: string;
  pageCount: number;
  pageCountSource: "counted" | "assumed" | null;
  intakePageCount: number | null;
  billingPages: number | null;
  billingPagesMethod: string | null;
  dedupedFromDocumentId: string | null;
  /** Per-page equivalents above one page (document_page_facts). */
  facts: Map<number, { text: number | null; area: number | null }>;
  /** Distinct pages a page-read charge of the run already covers (usage_attribution). */
  chargedPages: number;
}

export interface MemoryPageBasisOptions {
  /** Available credits of the run's organization. Default: unlimited. */
  balance?: number;
  /** A charge is blocked once the balance after it falls below this (the running-job floor). Default 0. */
  floor?: number;
  /** False models WORKER_SPEND_CHECK=off: charges pass and sizing returns max. Default true. */
  spendCheckEnabled?: boolean;
}

export class MemoryPageBasisLedger implements PageBasisLedger {
  readonly documents = new Map<string, MemoryPageBasisDocument>();
  balance: number;
  floor: number;
  spendCheckEnabled: boolean;
  /** The run's pause state (project_runs.control_state / pause_reason). */
  paused: { reason: string } | null = null;
  /** Credits each checkCharge was asked about, in order. */
  readonly checks: number[] = [];
  /** Units each largestFundedCharge was asked about (the credits for `max`), in order. */
  readonly sizings: number[] = [];
  /** Every page_count write the ledger accepted, in order. */
  readonly pageCountWrites: Array<{ documentId: string; pages: number }> = [];
  /** Reasons each pauseForFunds was asked for, in order. */
  readonly pauses: string[] = [];
  /** Makes the next balance read or pause write fail, as a lost database connection would. */
  failNext: "balance" | "pause" | null = null;

  constructor(options: MemoryPageBasisOptions = {}) {
    this.balance = options.balance ?? Number.POSITIVE_INFINITY;
    this.floor = options.floor ?? 0;
    this.spendCheckEnabled = options.spendCheckEnabled ?? true;
  }

  /** Seeds the table with documents as their rows stand (copies: the state's own Document objects stay separate, as in a database). */
  seed(documents: readonly Document[]): this {
    for (const document of documents) {
      this.documents.set(document.id, {
        id: document.id,
        runId: document.runId,
        mimeType: document.mimeType ?? "",
        status: document.status ?? "processing",
        pageCount: Number(document.pageCount) || 0,
        pageCountSource: document.pageCountSource ?? null,
        intakePageCount: document.intakePageCount ?? null,
        billingPages: document.billingPages ?? null,
        billingPagesMethod: document.billingPagesMethod ?? null,
        dedupedFromDocumentId: (document as { dedupedFromDocumentId?: string | null }).dedupedFromDocumentId ?? null,
        facts: new Map(),
        chargedPages: 0,
      });
    }
    return this;
  }

  private own(runId: string, documentId: string): MemoryPageBasisDocument | null {
    const row = this.documents.get(documentId);
    return row && row.runId === runId && !row.dedupedFromDocumentId ? row : null;
  }

  private ofRun(runId: string): MemoryPageBasisDocument[] {
    return [...this.documents.values()].filter((row) => row.runId === runId && !row.dedupedFromDocumentId);
  }

  async setPageCount(runId: string, documentId: string, pages: number): Promise<boolean> {
    const row = this.own(runId, documentId);
    if (!row) return false;
    row.pageCount = pages;
    row.pageCountSource = "counted";
    this.pageCountWrites.push({ documentId, pages });
    return true;
  }

  async setBillingPages(runId: string, documentId: string, pages: number, method: string): Promise<boolean> {
    if (!(pages >= 0)) throw new Error(`billing_pages must be non-negative (got ${pages})`);
    const row = this.own(runId, documentId);
    if (!row) return false;
    row.billingPages = pages;
    row.billingPagesMethod = method;
    return true;
  }

  async recordPageEquivalents(runId: string, documentId: string, rows: readonly PageEquivalentRow[], allowance: number): Promise<number | null> {
    const row = this.own(runId, documentId);
    if (!row) return this.documents.get(documentId)?.runId === runId ? this.documents.get(documentId)!.billingPages : null;
    const limit = Math.max(1, Math.floor(allowance ?? DEFAULT_PAGE_EQUIVALENT_ALLOWANCE) || 1);
    for (const fact of rows) {
      if (!Number.isSafeInteger(fact.pageNumber) || fact.pageNumber < 1) continue;
      const text = Number.isFinite(fact.text) && fact.text! > 1 ? Math.floor(fact.text!) : null;
      const area = Number.isFinite(fact.area) && fact.area! > 1 ? Math.floor(fact.area!) : null;
      if (text === null && area === null) continue;
      const stored = row.facts.get(fact.pageNumber) ?? { text: null, area: null };
      row.facts.set(fact.pageNumber, {
        text: Math.max(stored.text ?? 0, text ?? 0) || null,
        area: Math.max(stored.area ?? 0, area ?? 0) || null,
      });
    }
    let extra = 0;
    for (const [pageNumber, fact] of row.facts) {
      if (pageNumber > Math.max(row.pageCount, 1)) continue;
      extra += Math.max((fact.text ?? 1) > limit ? fact.text! : 1, fact.area ?? 1) - 1;
    }
    if (extra > 0) {
      const total = row.pageCount + extra;
      if (total > (row.billingPages ?? 0)) {
        row.billingPages = total;
        row.billingPagesMethod = "page-equivalents";
      }
    }
    return row.billingPages;
  }

  async recordWholeDocumentPages(runId: string, documentId: string, pages: number): Promise<number | null> {
    const row = this.own(runId, documentId);
    if (!row) return this.documents.get(documentId)?.runId === runId ? this.documents.get(documentId)!.billingPages : null;
    const measured = Number.isSafeInteger(pages) && pages > 0 ? pages : 0;
    if (measured > Math.max(row.billingPages ?? 0, row.pageCount)) {
      row.billingPages = measured;
      row.billingPagesMethod = "page-equivalents";
    }
    return row.billingPages;
  }

  async measuredPagesAboveIntake(runId: string): Promise<number> {
    return this.ofRun(runId)
      .filter((row) => row.status !== "failed" && !/^(image|audio|video)\//.test(row.mimeType))
      .reduce((sum, row) => sum + Math.max(0, (row.billingPages ?? row.pageCount) - (row.intakePageCount ?? row.pageCount)), 0);
  }

  async measuredDocuments(runId: string): Promise<MeasuredRunDocument[]> {
    return this.ofRun(runId)
      .filter((row) => row.billingPages !== null && row.status !== "failed")
      .map((row) => ({ pageCount: row.pageCount, billingPages: row.billingPages!, method: row.billingPagesMethod }));
  }

  async countedImageFrames(runId: string): Promise<CountedImageFrames[]> {
    return this.ofRun(runId)
      .filter((row) => row.pageCount > 1 && ["image/tiff", "image/tiff-fx"].includes(row.mimeType.split(";")[0]!.trim().toLowerCase()))
      .map((row) => ({ documentId: row.id, pageCount: row.pageCount, chargedPages: row.chargedPages }));
  }

  async checkCharge(run: PageBasisRun, credits: number): Promise<SpendOutcome> {
    if (!this.spendCheckEnabled || !(credits > 0)) return { paused: false, blocked: false };
    if (!run.orgId) throw new SpendCheckUnavailableError(`run ${run.id} has no organization to check a ${credits.toFixed(2)}-credit charge against`);
    this.checks.push(credits);
    this.failIf("balance");
    if (this.balance - credits >= this.floor) return { paused: false, blocked: false };
    return this.pause("credit_exhausted");
  }

  async largestFundedCharge(run: PageBasisRun, max: number, creditsFor: (n: number) => number): Promise<number> {
    if (!this.spendCheckEnabled) return max;
    if (!run.orgId) throw new SpendCheckUnavailableError(`run ${run.id} has no organization to size a charge against`);
    this.sizings.push(creditsFor(max));
    this.failIf("balance");
    for (let n = max; n >= 1; n -= 1) if (this.balance - creditsFor(n) >= this.floor) return n;
    return 0;
  }

  async pauseForFunds(_run: PageBasisRun, reason: string): Promise<SpendOutcome> {
    this.pauses.push(reason);
    return this.pause(reason);
  }

  private pause(reason: string): SpendOutcome {
    this.failIf("pause");
    if (this.paused) return { paused: false, blocked: true };
    this.paused = { reason };
    return { paused: true, blocked: true };
  }

  private failIf(kind: "balance" | "pause"): void {
    if (this.failNext !== kind) return;
    this.failNext = null;
    throw new SpendCheckUnavailableError(kind === "balance" ? "balance read failed" : "could not pause the run");
  }
}

/**
 * Binds `state` to a fresh in-memory ledger seeded with its documents, and returns the ledger: what a test or a database-free
 * tool uses in place of the store's adapter.
 */
export function bindMemoryPageBasis(
  state: PageBasisState & { documents: Document[]; pageBasis: PageBasis },
  options: MemoryPageBasisOptions = {},
): MemoryPageBasisLedger {
  const ledger = new MemoryPageBasisLedger(options).seed(state.documents);
  state.pageBasis = new PageBasis(state, ledger);
  return ledger;
}

/**
 * A page basis over a fresh in-memory ledger for `run` (defaults: organization `org-1`, user `user-1`, the default pipeline)
 * and its `documents`: what tests of measuring code pass where a WorkflowState's page basis is needed.
 */
export function memoryPageBasis(
  run: Partial<ProjectRun> & { id: string },
  documents: readonly Document[] = [],
  options: MemoryPageBasisOptions = {},
): { pageBasis: PageBasis; ledger: MemoryPageBasisLedger; run: ProjectRun } {
  const fullRun = { orgId: "org-1", userId: "user-1", pagesTotal: 0, pipeline: { ...defaultPipelineFeatures }, ...run } as ProjectRun;
  const ledger = new MemoryPageBasisLedger(options).seed(documents);
  return { pageBasis: new PageBasis({ run: fullRun, usageLedger: { pendingBillableCents: 0 } }, ledger), ledger, run: fullRun };
}

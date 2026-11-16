/*
 * Page reader: an optional second read of OCR'd pages by an extractor plugin's `pageImageReader` provider, in its own
 * isolated VM, before the hosted escalation reader (docs/extraction/ocr.md, "Page reader").
 *
 * - Off unless the operator sets DOCSLURP_OCR_PAGE_READER (`escalation`: the pages escalation would read; `all`: every
 *   page the boundary read). With the flag on, the worker refuses to start without a ready provider or outside the `vm` and
 *   `local` OCR modes.
 * - The reader only sees PNGs the OCR boundary wrote. The host re-checks each by signature and size (never decoding pixels)
 *   and sends paths under an explicit tenant scope (organization and run); a run without an organization is never sent.
 * - Every answer is untrusted: a malformed job response is rejected whole and its pages keep the recogniser's text.
 * - A failed or refused job never fails a page or a document, and never moves the read to the worker host or a weaker
 *   boundary: its pages keep the recogniser's text and stay hosted escalation candidates.
 * - Provider cost is recorded on the usage ledger (`ocr-page-reader`, 0 credits); the page itself is one Rich page,
 *   charged once per run like the recogniser read of it.
 */
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { priceAiUsageEvent } from "@docslurp/shared";

import {
  PAGE_IMAGE_READ_FAILURES,
  pageImageReaderProvider,
  pageReaderUsageOf,
  type PageImageReadFailure,
  type PageImageReadJob,
  type PageImageReadResult,
  type PageImageReaderProvider,
} from "../extractors/plugins.js";
import type { UsageEvent } from "../models.js";
import { isCostCapExceeded } from "../pipeline/checkpoints.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import type { OcrPageRead, OcrReadOutcome } from "./engine.js";
import { processPageReaderOrgBudget, type PageReaderOrgBudget } from "./page-reader-budget.js";
import { logPageReaderWarmSummary, pageReaderWarmGate, pageReaderWarmPolicy, recordPageReaderWarmRouting, releasePageReaderWarmReservation } from "./page-reader-warm.js";
import { ocrPageReaderMaxPages, ocrPageReaderMode, ocrPageReaderOrgDailyMaxCostCents, OCR_PAGE_READER_METRIC, pageReaderAllowedForPrivacy, type OcrPageReaderMode } from "./page-reader-mode.js";

export * from "./page-reader-mode.js";

export interface PageReaderSummary {
  /** The reader's mode for this route (`escalation` / `all` for OCR, `all` for vision transcription). */
  mode: string;
  provider: string;
  /** Pages sent to the provider. */
  attempted: number;
  /** Pages whose text the reader replaced. */
  replaced: number;
  /** Pages the reader answered with no text (the recogniser's read stands). */
  empty: number;
  /** Pages sent but not read, by reason (provider failures, `job-failed`, `job-refused`, `invalid-response`, `missing`). */
  failed: Record<string, number>;
  /** Candidate pages never sent, by reason (`no-scope`, `budget`, `cost-cap`, `org-daily-cost-cap`, `budget-ledger-unavailable`, `image-refused`). */
  skipped: Record<string, number>;
  jobs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface PageReaderContext {
  state: Pick<WorkflowState, "usageLedger"> & {
    run?: Pick<WorkflowState["run"], "id" | "orgId" | "projectId" | "spentCents" | "pipeline">;
    /** The fleet-wide org daily ledger (page-reader-budget.ts): null refuses every job; absent (store-less runs) counts in this process. */
    pageReaderBudget?: PageReaderOrgBudget | null;
  };
  documentId: string;
  mode: string;
  maxPages: number;
  /** Provider cost (cents) one organization's reader jobs may commit per UTC day (DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS). */
  orgDailyMaxCostCents?: number;
  signal?: AbortSignal;
}

/** No page reports more tokens than this; a larger count is not a real read (a provider bug or a hostile VM). */
export const MAX_PAGE_READER_TOKENS_PER_PAGE = 100_000;
/** Longest edge and pixel count a page PNG may report when the host has no exact size to expect (a rendered page). */
export const PAGE_READER_MAX_EDGE_PX = 10_000;
export const PAGE_READER_MAX_PIXELS = 40_000_000;

/** Markdown from the boundary without NUL and other C0 control characters (tab, newline and carriage return stay). */
export function stripControlCharacters(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/**
 * Pages of each document the reader has been sent in this worker, per run state (the per-document budget across the
 * document's OCR batches and vision reads). Keyed by the run's usage ledger, so it lives exactly as long as the activity's state.
 */
const pagesSent = new WeakMap<object, Map<string, number>>();

function bump(map: Record<string, number>, key: string, by = 1): void {
  if (by > 0) map[key] = (map[key] ?? 0) + by;
}

/** A PNG's signature and IHDR size, within `maxBytes`, read without decoding pixels. Null when it is not that PNG. */
async function checkedPng(file: string, maxBytes: number): Promise<{ width: number; height: number } | null> {
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || info.size < 33 || info.size > maxBytes) return null;
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) return null;
  try {
    const head = Buffer.alloc(24);
    const { bytesRead } = await handle.read(head, 0, 24, 0);
    if (bytesRead < 24) return null;
    if (!head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
    if (head.readUInt32BE(8) !== 13 || head.toString("ascii", 12, 16) !== "IHDR") return null;
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Validate one job's response against the keys sent. Throws (the whole job is rejected) on anything malformed: not an
 * array, an unknown or repeated key, a status or failure reason outside the contract, Markdown that is not a string or is
 * over the provider's byte cap, or token counts that are not non-negative integers.
 */
export function validatePageReadResults(raw: unknown, keys: ReadonlySet<string>, maxMarkdownBytes: number): Map<string, PageImageReadResult> {
  if (!Array.isArray(raw)) throw new Error("results is not an array");
  if (raw.length > keys.size) throw new Error(`results has ${raw.length} entries for ${keys.size} pages`);
  const out = new Map<string, PageImageReadResult>();
  for (const [index, item] of raw.entries()) {
    if (!item || typeof item !== "object") throw new Error(`result ${index} is not an object`);
    const record = item as Record<string, unknown>;
    const key = record.key;
    if (typeof key !== "string" || !keys.has(key)) throw new Error(`result ${index} has an unknown key`);
    if (out.has(key)) throw new Error(`result ${index} repeats a key`);
    if (record.status === "read") {
      if (typeof record.markdown !== "string") throw new Error(`result ${index} markdown is not a string`);
      if (Buffer.byteLength(record.markdown, "utf8") > maxMarkdownBytes) throw new Error(`result ${index} markdown exceeds ${maxMarkdownBytes} bytes`);
      for (const field of ["inputTokens", "outputTokens"] as const) {
        if (record[field] !== undefined && !isCount(record[field])) throw new Error(`result ${index} ${field} is not a non-negative integer`);
        if ((record[field] as number | undefined ?? 0) > MAX_PAGE_READER_TOKENS_PER_PAGE) throw new Error(`result ${index} ${field} is over ${MAX_PAGE_READER_TOKENS_PER_PAGE}`);
      }
      out.set(key, {
        key, status: "read", markdown: record.markdown,
        ...(record.inputTokens !== undefined ? { inputTokens: record.inputTokens as number } : {}),
        ...(record.outputTokens !== undefined ? { outputTokens: record.outputTokens as number } : {}),
      });
    } else if (record.status === "failed") {
      if (typeof record.reason !== "string" || !(PAGE_IMAGE_READ_FAILURES as readonly string[]).includes(record.reason)) {
        throw new Error(`result ${index} has an unknown failure reason`);
      }
      out.set(key, { key, status: "failed", reason: record.reason as PageImageReadFailure });
    } else {
      throw new Error(`result ${index} has an unknown status`);
    }
  }
  return out;
}

const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

/**
 * Record the provider's usage events at provider cost, 0 credits: the metric, model and scope are the host's, never the
 * provider's (a provider can never record a billable unit charge or another tenant's scope). Returns the tokens recorded.
 */
function recordProviderUsage(
  events: unknown,
  provider: PageImageReaderProvider,
  ctx: PageReaderContext,
  metric: string,
  details: { pages: number; outcome: "completed" | "failed" },
): { inputTokens: number; outputTokens: number; costCents: number } {
  const totals = { inputTokens: 0, outputTokens: 0, costCents: 0 };
  if (!Array.isArray(events)) return totals;
  const run = ctx.state.run!;
  // Bounded by the pages the job carried: a provider cannot inflate token telemetry or the ledger past that.
  const tokenCap = details.pages * MAX_PAGE_READER_TOKENS_PER_PAGE;
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as Partial<UsageEvent>;
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
    const inputTokens = Math.min(tokenCap, Math.floor(number(event.inputTokens)));
    const outputTokens = Math.min(tokenCap, Math.floor(number(event.outputTokens)));
    const costCents = number(event.costCents);
    totals.costCents += costCents;
    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    const priced = priceAiUsageEvent({
      provider: typeof event.provider === "string" && SAFE_LABEL.test(event.provider) ? event.provider : `page-reader:${provider.id}`,
      model: provider.model,
      metric,
      amount: number(event.amount) || details.pages,
      unit: typeof event.unit === "string" && SAFE_LABEL.test(event.unit) ? event.unit : "page",
      costCents,
      inputTokens,
      outputTokens,
      metadata: {
        orgId: run.orgId,
        runId: run.id,
        ...(run.projectId ? { projectId: run.projectId } : {}),
        documentId: ctx.documentId,
        purpose: metric,
        reader: provider.id,
        pages: details.pages,
        outcome: details.outcome,
        costSource: "provider",
      },
    });
    ctx.state.usageLedger.enqueue({ ...priced, id: randomUUID() });
  }
  return totals;
}

/** The reason a job's rejection carries: a provider refusal, or anything else (infrastructure). */
function jobFailureReason(error: unknown): "job-refused" | "job-failed" {
  return (error as { ocrRefused?: unknown } | null)?.ocrRefused === true ? "job-refused" : "job-failed";
}

function release(sent: Map<string, number>, documentId: string, pages: number): void {
  sent.set(documentId, Math.max(0, (sent.get(documentId) ?? 0) - pages));
}

/** Pages of `documentId` the reader may still be sent in this run state (the per-document budget, `maxPages`). */
export function pageReaderPagesRemaining(ledger: object, documentId: string, maxPages: number): number {
  return Math.max(0, maxPages - (pagesSent.get(ledger)?.get(documentId) ?? 0));
}

/** Skip reasons after which no further job of this document (or organization) can be sent now. */
export const PAGE_READER_STOP_REASONS = ["no-scope", "privacy", "budget", "cost-cap", "org-daily-cost-cap", "budget-ledger-unavailable", "no-cost-estimate"] as const;

/** One page image the host sends to the reader. */
export interface PageImageInput {
  pageNumber: number;
  imagePath: string;
  /** The exact size the host expects the PNG to report (the OCR boundary's frame). */
  expect?: { width: number; height: number };
}

/** What a reader route (OCR or vision transcription) asks of the shared job loop. */
export interface PageImageReadUse {
  /** Usage event metric, `purpose`, Rich page `readBy` and `[ai-usage]` metric. */
  metric: string;
  /** Log line prefix, e.g. `[ocr] page-reader`. */
  logTag: string;
  /** Refuse a job (skip `no-cost-estimate`) unless the provider estimates a positive, finite cost to reserve. */
  requireCostEstimate?: boolean;
  /** Longest edge a PNG without `expect` may report (default PAGE_READER_MAX_EDGE_PX). */
  maxLongEdgePx?: number;
  /** Send jobs marked `requireReady` (warm start, page-reader-warm.ts): the provider never boots or waits for a reader for them. */
  requireReady?: boolean;
  /** Called for each page the reader returned non-empty, validated text for, before its Rich page charge. */
  onRead(page: PageImageInput, read: { text: string; inputTokens: number; outputTokens: number }): void;
}

/**
 * Send `pages` to `provider` in jobs of at most `maxPagesPerJob`, all under the run's explicit tenant scope (organization
 * and run): never a job without an organization, never pages of another run. Each PNG is re-checked by signature, byte
 * size and header size (never decoded); the per-document page budget, the run cost cap and the organization's daily reader
 * spend admit each job. Every answer is validated whole; a page with text is handed to `use.onRead` and charged one Rich
 * page. Pages not handed to `onRead` were not read, and the caller keeps its own fallback for them.
 */
export async function readPageImagesWithProvider(
  pages: readonly PageImageInput[],
  provider: PageImageReaderProvider,
  ctx: PageReaderContext,
  use: PageImageReadUse,
): Promise<PageReaderSummary> {
  const summary: PageReaderSummary = {
    mode: ctx.mode, provider: provider.id, attempted: 0, replaced: 0, empty: 0, failed: {}, skipped: {}, jobs: 0, inputTokens: 0, outputTokens: 0,
  };
  if (!pages.length) return summary;
  const run = ctx.state.run;
  // Never a call without an explicit tenant scope: the provider binds its VM to this organization.
  if (!run?.id || typeof run.orgId !== "string" || !run.orgId) {
    bump(summary.skipped, "no-scope", pages.length);
    console.error(`${use.logTag} skipped document=${ctx.documentId} pages=${pages.length}: the run has no organization scope`);
    return logSummary(summary, ctx, use);
  }
  // Q14: under local-only / strict-privacy only an operator-registered private reader may read the pages; the recogniser's
  // text (or the caller's own fallback) stands otherwise. A run whose pipeline is unknown is treated as restricted.
  if (!readerAllowedForRun(provider, run)) {
    bump(summary.skipped, "privacy", pages.length);
    console.warn(`${use.logTag} skipped document=${ctx.documentId} pages=${pages.length}: the project's privacy mode admits only a registered private reader`);
    return logSummary(summary, ctx, use);
  }
  const scope = { orgId: run.orgId, runId: run.id };
  let sent = pagesSent.get(ctx.state.usageLedger);
  if (!sent) pagesSent.set(ctx.state.usageLedger, (sent = new Map()));

  const maxEdge = use.maxLongEdgePx ?? PAGE_READER_MAX_EDGE_PX;
  const ready: PageImageInput[] = [];
  for (const page of pages) {
    // Re-checked here against the provider's own cap: still a PNG, of the size the host expects, never decoded.
    const png = await checkedPng(page.imagePath, provider.maxImageBytes);
    const fits = png && (page.expect
      ? png.width === page.expect.width && png.height === page.expect.height
      : png.width >= 1 && png.height >= 1 && Math.max(png.width, png.height) <= maxEdge && png.width * png.height <= PAGE_READER_MAX_PIXELS);
    if (!fits) {
      bump(summary.skipped, "image-refused");
      console.warn(`${use.logTag} image refused document=${ctx.documentId} page=${page.pageNumber}: not the expected PNG, over ${provider.maxImageBytes} bytes or over its size bound`);
      continue;
    }
    ready.push(page);
  }
  const used = sent.get(ctx.documentId) ?? 0;
  const allowed = Math.max(0, ctx.maxPages - used);
  if (ready.length > allowed) {
    bump(summary.skipped, "budget", ready.length - allowed);
    console.warn(`${use.logTag} budget spent document=${ctx.documentId} max=${ctx.maxPages}: ${ready.length - allowed} pages are not sent`);
    ready.length = allowed;
  }
  // Reserved now, before any await: concurrent calls for the same document can never pass the budget together. Pages
  // reserved but never sent (a cap or the ledger stopped the loop) stay counted (fail closed).
  sent.set(ctx.documentId, used + ready.length);

  for (let start = 0; start < ready.length; start += provider.maxPagesPerJob) {
    ctx.signal?.throwIfAborted();
    const chunk = ready.slice(start, start + provider.maxPagesPerJob);
    if (isCostCapExceeded(ctx.state as WorkflowState)) {
      bump(summary.skipped, "cost-cap", ready.length - start);
      console.warn(`${use.logTag} stopped document=${ctx.documentId}: run cost cap reached`);
      release(sent, ctx.documentId, ready.length - start);
      break;
    }
    // The organization's daily reader spend, fleet-wide: admitted atomically with this job's reservation, or not sent.
    const admission = await admitJob(provider, ctx, run.orgId, chunk.length, use);
    if ("skip" in admission) {
      bump(summary.skipped, admission.skip, ready.length - start);
      // Never sent: the pages go back to the document's budget (a later batch may send them once the cap allows).
      release(sent, ctx.documentId, ready.length - start);
      break;
    }
    const { ticket, reservedCents } = admission;
    let jobCostCents = 0;
    // A job that throws may have run a VM it could not report (a lease that failed while booting, an abort): it keeps at
    // least its reservation, so cancelling jobs never releases spend the ledger did not see.
    let jobFailed = true;
    try {
      const byKey = new Map<string, PageImageInput>();
      const job: PageImageReadJob = { scope: { ...scope }, pages: [], ...(use.requireReady ? { requireReady: true } : {}) };
      for (const page of chunk) {
        const key = randomUUID();
        byKey.set(key, page);
        job.pages.push({ key, imagePath: page.imagePath });
      }
      summary.attempted += chunk.length;
      summary.jobs += 1;
      let response: { results: PageImageReadResult[]; usage: UsageEvent[] };
      try {
        response = await provider.read(job, ctx.signal);
      } catch (error) {
        const tokens = recordProviderUsage(pageReaderUsageOf(error), provider, ctx, use.metric, { pages: chunk.length, outcome: "failed" });
        jobCostCents += tokens.costCents;
        logAiUsage(provider, tokens, summary, use.metric);
        if (ctx.signal?.aborted) throw error;
        const reason = jobFailureReason(error);
        bump(summary.failed, reason, chunk.length);
        console.warn(`${use.logTag} job failed document=${ctx.documentId} pages=${chunk.map((page) => page.pageNumber).join(",")} reason=${reason}: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
        continue;
      }
      const usage = (response as { usage?: unknown } | null)?.usage;
      let results: Map<string, PageImageReadResult>;
      try {
        results = validatePageReadResults((response as { results?: unknown } | null)?.results, new Set(byKey.keys()), provider.maxMarkdownBytes);
      } catch (error) {
        const tokens = recordProviderUsage(usage, provider, ctx, use.metric, { pages: chunk.length, outcome: "failed" });
        jobCostCents += tokens.costCents;
        logAiUsage(provider, tokens, summary, use.metric);
        bump(summary.failed, "invalid-response", chunk.length);
        // Raw details go to telemetry only; the pages keep the caller's fallback.
        console.error(`${use.logTag} response rejected document=${ctx.documentId} provider=${provider.id}: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
        continue;
      }
      let tokens = recordProviderUsage(usage, provider, ctx, use.metric, { pages: chunk.length, outcome: "completed" });
      jobCostCents += tokens.costCents;
      jobFailed = false;
      if (!tokens.inputTokens && !tokens.outputTokens) {
        for (const result of results.values()) {
          if (result.status !== "read") continue;
          tokens = { ...tokens, inputTokens: tokens.inputTokens + (result.inputTokens ?? 0), outputTokens: tokens.outputTokens + (result.outputTokens ?? 0) };
        }
      }
      logAiUsage(provider, tokens, summary, use.metric);
      for (const [key, page] of byKey) {
        const result = results.get(key);
        if (!result) { bump(summary.failed, "missing"); continue; }
        if (result.status === "failed") { bump(summary.failed, result.reason); continue; }
        const text = stripControlCharacters(result.markdown).trim();
        if (!text) { summary.empty += 1; continue; }
        use.onRead(page, { text, inputTokens: result.inputTokens ?? 0, outputTokens: result.outputTokens ?? 0 });
        // One Rich page, once per run: an earlier read of the page (the recogniser's) usually charged it already (the
        // ledger dedups); a page nothing else read is charged now that it has text.
        ctx.state.usageLedger.chargeRichPage({ documentId: ctx.documentId, pageNumber: page.pageNumber, readBy: use.metric, model: provider.model });
        summary.replaced += 1;
      }
    } finally {
      await settleJob(ctx, ticket, jobFailed ? Math.max(reservedCents, jobCostCents) : jobCostCents, use);
    }
  }
  return logSummary(summary, ctx, use);
}

const OCR_READ_USE = { metric: OCR_PAGE_READER_METRIC, logTag: "[ocr] page-reader" } as const;

/**
 * Read the outcome's candidate pages (each OCR'd page with a kept boundary PNG) with `provider`, replacing a page's text
 * (in `outcome.pages`) when the reader returned Markdown. Replaced pages leave hosted escalation candidacy; every other
 * page is left as the recogniser read it.
 */
export async function readPagesWithProvider(outcome: OcrReadOutcome, provider: PageImageReaderProvider, ctx: PageReaderContext, options: { requireReady?: boolean } = {}): Promise<PageReaderSummary> {
  const byInput = new Map<PageImageInput, OcrPageRead>();
  const inputs: PageImageInput[] = [];
  for (const page of outcome.pages) {
    if (!page.image) continue;
    const input: PageImageInput = { pageNumber: page.pageNumber, imagePath: page.image.imagePath, expect: { width: page.image.width, height: page.image.height } };
    byInput.set(input, page);
    inputs.push(input);
  }
  return await readPageImagesWithProvider(inputs, provider, ctx, {
    ...OCR_READ_USE,
    ...(options.requireReady ? { requireReady: true } : {}),
    onRead(input, read) {
      const page = byInput.get(input)!;
      page.text = read.text;
      page.recogniser = `page-reader:${provider.id}`;
      // Read by the reader: the hosted escalation reader does not read it again.
      page.escalation = null;
    },
  });
}

/**
 * Admit one job against its organization's daily reader spend. Returns its ticket, or the skip reason: `org-daily-cost-cap`
 * when the day's committed cost plus this job's reservation would pass the cap, `budget-ledger-unavailable` when the ledger
 * cannot answer (fail closed: no answer, no job).
 */
async function admitJob(provider: PageImageReaderProvider, ctx: PageReaderContext, orgId: string, pages: number, use: Pick<PageImageReadUse, "logTag" | "requireCostEstimate">): Promise<{ ticket: string; reservedCents: number } | { skip: "org-daily-cost-cap" | "budget-ledger-unavailable" | "no-cost-estimate" }> {
  const budget = ctx.state.pageReaderBudget === undefined ? processPageReaderOrgBudget : ctx.state.pageReaderBudget;
  if (!budget) {
    console.error(`${use.logTag} stopped document=${ctx.documentId}: no organization spend ledger`);
    return { skip: "budget-ledger-unavailable" };
  }
  const capCents = ctx.orgDailyMaxCostCents ?? ocrPageReaderOrgDailyMaxCostCents();
  let reserveCents = 0;
  try {
    const estimate = provider.estimateJobCostCents?.(pages);
    reserveCents = typeof estimate === "number" && Number.isFinite(estimate) && estimate > 0 ? estimate : 0;
  } catch (error) {
    console.warn(`${use.logTag} cost estimate failed provider=${provider.id}: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`);
  }
  // A reader whose route must reserve (vision) never sends a job it cannot bound: no estimate, 0 or NaN refuses.
  // Below the ledger's 0.0001-cent resolution a reservation is stored as 0: that is no estimate either.
  if (use.requireCostEstimate && !(reserveCents >= 0.0001)) {
    console.error(`${use.logTag} stopped document=${ctx.documentId}: provider=${provider.id} gave no positive cost estimate to reserve`);
    return { skip: "no-cost-estimate" };
  }
  try {
    const admission = await budget.admit({ orgId, reserveCents, capCents });
    if (admission.admitted) return { ticket: admission.ticket, reservedCents: reserveCents };
    console.warn(
      `${use.logTag} stopped document=${ctx.documentId}: organization reader cost today ${admission.committedCents.toFixed(2)} cents ` +
        `plus this job's ${reserveCents.toFixed(2)} reaches the daily cap ${capCents}`,
    );
    return { skip: "org-daily-cost-cap" };
  } catch (error) {
    console.error(`${use.logTag} stopped document=${ctx.documentId}: organization spend ledger failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
    return { skip: "budget-ledger-unavailable" };
  }
}

/** Settle a job's ticket with the cost it recorded. A failure leaves the reservation standing for the day (fail closed). */
async function settleJob(ctx: PageReaderContext, ticket: string, costCents: number, use: Pick<PageImageReadUse, "logTag">): Promise<void> {
  const budget = ctx.state.pageReaderBudget === undefined ? processPageReaderOrgBudget : ctx.state.pageReaderBudget;
  try {
    await budget?.settle(ticket, costCents);
  } catch (error) {
    console.error(`${use.logTag} spend settle failed document=${ctx.documentId}; the reservation stands: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
  }
}

function logAiUsage(provider: PageImageReaderProvider, tokens: { inputTokens: number; outputTokens: number }, summary: PageReaderSummary, metric: string): void {
  summary.inputTokens += tokens.inputTokens;
  summary.outputTokens += tokens.outputTokens;
  console.log(`[ai-usage] ${metric} model=${provider.model} input_tokens=${tokens.inputTokens} output_tokens=${tokens.outputTokens}`);
}

function logSummary(summary: PageReaderSummary, ctx: PageReaderContext, use: Pick<PageImageReadUse, "logTag">): PageReaderSummary {
  console.log(
    `${use.logTag} document=${ctx.documentId} mode=${summary.mode} provider=${summary.provider} jobs=${summary.jobs} attempted=${summary.attempted} ` +
      `replaced=${summary.replaced} empty=${summary.empty} failed=${JSON.stringify(summary.failed)} skipped=${JSON.stringify(summary.skipped)}`,
  );
  return summary;
}

/** The reader may read this run's pages under its privacy mode; an unknown pipeline counts as restricted (fail closed). */
function readerAllowedForRun(provider: PageImageReaderProvider, run: PageReaderContext["state"]["run"]): boolean {
  const pipeline = run?.pipeline as { privacyMode?: string | null } | undefined;
  return pageReaderAllowedForPrivacy(provider, pipeline ? (pipeline.privacyMode ?? "standard") : "unknown");
}

/** Run the configured reader over an OCR outcome, when DOCSLURP_OCR_PAGE_READER is on; null when off. */
export async function readOcrPagesWithConfiguredReader(
  outcome: OcrReadOutcome,
  ctx: Omit<PageReaderContext, "mode" | "maxPages">,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PageReaderSummary | null> {
  const mode = ocrPageReaderMode(env);
  if (mode === "off") return null;
  const provider = pageImageReaderProvider();
  if (!provider) {
    // Startup refuses this configuration; a worker that got here anyway keeps the recogniser's reads (never another reader).
    console.error(`[ocr] page-reader mode=${mode} has no provider; document=${ctx.documentId} keeps the recogniser read`);
    return null;
  }
  // Checked before any warm gate, so a restricted project never starts a reader VM (Q14).
  if (!readerAllowedForRun(provider, ctx.state.run)) {
    console.warn(`[ocr] page-reader skipped document=${ctx.documentId}: the project's privacy mode admits only a registered private reader`);
    return null;
  }
  try {
    const readerCtx = { ...ctx, mode, maxPages: ocrPageReaderMaxPages(env), orgDailyMaxCostCents: ocrPageReaderOrgDailyMaxCostCents(env) };
    const warm = pageReaderWarmPolicy(provider, env);
    if (!warm) return await readPagesWithProvider(outcome, provider, readerCtx);
    return await readOcrPagesWarm(outcome, provider, readerCtx, warm.minPages);
  } catch (error) {
    // The reader never fails a page or document: anything it throws (a ledger write, a file check) is telemetry, and the
    // pages keep the recogniser's text (or a reader text already validated and applied). Only an abort propagates.
    if (ctx.signal?.aborted) throw error;
    console.error(`[ocr] page-reader error document=${ctx.documentId}; pages keep their reads: ${(error instanceof Error ? error.stack ?? error.message : String(error)).slice(0, 600)}`);
    return null;
  }
}

/**
 * Warm start (page-reader-warm.ts): the outcome's candidate pages go to the reader only when the run's reader is ready in
 * this process. Otherwise they keep the recogniser's text and stay hosted escalation candidates, and the run's demand may
 * start a reader for its later pages. Nothing here waits for a reader to boot.
 */
async function readOcrPagesWarm(outcome: OcrReadOutcome, provider: PageImageReaderProvider, ctx: PageReaderContext, minPages: number): Promise<PageReaderSummary> {
  const candidates = outcome.pages.filter((page) => page.image).length;
  const run = ctx.state.run;
  const summary: PageReaderSummary = { mode: ctx.mode, provider: provider.id, attempted: 0, replaced: 0, empty: 0, failed: {}, skipped: {}, jobs: 0, inputTokens: 0, outputTokens: 0 };
  if (!candidates || !run?.id || typeof run.orgId !== "string" || !run.orgId) return await readPagesWithProvider(outcome, provider, ctx, { requireReady: true });
  const scope = { orgId: run.orgId, runId: run.id };
  const gate = await pageReaderWarmGate(provider, {
    state: ctx.state, logTag: OCR_READ_USE.logTag, minPages, orgDailyMaxCostCents: ctx.orgDailyMaxCostCents ?? ocrPageReaderOrgDailyMaxCostCents(),
  }, candidates);
  let result = summary;
  if (gate === "ready") {
    result = await readPagesWithProvider(outcome, provider, ctx, { requireReady: true });
    // A job the reader answered ran on the warmed VM and recorded its boot: the start-up reservation goes back.
    if (result.replaced + result.empty > 0) await releasePageReaderWarmReservation(scope);
    recordPageReaderWarmRouting(scope, "reader", result.replaced);
    // Sent but not read (a failed job, a VM gone between the check and the job): the recogniser's text and escalation.
    recordPageReaderWarmRouting(scope, "hostedUnavailable", candidates - result.replaced);
  } else {
    bump(summary.skipped, gate === "warming" ? "reader-warming" : gate === "below-threshold" ? "reader-below-threshold" : "reader-unavailable", candidates);
    recordPageReaderWarmRouting(scope, gate === "warming" ? "hostedWhileWarming" : gate === "below-threshold" ? "hostedBelowThreshold" : "hostedUnavailable", candidates);
    logSummary(summary, ctx, OCR_READ_USE);
  }
  logPageReaderWarmSummary(scope, "ocr", ctx.documentId, OCR_READ_USE.logTag);
  return result;
}

/**
 * Whether the organization can still admit a reader job today (DOCSLURP_OCR_PAGE_READER_ORG_DAILY_MAX_COST_CENTS), for
 * planning only: false when the day's committed spend has reached the cap or the ledger cannot answer (fail closed).
 * Admission (admitJob) stays the authority; this only decides whether pages are held back for the reader.
 */
export async function pageReaderOrgHasHeadroom(state: PageReaderContext["state"], orgId: string, capCents: number): Promise<boolean> {
  const budget = state.pageReaderBudget === undefined ? processPageReaderOrgBudget : state.pageReaderBudget;
  if (!budget || capCents <= 0) return false;
  try {
    return (await budget.committedCents(orgId)) < capCents;
  } catch {
    return false;
  }
}

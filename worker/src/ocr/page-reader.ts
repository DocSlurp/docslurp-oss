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
import { ocrPageReaderMaxPages, ocrPageReaderMode, OCR_PAGE_READER_METRIC, type OcrPageReaderMode } from "./page-reader-mode.js";

export * from "./page-reader-mode.js";

export interface PageReaderSummary {
  mode: Exclude<OcrPageReaderMode, "off">;
  provider: string;
  /** Pages sent to the provider. */
  attempted: number;
  /** Pages whose text the reader replaced. */
  replaced: number;
  /** Pages the reader answered with no text (the recogniser's read stands). */
  empty: number;
  /** Pages sent but not read, by reason (provider failures, `job-failed`, `job-refused`, `invalid-response`, `missing`). */
  failed: Record<string, number>;
  /** Candidate pages never sent, by reason (`no-scope`, `budget`, `cost-cap`, `image-refused`). */
  skipped: Record<string, number>;
  jobs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface PageReaderContext {
  state: Pick<WorkflowState, "usageLedger"> & { run?: Pick<WorkflowState["run"], "id" | "orgId" | "projectId" | "spentCents" | "pipeline"> };
  documentId: string;
  mode: Exclude<OcrPageReaderMode, "off">;
  maxPages: number;
  signal?: AbortSignal;
}

/**
 * Pages of each document the reader has been sent in this worker, per run state (the per-document budget across the
 * document's OCR batches). Keyed by the run's usage ledger, so it lives exactly as long as the activity's state.
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
  details: { pages: number; outcome: "completed" | "failed" },
): { inputTokens: number; outputTokens: number } {
  const totals = { inputTokens: 0, outputTokens: 0 };
  if (!Array.isArray(events)) return totals;
  const run = ctx.state.run!;
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as Partial<UsageEvent>;
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);
    const inputTokens = Math.floor(number(event.inputTokens));
    const outputTokens = Math.floor(number(event.outputTokens));
    const costCents = number(event.costCents);
    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    const priced = priceAiUsageEvent({
      provider: typeof event.provider === "string" && SAFE_LABEL.test(event.provider) ? event.provider : `page-reader:${provider.id}`,
      model: provider.model,
      metric: OCR_PAGE_READER_METRIC,
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
        purpose: OCR_PAGE_READER_METRIC,
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

/** Which pages of `outcome` the reader should read, in page order. */
function candidatePages(outcome: OcrReadOutcome): OcrPageRead[] {
  return outcome.pages.filter((page) => page.image);
}

/**
 * Read the outcome's candidate pages with `provider`, replacing a page's text (in `outcome.pages`) when the reader returned
 * Markdown. Replaced pages leave hosted escalation candidacy; every other page is left as the recogniser read it.
 */
export async function readPagesWithProvider(outcome: OcrReadOutcome, provider: PageImageReaderProvider, ctx: PageReaderContext): Promise<PageReaderSummary> {
  const summary: PageReaderSummary = {
    mode: ctx.mode, provider: provider.id, attempted: 0, replaced: 0, empty: 0, failed: {}, skipped: {}, jobs: 0, inputTokens: 0, outputTokens: 0,
  };
  const candidates = candidatePages(outcome);
  if (!candidates.length) return summary;
  const run = ctx.state.run;
  // Never a call without an explicit tenant scope: the provider binds its VM to this organization.
  if (!run?.id || typeof run.orgId !== "string" || !run.orgId) {
    bump(summary.skipped, "no-scope", candidates.length);
    console.error(`[ocr] page-reader skipped document=${ctx.documentId} pages=${candidates.length}: the run has no organization scope`);
    return logSummary(summary, ctx);
  }
  const scope = { orgId: run.orgId, runId: run.id };
  let sent = pagesSent.get(ctx.state.usageLedger);
  if (!sent) pagesSent.set(ctx.state.usageLedger, (sent = new Map()));

  const ready: Array<{ page: OcrPageRead; imagePath: string }> = [];
  for (const page of candidates) {
    const image = page.image!;
    // Re-checked here against the provider's own cap: the PNG the boundary wrote, still that PNG, never decoded.
    const png = await checkedPng(image.imagePath, provider.maxImageBytes);
    if (!png || png.width !== image.width || png.height !== image.height) {
      bump(summary.skipped, "image-refused");
      console.warn(`[ocr] page-reader image refused document=${ctx.documentId} page=${page.pageNumber}: not the boundary's PNG or over ${provider.maxImageBytes} bytes`);
      continue;
    }
    ready.push({ page, imagePath: image.imagePath });
  }
  const used = sent.get(ctx.documentId) ?? 0;
  const allowed = Math.max(0, ctx.maxPages - used);
  if (ready.length > allowed) {
    bump(summary.skipped, "budget", ready.length - allowed);
    console.warn(`[ocr] page-reader budget spent document=${ctx.documentId} max=${ctx.maxPages}: ${ready.length - allowed} pages keep the recogniser read`);
    ready.length = allowed;
  }

  for (let start = 0; start < ready.length; start += provider.maxPagesPerJob) {
    ctx.signal?.throwIfAborted();
    const chunk = ready.slice(start, start + provider.maxPagesPerJob);
    if (isCostCapExceeded(ctx.state as WorkflowState)) {
      bump(summary.skipped, "cost-cap", ready.length - start);
      console.warn(`[ocr] page-reader stopped document=${ctx.documentId}: run cost cap reached`);
      break;
    }
    const byKey = new Map<string, OcrPageRead>();
    const job: PageImageReadJob = { scope: { ...scope }, pages: [] };
    for (const item of chunk) {
      const key = randomUUID();
      byKey.set(key, item.page);
      job.pages.push({ key, imagePath: item.imagePath });
    }
    sent.set(ctx.documentId, (sent.get(ctx.documentId) ?? 0) + chunk.length);
    summary.attempted += chunk.length;
    summary.jobs += 1;
    let response: { results: PageImageReadResult[]; usage: UsageEvent[] };
    try {
      response = await provider.read(job, ctx.signal);
    } catch (error) {
      const tokens = recordProviderUsage(pageReaderUsageOf(error), provider, ctx, { pages: chunk.length, outcome: "failed" });
      logAiUsage(provider, tokens, summary);
      if (ctx.signal?.aborted) throw error;
      const reason = jobFailureReason(error);
      bump(summary.failed, reason, chunk.length);
      console.warn(`[ocr] page-reader job failed document=${ctx.documentId} pages=${chunk.map((item) => item.page.pageNumber).join(",")} reason=${reason}: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
      continue;
    }
    const usage = (response as { usage?: unknown } | null)?.usage;
    let results: Map<string, PageImageReadResult>;
    try {
      results = validatePageReadResults((response as { results?: unknown } | null)?.results, new Set(byKey.keys()), provider.maxMarkdownBytes);
    } catch (error) {
      const tokens = recordProviderUsage(usage, provider, ctx, { pages: chunk.length, outcome: "failed" });
      logAiUsage(provider, tokens, summary);
      bump(summary.failed, "invalid-response", chunk.length);
      // Raw details go to telemetry only; the pages keep the recogniser's text.
      console.error(`[ocr] page-reader response rejected document=${ctx.documentId} provider=${provider.id}: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
      continue;
    }
    let tokens = recordProviderUsage(usage, provider, ctx, { pages: chunk.length, outcome: "completed" });
    if (!tokens.inputTokens && !tokens.outputTokens) {
      for (const result of results.values()) {
        if (result.status !== "read") continue;
        tokens = { inputTokens: tokens.inputTokens + (result.inputTokens ?? 0), outputTokens: tokens.outputTokens + (result.outputTokens ?? 0) };
      }
    }
    logAiUsage(provider, tokens, summary);
    for (const [key, page] of byKey) {
      const result = results.get(key);
      if (!result) { bump(summary.failed, "missing"); continue; }
      if (result.status === "failed") { bump(summary.failed, result.reason); continue; }
      const text = result.markdown.trim();
      if (!text) { summary.empty += 1; continue; }
      page.text = text;
      page.recogniser = `page-reader:${provider.id}`;
      // Read by the reader: the hosted escalation reader does not read it again.
      page.escalation = null;
      // One Rich page, once per run: the recogniser's read usually charged it already (the ledger dedups); a PDF page the
      // recogniser found no words on is charged now that it has text.
      ctx.state.usageLedger.chargeRichPage({ documentId: ctx.documentId, pageNumber: page.pageNumber, readBy: OCR_PAGE_READER_METRIC, model: provider.model });
      summary.replaced += 1;
    }
  }
  return logSummary(summary, ctx);
}

function logAiUsage(provider: PageImageReaderProvider, tokens: { inputTokens: number; outputTokens: number }, summary: PageReaderSummary): void {
  summary.inputTokens += tokens.inputTokens;
  summary.outputTokens += tokens.outputTokens;
  console.log(`[ai-usage] ${OCR_PAGE_READER_METRIC} model=${provider.model} input_tokens=${tokens.inputTokens} output_tokens=${tokens.outputTokens}`);
}

function logSummary(summary: PageReaderSummary, ctx: PageReaderContext): PageReaderSummary {
  console.log(
    `[ocr] page-reader document=${ctx.documentId} mode=${summary.mode} provider=${summary.provider} jobs=${summary.jobs} attempted=${summary.attempted} ` +
      `replaced=${summary.replaced} empty=${summary.empty} failed=${JSON.stringify(summary.failed)} skipped=${JSON.stringify(summary.skipped)}`,
  );
  return summary;
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
  return await readPagesWithProvider(outcome, provider, { ...ctx, mode, maxPages: ocrPageReaderMaxPages(env) });
}

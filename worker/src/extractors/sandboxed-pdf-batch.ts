/*
 * Sandboxed PDF batch: many PDFs of one run converted in one isolated VM job, each file's result streamed back as soon as
 * it is ready (the first pass, docs/extraction/extractor-plugins.md "Sandboxed PDF batch").
 *
 * Rules the host enforces here, before and after the provider runs:
 * - One run, so one organization, per batch. A batch that mixes runs or organizations is refused before any VM work
 *   (assertSingleScopeBatch); providers refuse it again.
 * - Provider events are untrusted. Each one is validated against the job (acceptSandboxedPdfBatchEvent): a known file index,
 *   at most one text result per file, figures only after that file's text, page counts within bounds, and the text result
 *   itself through acceptSandboxedPdfResult. A malformed event fails the batch, never another file's document.
 * - A failed file fails only itself. Its reason is a fixed slug; nothing from the document crosses into it.
 */
import { SandboxRunError } from "../sandbox/types.js";
import type { UsageEvent } from "../models.js";
import {
  acceptSandboxedPdfResult, sandboxedPdfProvider, type SandboxedPdfFigureOutcome, type SandboxedPdfJob, type SandboxedPdfResult,
} from "./plugins.js";

/** One PDF of a batch. Paths are absolute and distinct; `documentId` stays on the host and never reaches the VM. */
export interface SandboxedPdfBatchFile {
  /** Position in `files`, 0-based; events name files by it. */
  index: number;
  documentId: string;
  /** The staged source. */
  input: string;
  /** Where the provider writes the file's Markdown (pages joined by form feeds, one slot per page). */
  output: string;
  /** Source size in bytes, as the host staged it. */
  bytes: number;
  /** Intake's page estimate: sizes the batch only, never bills. The measured count arrives on the text event. */
  estimatedPages: number;
  /** An empty folder the host created for this file's figures, when the job asks for figures. */
  figures?: { dir: string };
}

export interface SandboxedPdfBatchOptions {
  /** Read typeset math as LaTeX (the project asked for it). */
  math: boolean;
  /** Extract figures into each file's `figures.dir` after its text. */
  figures: boolean;
}

export interface SandboxedPdfBatchJob {
  scope: { orgId: string; runId: string };
  files: SandboxedPdfBatchFile[];
  options: SandboxedPdfBatchOptions;
}

/** Why one file of a batch has no result. Fixed slugs only. */
export const SANDBOXED_PDF_BATCH_FAILURES = ["page-count", "timeout", "parser", "oversized", "vm-lost", "invalid"] as const;
export type SandboxedPdfBatchFailure = (typeof SANDBOXED_PDF_BATCH_FAILURES)[number];

export type SandboxedPdfBatchEvent =
  /**
   * The file's Markdown is written to its `output`; `pages` is the structural count the VM measured (what bills and is
   * authorized). `processedPages`, when the converter read fewer pages than that (1..pages-1), is the number of page slots in
   * the Markdown; the host flags the document partially extracted, as for a single-file run.
   */
  | { index: number; phase: "text"; pages: number; processedPages?: number; result: SandboxedPdfResult }
  /** The file's figures (only when the job asked for them), after its text. `extracted`: `figures.dir` holds them. */
  | { index: number; phase: "figures"; figures: SandboxedPdfFigureOutcome }
  | { index: number; phase: "failed"; reason: SandboxedPdfBatchFailure; pageCountOutcome?: string };

export interface SandboxedPdfBatchProvider {
  /** Upper bounds of one batch; the planner never exceeds them (a single larger file runs alone). */
  maxFiles: number;
  maxBatchBytes: number;
  maxBatchPages: number;
  /**
   * Convert every file, calling `onEvent` as each result is ready (awaited: the provider must not run ahead of the host's
   * handling by more than its own buffering). Resolves with the provider cost of every VM it ran, including retries; throws
   * only when the batch as a whole could not run (no VM, aborted). Files it could not finish get a `failed` event.
   *
   * A rejection from `onEvent` is the host refusing the batch (a credit refusal, a failed page-count write, a malformed
   * event): the provider stops every VM of the batch, starts no retry VM, emits no further event and rejects with that same
   * error object (never a wrapped or swallowed one). Every rejection carries the cost of every VM the batch ran, as
   * `batchUsage` (BATCH_USAGE_PROPERTY, read with batchUsageOf), so the host can bill what was spent on any exit.
   */
  run(job: SandboxedPdfBatchJob, onEvent: (event: SandboxedPdfBatchEvent) => Promise<void>, signal?: AbortSignal): Promise<{ usage: UsageEvent[] }>;
}

export const MAX_BATCH_DOCUMENT_PAGES = 100_000;

/** The property a provider's rejection carries its incurred VM usage on (SandboxedPdfBatchProvider.run). */
export const BATCH_USAGE_PROPERTY = "batchUsage";

/** The VM usage a batch rejection carries (validated shape; never throws). */
export function batchUsageOf(error: unknown): UsageEvent[] {
  if (!error || (typeof error !== "object" && typeof error !== "function")) return [];
  const raw = (error as Record<string, unknown>)[BATCH_USAGE_PROPERTY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((event): event is UsageEvent => !!event && typeof event === "object" && typeof (event as { metric?: unknown }).metric === "string");
}

/** The registered provider's batch capability, or null when it has none. */
export function sandboxedPdfBatchProvider(): SandboxedPdfBatchProvider | null {
  return sandboxedPdfProvider()?.batch ?? null;
}

export function validBatchProvider(batch: Partial<SandboxedPdfBatchProvider> | undefined): boolean {
  if (!batch) return false;
  return typeof batch.run === "function"
    && [batch.maxFiles, batch.maxBatchBytes, batch.maxBatchPages].every((n) => Number.isSafeInteger(n) && (n as number) >= 1);
}

/**
 * Refuse a batch whose files do not all belong to the job's run and organization, or whose files are malformed. `documents`
 * is what the host's database says about each document id: never the provider, never the request.
 */
export function assertSingleScopeBatch(
  job: SandboxedPdfBatchJob,
  documents: ReadonlyMap<string, { orgId: string | null; runId: string }>,
): void {
  if (!job.scope?.orgId || !job.scope?.runId) throw new Error("Batch needs an organization and run scope");
  if (!Array.isArray(job.files) || job.files.length < 1) throw new Error("Batch has no files");
  const ids = new Set<string>();
  const paths = new Set<string>();
  job.files.forEach((file, position) => {
    if (file.index !== position) throw new Error("Batch file indexes must be 0..n-1 in order");
    if (ids.has(file.documentId)) throw new Error("Batch lists a document twice");
    ids.add(file.documentId);
    for (const p of [file.input, file.output, file.figures?.dir]) {
      if (p === undefined) continue;
      if (!p.startsWith("/") || paths.has(p)) throw new Error("Batch paths must be absolute and distinct");
      paths.add(p);
    }
    if (!!file.figures !== job.options.figures) throw new Error("Batch figure folders must match the figures option");
    const owner = documents.get(file.documentId);
    if (!owner || owner.orgId !== job.scope.orgId || owner.runId !== job.scope.runId) {
      throw new Error("Batch mixes organizations or runs");
    }
  });
}

/** Per-job record of what each file has reported, for event ordering. */
const progress = new WeakMap<SandboxedPdfBatchJob, Map<number, "text" | "figures" | "failed">>();
const textJobs = new WeakMap<SandboxedPdfBatchJob, Map<number, SandboxedPdfJob>>();

/** The SandboxedPdfJob a batch file's text result was validated against (for layout facts, OCR pages and figures). */
export function batchFileJob(job: SandboxedPdfBatchJob, index: number): SandboxedPdfJob | undefined {
  return textJobs.get(job)?.get(index);
}

/**
 * Validate one provider event against the job. Throws SandboxRunError on anything out of order or out of bounds; returns
 * the event with its text result accepted (layout facts and OCR pages parsed as for a single-file run).
 */
export function acceptSandboxedPdfBatchEvent(job: SandboxedPdfBatchJob, raw: unknown): SandboxedPdfBatchEvent {
  const event = raw as Partial<SandboxedPdfBatchEvent> & Record<string, unknown> | null;
  const fail = (why: string): never => { throw new SandboxRunError(`Sandboxed PDF batch event refused: ${why}`); };
  if (!event || typeof event !== "object") fail("not an object");
  const index = event!.index;
  if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= job.files.length) fail("unknown file index");
  const file = job.files[index as number]!;
  const seen = progress.get(job) ?? new Map<number, "text" | "figures" | "failed">();
  progress.set(job, seen);
  const before = seen.get(index as number);
  if (before === "failed" || before === "figures") fail("event after the file finished");
  switch (event!.phase) {
    case "text": {
      if (before) fail("second text result");
      const pages = (event as { pages?: unknown }).pages;
      if (typeof pages !== "number" || !Number.isSafeInteger(pages) || pages < 1 || pages > MAX_BATCH_DOCUMENT_PAGES) fail("page count out of bounds");
      const processed = (event as { processedPages?: unknown }).processedPages;
      if (processed !== undefined && (typeof processed !== "number" || !Number.isSafeInteger(processed) || processed < 1 || processed >= (pages as number))) {
        fail("processed pages out of bounds");
      }
      const result = (event as { result?: unknown }).result as SandboxedPdfResult | undefined;
      if (!result || typeof result !== "object") fail("text without a result");
      // Figures arrive on their own event; the text result never carries them.
      if (result!.figures !== undefined) fail("figures on a text result");
      const single: SandboxedPdfJob = { input: file.input, output: file.output };
      const slots = (processed as number | undefined) ?? (pages as number);
      const accepted = acceptSandboxedPdfResult(single, result!, slots);
      const jobs = textJobs.get(job) ?? new Map<number, SandboxedPdfJob>();
      textJobs.set(job, jobs);
      jobs.set(index as number, single);
      seen.set(index as number, job.options.figures ? "text" : "figures");
      return { index: index as number, phase: "text", pages: pages as number, ...(processed === undefined ? {} : { processedPages: processed as number }), result: accepted };
    }
    case "figures": {
      if (!job.options.figures) fail("figures were not requested");
      if (before !== "text") fail("figures before text");
      const figures = (event as { figures?: { status?: unknown; reason?: unknown; confined?: unknown } }).figures;
      const confined = typeof figures?.confined === "boolean" ? { confined: figures.confined } : {};
      seen.set(index as number, "figures");
      if (figures?.status === "extracted") return { index: index as number, phase: "figures", figures: { status: "extracted", ...confined } };
      // eslint-disable-next-line no-control-regex
      const reason = typeof figures?.reason === "string" ? figures.reason.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 200) : "";
      return { index: index as number, phase: "figures", figures: { status: "failed", reason: reason || "unspecified", ...confined } };
    }
    case "failed": {
      // A file may fail after its text (its figures never came): the text stands, the figures count as failed.
      const reason = (event as { reason?: unknown }).reason;
      if (!SANDBOXED_PDF_BATCH_FAILURES.includes(reason as SandboxedPdfBatchFailure)) fail("unknown failure reason");
      const outcome = (event as { pageCountOutcome?: unknown }).pageCountOutcome;
      seen.set(index as number, "failed");
      return {
        index: index as number, phase: "failed", reason: reason as SandboxedPdfBatchFailure,
        ...(typeof outcome === "string" && /^[a-z-]{1,32}$/.test(outcome) ? { pageCountOutcome: outcome } : {}),
      };
    }
    default:
      return fail("unknown phase");
  }
}

/** Files of the job that never reported text (or failed): what a caller must fail or retry after the provider returns. */
export function unfinishedBatchFiles(job: SandboxedPdfBatchJob): SandboxedPdfBatchFile[] {
  const seen = progress.get(job);
  return job.files.filter((file) => !seen?.has(file.index));
}

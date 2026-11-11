/*
 * The first pass: a run's PDFs converted in sandboxed PDF batches (extractors/sandboxed-pdf-batch.ts), each document advancing
 * on its own as soon as its batch result arrives: extract-markdown (served from the batch result, no second VM), PII detection
 * when the project enables it, then embed, which writes its chunks and marks it keyword searchable. The batch's documents are
 * indexed once the batch ends. Documents the first pass does not finish, and pages that need more than the text layer, are
 * left to the run's ordinary stage loop, which follows.
 *
 * Rules:
 * - One run per batch; the database's view of every document's organization and run is checked before any VM work.
 * - The measured page count (the VM's structural count) is recorded and authorized before any stage that bills runs. A file
 *   the batch did not count is counted the ordinary way (one VM) before it is handed back, so nothing bills an estimate.
 * - Nothing becomes searchable before its publish gate passes (first-pass-gate.ts: a clean malware verdict).
 * - A failed file fails only itself (or is handed back); the batch result of one document never reaches another.
 */
import { copyFile, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { dopplerImageExtractEnabled, type PipelineFeatures } from "@docslurp/shared";
import {
  acceptSandboxedPdfBatchEvent, assertSingleScopeBatch, batchFileJob, sandboxedPdfBatchProvider, unfinishedBatchFiles,
  type SandboxedPdfBatchEvent, type SandboxedPdfBatchFile, type SandboxedPdfBatchJob, type SandboxedPdfBatchProvider,
} from "../extractors/sandboxed-pdf-batch.js";
import { sandboxedPdfLayoutFacts, sandboxedPdfProvider, type SandboxedPdfJob, type SandboxedPdfResult } from "../extractors/plugins.js";
import type { PageLayoutFacts } from "../lib/page-layout-facts.js";
import { DopplerFigureRejection, readDopplerFigureDir, storeDopplerFigures, type DopplerFigureStorage } from "../extractors/doppler-figures.js";
import { planFirstPassBatches, type FirstPassBatchLimits } from "../temporal/first-pass-batches.js";
import { sniffedPdf } from "../lib/sniffed-pdf.js";
import { trustedTempDownloadPattern } from "../lib/temp-file-names.js";
import { PdfPageCountError, recordMeasuredPdfPageCount } from "../lib/pdf-page-count.js";
import { authorizeMeasuredPages } from "../lib/measured-page-authorization.js";
import { cleanupTempFile, sourceStorageKey, type ArtifactStore } from "../tools/storage.js";
import type { Document, UsageEvent } from "../models.js";
import type { UsageSummary } from "../temporal/shared.js";
import { runDocumentStage } from "./checkpoints.js";
import { loadRunState } from "./stage-execution.js";
import type { WorkflowState } from "./pipeline.js";
import { firstPassPublishGate } from "./first-pass-gate.js";

/** Document checkpoints the first pass writes beside the ordinary stages' (which it runs as document shards). */
export const FIRST_PASS_PAGE_COUNT_STAGE = "first-pass:page-count";
export const FIRST_PASS_FIGURES_STAGE = "first-pass:figures";

/** The pipeline the first pass runs its stages with: PDFs through the sandboxed PDF route only, no vision fallback. */
export function firstPassPipeline(pipeline: PipelineFeatures): PipelineFeatures {
  return {
    ...pipeline,
    visionFallback: false,
    documentExtraction: {
      ...pipeline.documentExtraction,
      order: { ...pipeline.documentExtraction?.order, pdf: ["vm-pdf"] },
    },
  } as PipelineFeatures;
}

/** The batch options a project's pipeline asks for: math only when the project requests it, figures when the deploy has them. */
export function firstPassBatchOptions(pipeline: PipelineFeatures, env: NodeJS.ProcessEnv = process.env): SandboxedPdfBatchJob["options"] {
  const vmOptions = (pipeline.documentExtraction?.options as Record<string, { math?: unknown } | undefined> | undefined)?.["vm-pdf"];
  return {
    math: vmOptions?.math === true,
    figures: dopplerImageExtractEnabled(env) && !!sandboxedPdfProvider()?.figures,
  };
}

/** Whether a document goes through the first pass: a sniffed PDF the batch provider accepts, not already failed. */
export function firstPassCandidate(document: Pick<Document, "mimeType" | "fileFacts" | "status">, bytes: number, provider = sandboxedPdfProvider()): boolean {
  if (!provider?.batch || !sniffedPdf(document) || document.status === "failed") return false;
  return bytes <= provider.maxSourceBytes;
}

/**
 * Whether format-detect leaves this PDF's page count to the first pass (the batch measures it in the same VM). Only for a run
 * whose workflow recorded the first pass, and only for documents the first pass takes.
 */
export function firstPassDefersPageCount(state: Pick<WorkflowState, "firstPassRun">, document: Pick<Document, "mimeType" | "fileFacts" | "status">): boolean {
  return state.firstPassRun === true && !!sandboxedPdfBatchProvider() && sniffedPdf(document) && document.status !== "failed";
}

// ── Batch results, served to extract-markdown in this process ──

interface CachedResult {
  markdownPath: string;
  result: SandboxedPdfResult;
  /** Figures are stored by the first pass itself after the batch; extract-markdown never waits for them. */
}
const results = new Map<string, CachedResult>();
const key = (runId: string, documentId: string) => `${runId}\u0000${documentId}`;

/**
 * The batch result for the document extract-markdown is running, copied to the job's output, or null when there is none
 * (the provider runs as usual). Called by the command runner for every sandboxed PDF job, inside the document's context.
 */
export async function serveFirstPassResult(context: { runId?: string; documentId?: string } | undefined, job: SandboxedPdfJob): Promise<SandboxedPdfResult | null> {
  if (!context?.runId || !context.documentId) return null;
  const cached = results.get(key(context.runId, context.documentId));
  if (!cached) return null;
  // Embedded images (the older route) were never part of the batch: run the provider instead.
  if (job.embeddedImages) return null;
  await copyFile(cached.markdownPath, job.output);
  // A figure request is answered by the first pass's own figure step, never twice.
  return { ...cached.result, ...(job.figures ? { figures: { status: "failed" as const, reason: "first-pass:figures-stored-separately" } } : {}) };
}

/** Whether extract-markdown should leave figures to the first pass for this document. */
export function firstPassServesDocument(runId: string, documentId: string): boolean {
  return results.has(key(runId, documentId));
}

export function resetFirstPassResultsForTest(): void {
  results.clear();
}

// ── Planning ──

export interface FirstPassStore {
  loadRun: Parameters<typeof loadRunState>[0]["loadRun"];
  loadDocumentsForRun: Parameters<typeof loadRunState>[0]["loadDocumentsForRun"];
  hydrateState: Parameters<typeof loadRunState>[0]["hydrateState"];
  readStageStates?: Parameters<typeof loadRunState>[0]["readStageStates"];
  documentScopes(documentIds: readonly string[]): Promise<Map<string, { orgId: string | null; runId: string; bytes: number }>>;
  setDocumentPageCount(runId: string, documentId: string, pageCount: number): Promise<boolean>;
  updateProgress(state: WorkflowState): Promise<void>;
}

export interface FirstPassPlan {
  batches: string[][];
  limits: FirstPassBatchLimits | null;
}

/** The run's first-pass batches: candidates only, never another run's documents. Empty without a batch provider. */
export async function planFirstPass(store: FirstPassStore, runId: string): Promise<FirstPassPlan> {
  const provider = sandboxedPdfBatchProvider();
  if (!provider) return { batches: [], limits: null };
  const state = await loadRunState(store, runId, { hydrate: true });
  const scopes = await store.documentScopes(state.documents.map((document) => document.id));
  const candidates = state.documents.flatMap((document) => {
    const scope = scopes.get(document.id);
    if (!scope || scope.runId !== runId || scope.orgId !== state.run.orgId) return [];
    if ([...(state.documentStages.get(document.id)?.values() ?? [])].some((stage) => stage.status === "failed")) return [];
    if (state.documentStages.get(document.id)?.get("extract-markdown")?.status === "completed") return [];
    if (!firstPassCandidate(document, scope.bytes, sandboxedPdfProvider())) return [];
    return [{ documentId: document.id, pages: document.pageCount, bytes: scope.bytes }];
  });
  const limits = { maxFiles: provider.maxFiles, maxBatchBytes: provider.maxBatchBytes, maxBatchPages: provider.maxBatchPages };
  return { batches: planFirstPassBatches(candidates, limits), limits };
}

// ── One batch ──

export interface FirstPassBatchDeps {
  store: FirstPassStore;
  storage: ArtifactStore;
  quarantineEnabled: boolean;
  /** Run one ordinary stage for these documents as a shard, with the first-pass pipeline. Returns its usage. */
  runStage(stageName: string, documentIds: string[]): Promise<UsageSummary>;
  heartbeat(details: Record<string, unknown>): void;
  signal?: AbortSignal;
  /** Clock for timings (tests). */
  now?: () => number;
}

export interface FirstPassBatchResult {
  usage: UsageSummary;
  /** Documents the first pass made keyword searchable and indexed. */
  indexed: string[];
  /** Documents whose text the batch extracted but that the stage loop finishes (pages that need OCR or vision). */
  extracted: string[];
  /** Documents the batch could not convert; the stage loop takes them (or they failed their page count). */
  handedBack: Array<{ documentId: string; reason: string }>;
  timings: { firstTextMs: number | null; allTextMs: number | null; firstSearchableMs: number | null; allSearchableMs: number | null; batchMs: number; pages: number };
}

const zeroUsage = (): UsageSummary => ({ inputTokens: 0, outputTokens: 0, costCents: 0 });
const addUsage = (a: UsageSummary, b: UsageSummary): UsageSummary =>
  ({ inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, costCents: a.costCents + b.costCents });

/** Pages of a text event whose text layer is empty (validated layout facts): the stage loop reads them (OCR or vision) first. */
function textlessPages(facts: Map<number, PageLayoutFacts> | undefined, pages: number): number {
  if (!facts) return 0;
  let textless = 0;
  for (const [page, fact] of facts) if (page <= pages && fact.words === 0) textless++;
  return textless;
}

export async function runFirstPassBatch(deps: FirstPassBatchDeps, input: { runId: string; documentIds: string[] }): Promise<FirstPassBatchResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const provider = sandboxedPdfBatchProvider();
  if (!provider) throw new Error("First pass needs a sandboxed PDF batch provider");
  const state = await loadRunState(deps.store, input.runId, { hydrate: true });
  state.beginShard(input.documentIds);
  const documents = new Map(state.documents.map((document) => [document.id, document]));
  if (documents.size !== new Set(input.documentIds).size) throw new Error("First-pass batch names documents outside its run");
  const scopes = await deps.store.documentScopes(input.documentIds);
  const pipeline = state.run.pipeline;
  const options = firstPassBatchOptions(pipeline);
  const work = await mkdtemp(path.join(tmpdir(), "docslurp-first-pass-"));
  const staged: string[] = [];
  const handedBack: FirstPassBatchResult["handedBack"] = [];
  const indexed: string[] = [];
  const extracted: string[] = [];
  let usage = zeroUsage();
  const timings = { firstTextMs: null as number | null, allTextMs: null as number | null, firstSearchableMs: null as number | null, allSearchableMs: null as number | null, batchMs: 0, pages: 0 };
  const cachedKeys: string[] = [];
  try {
    const files: SandboxedPdfBatchFile[] = [];
    for (const documentId of input.documentIds) {
      const document = documents.get(documentId)!;
      const source = await deps.storage.downloadSourceToTempFile(sourceStorageKey(document.sourceKey), trustedTempDownloadPattern("docslurp-first-pass-", document), { maxBytes: provider.maxBatchBytes });
      staged.push(source);
      const dir = path.join(work, String(files.length));
      await mkdir(dir, { recursive: false });
      const figures = options.figures ? path.join(dir, "figures") : undefined;
      if (figures) await mkdir(figures);
      files.push({ index: files.length, documentId, input: source, output: path.join(dir, "output.md"), bytes: scopes.get(documentId)?.bytes ?? 0,
        estimatedPages: document.pageCount, ...(figures ? { figures: { dir: figures } } : {}) });
    }
    const job: SandboxedPdfBatchJob = { scope: { orgId: state.run.orgId ?? "", runId: input.runId }, files, options };
    // Before any VM: the database says every document is this run's and this organization's.
    assertSingleScopeBatch(job, scopes);

    // Documents advance as their results arrive, a few at a time: each drain runs the ordinary stages as one shard.
    const ready: string[] = [];
    /** Documents whose text layer misses pages: extracted now, embedded by the stage loop after OCR or vision. */
    const extractOnly = new Set<string>();
    const figureReady = new Map<string, string>();
    let draining: Promise<void> = Promise.resolve();
    let drainFailure: unknown;
    const drain = () => {
      draining = draining.then(async () => {
        if (drainFailure || ready.length === 0) return;
        const ids = ready.splice(0, ready.length);
        try {
          usage = addUsage(usage, await deps.runStage("extract-markdown", ids));
          if (pipeline.piiPolicy?.enabled) usage = addUsage(usage, await deps.runStage("pii-detect", ids));
          const fresh = await loadRunState(deps.store, input.runId, { hydrate: true });
          const publishable: string[] = [];
          for (const id of ids) {
            if (extractOnly.has(id)) continue;
            const stages = fresh.documentStages.get(id);
            if (stages?.get("extract-markdown")?.status !== "completed") continue;
            if (pipeline.piiPolicy?.enabled && stages.get("pii-detect")?.status !== "completed") continue;
            if (!(await firstPassPublishGate().awaitClean({ state: fresh, documentId: id, quarantineEnabled: deps.quarantineEnabled, signal: deps.signal }))) continue;
            publishable.push(id);
          }
          if (publishable.length) {
            usage = addUsage(usage, await deps.runStage("embed", publishable));
            const searchable = now() - started;
            timings.firstSearchableMs ??= searchable;
            timings.allSearchableMs = searchable;
            indexed.push(...publishable);
          }
        } catch (error) {
          drainFailure = error;
        }
        deps.heartbeat({ firstPass: "drained", documents: ids.length });
      });
      return draining;
    };

    const onEvent = async (raw: SandboxedPdfBatchEvent) => {
      // The text result as the provider sent it: extract-markdown accepts it again when it is served (layout facts, OCR pages).
      const sent = (raw as { phase?: unknown; result?: SandboxedPdfResult }).phase === "text" ? { ...(raw as { result: SandboxedPdfResult }).result } : undefined;
      const event = acceptSandboxedPdfBatchEvent(job, raw);
      const file = files[event.index]!;
      const document = documents.get(file.documentId)!;
      deps.heartbeat({ firstPass: event.phase, index: event.index });
      if (event.phase === "failed") {
        handedBack.push({ documentId: file.documentId, reason: event.reason });
        if (event.reason === "page-count") await refusePageCount(state, document, event.pageCountOutcome);
        return;
      }
      if (event.phase === "figures") {
        if (event.figures.status === "extracted" && file.figures) figureReady.set(file.documentId, file.figures.dir);
        return;
      }
      const textMs = now() - started;
      timings.firstTextMs ??= textMs;
      timings.allTextMs = textMs;
      timings.pages += event.pages;
      // The measured count first: recorded and authorized before anything that bills.
      await recordBatchPageCount(deps.store, state, document, event.pages);
      results.set(key(input.runId, file.documentId), { markdownPath: file.output, result: { ...event.result, ...(sent?.layoutFacts !== undefined ? { layoutFacts: sent.layoutFacts } : {}) } });
      cachedKeys.push(key(input.runId, file.documentId));
      if (textlessPages(sandboxedPdfLayoutFacts(batchFileJob(job, event.index)!), event.pages) > 0) {
        // The text layer misses pages: extract now (served from the batch), embed after the stage loop reads them.
        extracted.push(file.documentId);
        extractOnly.add(file.documentId);
      }
      ready.push(file.documentId);
      void drain();
    };

    const run = await provider.run(job, onEvent, deps.signal);
    for (const event of run.usage) state.usageLedger.enqueue(event as UsageEvent);
    await drain();
    await draining;
    if (drainFailure) throw drainFailure;

    // Files with no text: counted the ordinary way (or failed) so none bills an estimate, then left to the stage loop.
    for (const file of unfinishedBatchFiles(job)) {
      handedBack.push({ documentId: file.documentId, reason: "no-result" });
    }
    for (const { documentId, reason } of handedBack) {
      if (reason === "page-count") continue;
      const document = documents.get(documentId)!;
      const file = files.find((f) => f.documentId === documentId)!;
      await runDocumentStage(state, document, FIRST_PASS_PAGE_COUNT_STAGE, `${documentId}:${FIRST_PASS_PAGE_COUNT_STAGE}`, "page count measured", async () => {
        const measured = await recordMeasuredPdfPageCount({ state, document, runner: unusedRunner, sourcePath: async () => file.input, signal: deps.signal });
        if (measured) await authorizeMeasuredPages(state, document);
        return { stats: { pages: document.pageCount, handedBack: reason } };
      }, deps.signal);
    }

    // Figures: stored for documents whose text was extracted, never failing a document.
    for (const [documentId, dir] of figureReady) {
      const document = documents.get(documentId)!;
      if (!results.has(key(input.runId, documentId))) continue;
      const markdown = await readFile(files.find((f) => f.documentId === documentId)!.output, "utf8").catch(() => "");
      await runDocumentStage(state, document, FIRST_PASS_FIGURES_STAGE, `${documentId}:${FIRST_PASS_FIGURES_STAGE}`, "figures stored", async () => {
        try {
          const figures = await readDopplerFigureDir(dir, { pageCount: document.pageCount, signal: deps.signal });
          const stored = await storeDopplerFigures({ storage: deps.storage as unknown as DopplerFigureStorage, document, runId: input.runId, figures, markdown, signal: deps.signal });
          for (const { slot, uri } of stored.slots) state.artifactLedger.recordDocument(documentId, slot, uri);
          return { artifactUri: stored.indexUri, stats: { dopplerFigures: stored.stats } };
        } catch (error) {
          if (deps.signal?.aborted) throw error;
          const rule = error instanceof DopplerFigureRejection ? error.rule : "store-failed";
          console.warn(`[first-pass] figures document=${documentId} status=failed rule=${rule}`);
          return { stats: { dopplerFigures: { status: "failed", rule } } };
        }
      }, deps.signal);
    }

    if (indexed.length) usage = addUsage(usage, await deps.runStage("index", indexed));
    await deps.store.updateProgress(state);
    usage = addUsage(usage, state.usageLedger.totals());
    timings.batchMs = now() - started;
    console.log(`[first-pass] run=${input.runId} batch files=${files.length} pages=${timings.pages} indexed=${indexed.length} extracted=${extracted.length} ` +
      `handedBack=${handedBack.length} firstTextMs=${timings.firstTextMs} allTextMs=${timings.allTextMs} firstSearchableMs=${timings.firstSearchableMs} ` +
      `allSearchableMs=${timings.allSearchableMs} batchMs=${timings.batchMs}`);
    return { usage, indexed, extracted, handedBack, timings };
  } finally {
    for (const k of cachedKeys) results.delete(k);
    for (const source of staged) await cleanupTempFile(source).catch(() => undefined);
    await rm(work, { recursive: true, force: true });
  }
}

/** The VM route counts pages with the provider; the host runner is never used for a PDF here. */
const unusedRunner = {
  pdfPageCount: () => { throw new Error("first pass counts PDFs in the VM only"); },
  pdfPopplerAcceptance: () => { throw new Error("first pass counts PDFs in the VM only"); },
  run: () => { throw new Error("first pass counts PDFs in the VM only"); },
} as unknown as Parameters<typeof recordMeasuredPdfPageCount>[0]["runner"];

/** Record the batch's structural page count before any stage bills, then authorize pages above intake's estimate. */
async function recordBatchPageCount(store: FirstPassStore, state: WorkflowState, document: Document, pages: number): Promise<void> {
  if (document.pageCountSource === "assumed") {
    if (!(await store.setDocumentPageCount(state.run.id, document.id, pages))) throw new Error("First-pass page count could not be recorded");
    state.run.pagesTotal = Math.max(0, (Number(state.run.pagesTotal) || 0) + pages - Math.max(1, Math.trunc(document.pageCount) || 1));
    document.pageCount = pages;
    document.pageCountSource = "counted";
  }
  await authorizeMeasuredPages(state, document);
}

/** A file the VM could not count fails as format-detect would have failed it. */
async function refusePageCount(state: WorkflowState, document: Document, outcome: string | undefined): Promise<void> {
  await runDocumentStage(state, document, FIRST_PASS_PAGE_COUNT_STAGE, `${document.id}:${FIRST_PASS_PAGE_COUNT_STAGE}`, "page count refused", async () => {
    throw new PdfPageCountError(`PDF page count failed in the VM: ${outcome ?? "unavailable"}`, (outcome ?? "unavailable") as never);
  });
}

export const __test = { textlessPages, cp };

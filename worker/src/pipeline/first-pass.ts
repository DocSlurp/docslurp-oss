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
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { dopplerImageExtractEnabled, dopplerImageLimits, type PipelineFeatures } from "@docslurp/shared";
import {
  acceptSandboxedPdfBatchEvent, assertSingleScopeBatch, batchFileJob, batchUsageOf, sandboxedPdfBatchProvider, unfinishedBatchFiles,
  type SandboxedPdfBatchEvent, type SandboxedPdfBatchFile, type SandboxedPdfBatchJob, type SandboxedPdfBatchProvider,
} from "../extractors/sandboxed-pdf-batch.js";
import { markFirstPassServedFigures, sandboxedPdfLayoutFacts, sandboxedPdfProvider, type SandboxedPdfFigureOutcome, type SandboxedPdfJob, type SandboxedPdfResult } from "../extractors/plugins.js";
import type { PageLayoutFacts } from "../lib/page-layout-facts.js";
import { DopplerFigureRejection, disposeDopplerFigureSet, dopplerSourcePointer, readDopplerFigureDir, storeDopplerFigures, type DopplerFigureStorage } from "../extractors/doppler-figures.js";
import { ledgerWriteForFailedFigures, ledgerWriteForStoredFigures, queueAssetLedger } from "../db/document-asset-ledger.js";
import { planFirstPassBatches, type FirstPassBatchLimits } from "../temporal/first-pass-batches.js";
import { sniffedPdf } from "../lib/sniffed-pdf.js";
import { trustedTempDownloadPattern } from "../lib/temp-file-names.js";
import { PdfPageCountError, reconcileProcessedPdfPages, recordMeasuredPdfPageCount } from "../lib/pdf-page-count.js";
import { authorizeMeasuredPages } from "../lib/measured-page-authorization.js";
import { cleanupTempFile, keyFromStorageUri, type ArtifactStore } from "../tools/storage.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import { runWithPerfContext } from "../lib/perf-context.js";
import { stageSourceFile } from "../sandbox/source-integrity.js";
import { admitCommandSource, findQuarantinedSourceError } from "../sandbox/source-quarantine.js";
import { latchedTeardownError } from "../sandbox/session-context.js";
import { assertTeardownBreakerClosed } from "../sandbox/teardown-breaker.js";
import type { Document, UsageEvent } from "../models.js";
import type { UsageSummary } from "../temporal/shared.js";
import { firstPassCheckpointStale, runDocumentStage } from "./checkpoints.js";
import { loadRunState } from "./stage-execution.js";
import type { WorkflowState } from "./pipeline.js";
import { firstPassPublishGate } from "./first-pass-gate.js";
import { firstPassExtractionDiffers, firstPassPipeline } from "./first-pass-pipeline.js";

export { firstPassPipeline };

/** Document checkpoints the first pass writes beside the ordinary stages' (which it runs as document shards). */
export const FIRST_PASS_PAGE_COUNT_STAGE = "first-pass:page-count";
export const FIRST_PASS_FIGURES_STAGE = "first-pass:figures";

/** Groups of documents the first pass advances at once (DOCSLURP_FIRST_PASS_DRAINS, 1..16, default 4). */
export function firstPassDrainConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number.parseInt(env.DOCSLURP_FIRST_PASS_DRAINS ?? "4", 10);
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(16, value)) : 4;
}

/** The batch options a project's pipeline asks for: math only when the project requests it, figures when the deploy has them. */
export function firstPassBatchOptions(pipeline: PipelineFeatures, env: NodeJS.ProcessEnv = process.env): SandboxedPdfBatchJob["options"] {
  const vmOptions = (pipeline.documentExtraction?.options as Record<string, { math?: unknown } | undefined> | undefined)?.["vm-pdf"];
  return {
    // Math reading stays behind its own deploy flag (default off) until the open council follow-up on the math reader is
    // closed (TODO.md: bound its scan on hostile pages); the project's request alone never turns it on.
    math: vmOptions?.math === true && env.DOCSLURP_FIRST_PASS_MATH?.trim().toLowerCase() === "on",
    figures: dopplerImageExtractEnabled(env) && !!sandboxedPdfProvider()?.figures,
  };
}

/** Whether a document goes through the first pass: a sniffed PDF the batch provider accepts, not already failed. */
export function firstPassCandidate(document: Pick<Document, "mimeType" | "fileFacts" | "status" | "parseSourceDecision">, bytes: number, provider = sandboxedPdfProvider()): boolean {
  if (!provider?.batch || !sniffedPdf(document) || document.status === "failed") return false;
  // An encrypted PDF parses from quarantine's scanned copy (lib/parse-source.ts), whose size the planner does not know: the
  // stage loop takes it. A document with no parse decision from this build is refused there, never batched.
  if (document.parseSourceDecision === "scanned-copy" || document.parseSourceDecision === "unscanned") return false;
  return bytes <= provider.maxSourceBytes;
}

/**
 * Whether format-detect leaves this PDF's page count to the first pass (the batch measures it in the same VM). Only for a run
 * whose workflow recorded the first pass, and only for documents the planner takes: the same predicate as planFirstPass
 * (firstPassCandidate, size included), so no PDF is deferred without a batch. A document whose size is unknown is counted
 * by format-detect. Whatever the first pass then does not count is counted before the stage loop (countDeferredPdfPages).
 */
export function firstPassDefersPageCount(state: Pick<WorkflowState, "firstPassRun">, document: Pick<Document, "mimeType" | "fileFacts" | "status" | "sourceBytes" | "parseSourceDecision">): boolean {
  if (state.firstPassRun !== true) return false;
  const bytes = Number(document.sourceBytes);
  if (!Number.isFinite(bytes) || bytes <= 0) return false;
  return firstPassCandidate(document, bytes);
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
  // A figure request is answered by the first pass's own figure step, never twice: the job is marked on the host
  // (markFirstPassServedFigures), so extract-markdown neither stores figures nor writes the ledger for it.
  if (job.figures) markFirstPassServedFigures(job);
  return { ...cached.result, ...(job.figures ? { figures: { status: "failed" as const, reason: "figures-stored-by-first-pass" } } : {}) };
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
  /** Every document of the run is in a batch. */
  coversRun: boolean;
  /** PDFs whose page count is still intake's estimate but that no batch takes: counted before the stage loop (H2). */
  countFirst: string[];
}

/** The run's first-pass batches: candidates only, never another run's documents. Empty without a batch provider. */
export async function planFirstPass(store: FirstPassStore, runId: string): Promise<FirstPassPlan> {
  const provider = sandboxedPdfBatchProvider();
  const state = await loadRunState(store, runId, { hydrate: true });
  const deferred = (taken: Set<string>) => state.documents
    .filter((document) => !taken.has(document.id) && sniffedPdf(document) && document.pageCountSource === "assumed" && document.status !== "failed")
    .map((document) => document.id);
  if (!provider) return { batches: [], limits: null, coversRun: false, countFirst: deferred(new Set()) };
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
  const batches = planFirstPassBatches(candidates, limits);
  return { batches, limits, coversRun: candidates.length === state.documents.length, countFirst: deferred(new Set(batches.flat())) };
}

// ── One batch ──

export interface FirstPassBatchDeps {
  store: FirstPassStore;
  storage: ArtifactStore;
  quarantineEnabled: boolean;
  /**
   * Run one ordinary stage for these documents as a shard, with the first-pass pipeline. Returns its usage. `signal` is the
   * batch's own: aborted when the batch fails, so no stage keeps running after the batch has returned or thrown.
   */
  runStage(stageName: string, documentIds: string[], signal?: AbortSignal): Promise<UsageSummary>;
  heartbeat(details: Record<string, unknown>): void;
  signal?: AbortSignal;
  /** Clock for timings (tests). */
  now?: () => number;
}

export interface FirstPassBatchResult {
  usage: UsageSummary;
  /**
   * Documents the first pass made keyword searchable and whose `index` checkpoint is durably completed (council #340 N1):
   * a document embedded but not confirmed indexed is handed back ("index-unconfirmed"), and the stage loop indexes it.
   */
  indexed: string[];
  /** Documents whose text the batch extracted but that the stage loop finishes (pages that need OCR or vision). */
  extracted: string[];
  /**
   * Every other document of the batch, each exactly once: the batch could not convert it, its source or organization was
   * refused, its gate or a stage withheld it. Counted (or failed) before it is listed; the stage loop takes it.
   */
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

/** Document artifact holding a first-pass batch result, for an ordinary extract-markdown that runs again (C1). */
export const FIRST_PASS_RESULT_ARTIFACT = "first-pass-result";

/**
 * Before any parser command, as for every other parser command (tools/runner.ts admitCommand): a latched teardown failure
 * or an open teardown breaker stops the whole batch; a quarantined source or organization refuses that document.
 */
async function admitBatchDocument(state: WorkflowState, document: Document): Promise<void> {
  const latched = latchedTeardownError();
  if (latched) throw latched;
  assertTeardownBreakerClosed();
  await runWithPerfContext({
    runId: state.run.id, documentId: document.id, orgId: state.run.orgId, scope: "document", stageName: "first-pass",
    pageCount: document.pageCount, pushPerformance: () => {},
  }, () => admitCommandSource());
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
  // The ordinary loop extracts these documents again (C1): keep each batch result where it can be served without a VM.
  const persistResults = firstPassExtractionDiffers(pipeline);
  // The batch's own scope: aborted on any failure (or the activity's cancellation), so no drain outlives the batch.
  const batch = new AbortController();
  const onOuterAbort = () => batch.abort(deps.signal?.reason);
  if (deps.signal?.aborted) batch.abort(deps.signal.reason);
  deps.signal?.addEventListener("abort", onOuterAbort, { once: true });
  const work = await mkdtemp(path.join(tmpdir(), "docslurp-first-pass-"));
  const staged: string[] = [];
  const handedBack: FirstPassBatchResult["handedBack"] = [];
  /** Embedded by a drain (embed checkpoint completed); indexed only once the index checkpoint is confirmed too. */
  const embedded: string[] = [];
  const extracted: string[] = [];
  let usage = zeroUsage();
  const timings = { firstTextMs: null as number | null, allTextMs: null as number | null, firstSearchableMs: null as number | null, allSearchableMs: null as number | null, batchMs: 0, pages: 0 };
  const cachedKeys: string[] = [];
  const inflight = new Set<Promise<void>>();
  /** Drains wait for this before returning or rethrowing, so nothing they started is still writing. */
  const settled = async () => { while (inflight.size) await Promise.allSettled([...inflight]); };
  let providerUsageRecorded = false;
  try {
    const files: SandboxedPdfBatchFile[] = [];
    for (const documentId of input.documentIds) {
      if (batch.signal.aborted) throw batch.signal.reason instanceof Error ? batch.signal.reason : new Error("first-pass batch aborted");
      const document = documents.get(documentId)!;
      // The same admission and integrity checks as any parser command: a refused source never enters a batch VM.
      let source: string;
      try {
        await admitBatchDocument(state, document);
        source = await stageSourceFile(deps.storage, document, trustedTempDownloadPattern("docslurp-first-pass-", document), { maxBytes: provider.maxBatchBytes });
        // The staged bytes are the uploaded ones; a quarantine listing by hash is checked against them too.
        await admitBatchDocument(state, document);
      } catch (error) {
        if (!findQuarantinedSourceError(error)) throw error;
        console.warn(`[first-pass] run=${input.runId} document=${documentId} refused before the batch: ${error instanceof Error ? error.name : "refused"}`);
        handedBack.push({ documentId, reason: "refused" });
        continue;
      }
      staged.push(source);
      deps.heartbeat({ firstPass: "staged", documents: files.length + 1 });
      const dir = path.join(work, String(files.length));
      await mkdir(dir, { recursive: false });
      const figures = options.figures ? path.join(dir, "figures") : undefined;
      if (figures) await mkdir(figures);
      files.push({ index: files.length, documentId, input: source, output: path.join(dir, "output.md"), bytes: scopes.get(documentId)?.bytes ?? 0,
        estimatedPages: document.pageCount, ...(figures ? { figures: { dir: figures, limits: dopplerImageLimits(document.pageCount) } } : {}) });
    }
    const job: SandboxedPdfBatchJob = { scope: { orgId: state.run.orgId ?? "", runId: input.runId }, files, options };
    if (files.length > 0) {
      // Before any VM: the database says every document is this run's and this organization's.
      assertSingleScopeBatch(job, scopes);
    }

    // Documents advance as their results arrive, a few at a time: each drain runs the ordinary stages as one shard.
    const ready: string[] = [];
    /** Documents whose text layer misses pages: extracted now, embedded by the stage loop after OCR or vision. */
    const extractOnly = new Set<string>();
    const figureReady = new Map<string, { dir: string; outcome: SandboxedPdfFigureOutcome }>();
    /** Documents the publish gate passed (figures are stored only for these). */
    const cleared = new Set<string>();
    let drainFailure: unknown;
    /** A rejection of the host's event handler: the batch is over, whatever the provider does with it. */
    let handlerFailure: unknown;
    let handlerFailed = false;
    const drainSlots = firstPassDrainConcurrency();
    let activeDrains = 0;
    const drainGroup = async (ids: string[]) => {
      try {
        usage = addUsage(usage, await deps.runStage("extract-markdown", ids, batch.signal));
        if (pipeline.piiPolicy?.enabled) usage = addUsage(usage, await deps.runStage("pii-detect", ids, batch.signal));
        const fresh = await loadRunState(deps.store, input.runId, { hydrate: true });
        const publishable: string[] = [];
        for (const id of ids) {
          const stages = fresh.documentStages.get(id);
          if (stages?.get("extract-markdown")?.status !== "completed") continue;
          if (pipeline.piiPolicy?.enabled && stages.get("pii-detect")?.status !== "completed") continue;
          if (!(await firstPassPublishGate().awaitClean({ state: fresh, documentId: id, quarantineEnabled: deps.quarantineEnabled, signal: batch.signal }))) continue;
          cleared.add(id);
          if (extractOnly.has(id)) continue;
          publishable.push(id);
        }
        if (publishable.length) {
          usage = addUsage(usage, await deps.runStage("embed", publishable, batch.signal));
          // Only what the embed stage durably completed counts (a stage that no-ops for a document leaves it to the loop).
          const afterEmbed = await loadRunState(deps.store, input.runId, { hydrate: true });
          const done = publishable.filter((id) => afterEmbed.documentStages.get(id)?.get("embed")?.status === "completed");
          if (done.length) {
            const searchable = now() - started;
            timings.firstSearchableMs ??= searchable;
            timings.allSearchableMs = searchable;
            embedded.push(...done);
          }
        }
      } catch (error) {
        drainFailure ??= error;
        // Stop the other drains too: the batch fails, and nothing may keep writing after it.
        batch.abort(error);
      }
      deps.heartbeat({ firstPass: "drained", documents: ids.length });
    };
    const drain = () => {
      while (!drainFailure && !handlerFailed && !batch.signal.aborted && ready.length > 0 && activeDrains < drainSlots) {
        activeDrains++;
        // Free slots share the backlog, so a burst of results spreads across the drains instead of queueing behind one.
        const ids = ready.splice(0, Math.max(1, Math.ceil(ready.length / (drainSlots - activeDrains + 1))));
        const running: Promise<void> = drainGroup(ids).finally(() => { activeDrains--; inflight.delete(running); drain(); });
        inflight.add(running);
      }
    };

    const handleEvent = async (raw: SandboxedPdfBatchEvent) => {
      // The text result as the provider sent it: extract-markdown accepts it again when it is served (layout facts, OCR pages).
      const sent = (raw as { phase?: unknown; result?: SandboxedPdfResult }).phase === "text" ? { ...(raw as { result: SandboxedPdfResult }).result } : undefined;
      const event = acceptSandboxedPdfBatchEvent(job, raw);
      const file = files[event.index]!;
      const document = documents.get(file.documentId)!;
      deps.heartbeat({ firstPass: event.phase, index: event.index });
      if (event.phase === "failed") {
        // A file that failed after its text keeps the text; only a file with no text is handed back.
        if (results.has(key(input.runId, file.documentId))) return;
        handedBack.push({ documentId: file.documentId, reason: event.reason });
        if (event.reason === "page-count") await refusePageCount(state, document, event.pageCountOutcome);
        return;
      }
      if (event.phase === "figures") {
        if (file.figures) figureReady.set(file.documentId, { dir: file.figures.dir, outcome: event.figures });
        return;
      }
      const textMs = now() - started;
      timings.firstTextMs ??= textMs;
      timings.allTextMs = textMs;
      timings.pages += event.pages;
      // The measured count first: recorded and authorized before anything that bills.
      await recordBatchPageCount(deps.store, state, document, event.pages, event.processedPages);
      const cached: CachedResult = { markdownPath: file.output, result: { ...event.result, ...(sent?.layoutFacts !== undefined ? { layoutFacts: sent.layoutFacts } : {}) } };
      if (persistResults) await persistBatchResult(deps.storage, state, document, cached);
      results.set(key(input.runId, file.documentId), cached);
      cachedKeys.push(key(input.runId, file.documentId));
      if (pipeline.quality !== "fast" && textlessPages(sandboxedPdfLayoutFacts(batchFileJob(job, event.index)!), event.processedPages ?? event.pages) > 0) {
        // The text layer misses pages the project reads (OCR or vision): extract now (served from the batch), embed after
        // the stage loop reads them. Fast quality reads the text layer only, so its documents are embedded now.
        extracted.push(file.documentId);
        extractOnly.add(file.documentId);
      }
      ready.push(file.documentId);
      drain();
    };
    const onEvent = async (raw: SandboxedPdfBatchEvent) => {
      // After a refusal nothing more is accepted, whatever the provider sends.
      if (handlerFailed) throw handlerFailure;
      try {
        await handleEvent(raw);
      } catch (error) {
        handlerFailed = true;
        handlerFailure = error;
        batch.abort(error);
        throw error;
      }
    };

    if (files.length > 0) {
      let run: { usage: UsageEvent[] };
      try {
        run = await provider.run(job, onEvent, batch.signal);
      } catch (error) {
        // Bill every VM the batch ran, whatever ended it.
        for (const event of batchUsageOf(error)) state.usageLedger.enqueue(event);
        providerUsageRecorded = true;
        throw handlerFailed ? handlerFailure : error;
      }
      for (const event of run.usage) state.usageLedger.enqueue(event as UsageEvent);
      providerUsageRecorded = true;
      // A provider that resolved after the host refused an event broke the contract: the refusal still ends the batch.
      if (handlerFailed) throw handlerFailure;
    }
    drain();
    await settled();
    if (drainFailure) throw drainFailure;

    // Files with no text: counted the ordinary way (or failed) so none bills an estimate, then left to the stage loop.
    for (const file of unfinishedBatchFiles(job)) {
      if (!handedBack.some((entry) => entry.documentId === file.documentId)) handedBack.push({ documentId: file.documentId, reason: "no-result" });
    }

    // Figures: stored only for documents whose text was extracted and whose publish gate passed, never failing a document.
    for (const [documentId, { dir, outcome }] of figureReady) {
      const document = documents.get(documentId)!;
      if (!results.has(key(input.runId, documentId)) || !cleared.has(documentId)) continue;
      // The Markdown exactly as Doppler wrote it: stored as `document.md` beside the images, and read for its markers.
      const markdownPath = files.find((f) => f.documentId === documentId)!.output;
      const markdown = await readFile(markdownPath, "utf8").catch(() => "");
      await runDocumentStage(state, document, FIRST_PASS_FIGURES_STAGE, `${documentId}:${FIRST_PASS_FIGURES_STAGE}`, "figures stored", () =>
        storeFirstPassFigures({ state, document, dir, outcome, markdownPath, markdown, storage: deps.storage as unknown as DopplerFigureStorage, runId: input.runId, signal: batch.signal })
      , batch.signal);
    }

    if (embedded.length) usage = addUsage(usage, await deps.runStage("index", embedded, batch.signal));
    // Indexed only what the index stage durably completed (N1): a stage that skipped a document, left its checkpoint
    // incomplete or failed it is handed back, and the stage loop (which skips completed embed checkpoints) indexes it once.
    const indexed = await confirmedIndexed(deps.store, input.runId, embedded, pipeline.indexVectors !== false);
    for (const documentId of embedded) if (!indexed.includes(documentId)) handedBack.push({ documentId, reason: "index-unconfirmed" });

    // Every document exactly once: what the first pass neither indexed nor left extracted is handed back (withheld by its
    // gate, a failed or incomplete stage), so the workflow never counts it finished.
    const accounted = new Set([...indexed, ...extracted, ...handedBack.map((entry) => entry.documentId)]);
    for (const documentId of input.documentIds) if (!accounted.has(documentId)) handedBack.push({ documentId, reason: "withheld" });
    // A handed-back PDF is measured and authorized before the stage loop takes it, so nothing bills an estimate.
    await countDeferredPdfPages({
      state, storage: deps.storage, runner: unusedRunner, signal: batch.signal,
      documents: handedBack.filter((entry) => entry.reason !== "page-count").map((entry) => documents.get(entry.documentId)!),
      reason: (documentId) => handedBack.find((entry) => entry.documentId === documentId)?.reason ?? "handed-back",
      stagedSource: (documentId) => files.find((f) => f.documentId === documentId)?.input,
    });

    await deps.store.updateProgress(state);
    usage = addUsage(usage, state.usageLedger.totals());
    timings.batchMs = now() - started;
    console.log(`[first-pass] run=${input.runId} batch files=${files.length} pages=${timings.pages} indexed=${indexed.length} extracted=${extracted.length} ` +
      `handedBack=${handedBack.length} firstTextMs=${timings.firstTextMs} allTextMs=${timings.allTextMs} firstSearchableMs=${timings.firstSearchableMs} ` +
      `allSearchableMs=${timings.allSearchableMs} batchMs=${timings.batchMs}`);
    return { usage, indexed, extracted, handedBack, timings };
  } catch (error) {
    // No drain outlives the batch: stop them, wait for every one, then persist what was spent before rethrowing.
    batch.abort(error);
    await settled();
    if (!providerUsageRecorded) for (const event of batchUsageOf(error)) state.usageLedger.enqueue(event);
    await deps.store.updateProgress(state).catch((flushError: unknown) =>
      console.warn(`[first-pass] run=${input.runId} usage flush after a failed batch failed: ${flushError instanceof Error ? flushError.message : String(flushError)}`));
    throw error;
  } finally {
    deps.signal?.removeEventListener("abort", onOuterAbort);
    await settled();
    for (const k of cachedKeys) results.delete(k);
    for (const source of staged) await cleanupTempFile(source).catch(() => undefined);
    await rm(work, { recursive: true, force: true });
  }
}

/**
 * The embedded documents whose index checkpoint the database holds as completed. Reads the checkpoints again (never the
 * in-memory state the stage wrote), so only a durable completion counts. A pipeline without vector indexing has no index
 * checkpoint to wait for: there, the embed checkpoint is the document's last first-pass stage.
 */
async function confirmedIndexed(store: FirstPassStore, runId: string, embedded: string[], indexVectors: boolean): Promise<string[]> {
  if (!embedded.length || !indexVectors) return [...embedded];
  const after = await loadRunState(store, runId, { hydrate: true });
  return embedded.filter((id) => after.documentStages.get(id)?.get("index")?.status === "completed"
    && after.documentStages.get(id)?.get("embed")?.status === "completed");
}

/** The VM route counts pages with the provider; the host runner is never used for a PDF here. */
const unusedRunner = {
  pdfPageCount: () => { throw new Error("first pass counts PDFs in the VM only"); },
  pdfPopplerAcceptance: () => { throw new Error("first pass counts PDFs in the VM only"); },
  run: () => { throw new Error("first pass counts PDFs in the VM only"); },
} as unknown as Parameters<typeof recordMeasuredPdfPageCount>[0]["runner"];

/**
 * Measure and authorize every PDF whose page count format-detect left to the first pass and that the first pass did not
 * count (a failed, lost or unplanned batch; a handed-back file), before the stage loop takes it (council #340 H2). The
 * ordinary page-count path (VM in vm mode), checkpointed so a retry never measures twice; authorization runs every time.
 */
export async function countDeferredPdfPages(args: {
  state: WorkflowState;
  storage: Pick<ArtifactStore, "downloadToTempFile">;
  runner: Parameters<typeof recordMeasuredPdfPageCount>[0]["runner"];
  documents: Document[];
  signal?: AbortSignal;
  reason?: (documentId: string) => string;
  /** A source the caller already staged and verified (the batch's own copy). */
  stagedSource?: (documentId: string) => string | undefined;
}): Promise<void> {
  const { state } = args;
  for (const document of args.documents) {
    if (!document || !sniffedPdf(document) || document.status === "failed") continue;
    await runDocumentStage(state, document, FIRST_PASS_PAGE_COUNT_STAGE, `${document.id}:${FIRST_PASS_PAGE_COUNT_STAGE}`, "page count measured", async () => {
      let temp: string | null = null;
      try {
        // The same admission as any parser command: a quarantined source or organization fails here, never reaches a VM.
        await admitBatchDocument(state, document);
        await recordMeasuredPdfPageCount({
          state, document, runner: args.runner, signal: args.signal,
          sourcePath: async () => args.stagedSource?.(document.id)
            ?? (temp ??= await stageSourceFile(args.storage, document, trustedTempDownloadPattern("docslurp-pdf-pages-", document))),
        });
        return { stats: { pages: document.pageCount, handedBack: args.reason?.(document.id) ?? "deferred" } };
      } finally {
        if (temp) await cleanupTempFile(temp).catch(() => undefined);
      }
    }, args.signal);
    // On every attempt (a retry finds the count recorded and must still be authorized).
    if (document.pageCountSource === "counted" && state.documentStages.get(document.id)?.get(FIRST_PASS_PAGE_COUNT_STAGE)?.status !== "failed") {
      await authorizeMeasuredPages(state, document);
    }
  }
}

/** Activity body: count the deferred PDFs of these documents (a failed batch, unplanned documents). */
export async function countFirstPassPages(
  deps: { store: FirstPassStore; storage: Pick<ArtifactStore, "downloadToTempFile">; runner?: Parameters<typeof recordMeasuredPdfPageCount>[0]["runner"]; signal?: AbortSignal },
  input: { runId: string; documentIds: string[] },
): Promise<{ counted: number }> {
  const state = await loadRunState(deps.store, input.runId, { hydrate: true });
  state.beginShard(input.documentIds);
  state.firstPassRun = true;
  const assumed = state.documents.filter((document) => document.pageCountSource === "assumed");
  await countDeferredPdfPages({ state, storage: deps.storage, runner: deps.runner ?? unusedRunner, documents: state.documents, signal: deps.signal, reason: () => "first-pass-unfinished" });
  await deps.store.updateProgress(state);
  return { counted: assumed.filter((document) => document.pageCountSource === "counted").length };
}

/** Keep a batch result in storage so an ordinary extract-markdown that runs again is served from it (no second VM). */
async function persistBatchResult(storage: ArtifactStore, state: WorkflowState, document: Document, cached: CachedResult): Promise<void> {
  const resultKey = `${runArtifactRoot(state.run, document.userId)}/first-pass/${document.id}.json`;
  const markdown = await readFile(cached.markdownPath, "utf8");
  await storage.putJson(resultKey, { version: 1, documentId: document.id, markdown, result: cached.result });
  state.artifactLedger.recordDocument(document.id, FIRST_PASS_RESULT_ARTIFACT, storage.uri(resultKey));
}

/**
 * For an ordinary extract-markdown in a first-pass run: load the persisted batch result of every document whose
 * provisional extract-markdown checkpoint runs again, so it is served without a VM. Returns the release.
 */
export async function primeFirstPassResults(state: WorkflowState, storage: Pick<ArtifactStore, "getJson" | "bucket">, signal?: AbortSignal): Promise<() => Promise<void>> {
  const primed: string[] = [];
  const dirs: string[] = [];
  const release = async () => {
    for (const k of primed) results.delete(k);
    for (const dir of dirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  if (!state.firstPassRun || state.firstPassShard || !state.firstPassExtractionDiffers) return release;
  try {
    for (const document of state.documents) {
      if (signal?.aborted) break;
      const checkpoint = state.documentStage(document.id, "extract-markdown");
      if (checkpoint?.status !== "completed" || !firstPassCheckpointStale(state, document.id, "extract-markdown", checkpoint)) continue;
      const uri = state.artifactLedger.readDocument(document.id, FIRST_PASS_RESULT_ARTIFACT);
      const resultKey = uri ? keyFromStorageUri(uri, storage.bucket) : null;
      if (!resultKey) continue;
      const stored = await storage.getJson<{ documentId?: unknown; markdown?: unknown; result?: unknown }>(resultKey).catch(() => null);
      // Our own artifact, still checked: the result is validated again when it is served (acceptSandboxedPdfResult).
      if (!stored || stored.documentId !== document.id || typeof stored.markdown !== "string" || !stored.result || typeof stored.result !== "object") continue;
      const dir = await mkdtemp(path.join(tmpdir(), "docslurp-first-pass-served-"));
      dirs.push(dir);
      const markdownPath = path.join(dir, "output.md");
      await writeFile(markdownPath, stored.markdown, { mode: 0o600 });
      results.set(key(state.run.id, document.id), { markdownPath, result: stored.result as SandboxedPdfResult });
      primed.push(key(state.run.id, document.id));
    }
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}

/** Record the batch's structural page count before any stage bills, then authorize pages above intake's estimate. */
async function recordBatchPageCount(store: FirstPassStore, state: WorkflowState, document: Document, pages: number, processedPages?: number): Promise<void> {
  if (document.pageCountSource === "assumed") {
    if (!(await store.setDocumentPageCount(state.run.id, document.id, pages))) throw new Error("First-pass page count could not be recorded");
    state.run.pagesTotal = Math.max(0, (Number(state.run.pagesTotal) || 0) + pages - Math.max(1, Math.trunc(document.pageCount) || 1));
    document.pageCount = pages;
    document.pageCountSource = "counted";
  }
  await authorizeMeasuredPages(state, document);
  // The converter read fewer pages than the structure holds: bill what was extracted and flag the document partially
  // extracted (N of M pages), exactly as a single-file run does.
  if (processedPages !== undefined && processedPages < pages) await reconcileProcessedPdfPages(state, document, processedPages);
}

/** A file the VM could not count fails as format-detect would have failed it. */
async function refusePageCount(state: WorkflowState, document: Document, outcome: string | undefined): Promise<void> {
  await runDocumentStage(state, document, FIRST_PASS_PAGE_COUNT_STAGE, `${document.id}:${FIRST_PASS_PAGE_COUNT_STAGE}`, "page count refused", async () => {
    throw new PdfPageCountError(`PDF page count failed in the VM: ${outcome ?? "unavailable"}`, (outcome ?? "unavailable") as never);
  });
}

export const __test = { textlessPages, cp };

/**
 * The first pass's figure step for one document (its stage `first-pass:figures`): read and store the provider's images
 * folder and queue the asset ledger write for the stage checkpoint, whatever happened (every image and why, or a failed
 * images level). Never fails the document; cancellation still throws.
 */
export async function storeFirstPassFigures(args: {
  state: WorkflowState; document: Document; dir: string; outcome: SandboxedPdfFigureOutcome; markdownPath: string; markdown: string;
  storage: DopplerFigureStorage; runId: string; signal: AbortSignal;
}): Promise<{ artifactUri?: string; stats: Record<string, unknown> }> {
  const { state, document, outcome } = args;
  const documentId = document.id;
  if (outcome.status === "failed") {
    console.warn(`[first-pass] figures document=${documentId} status=extraction-failed`);
    const ledger = queueAssetLedger(state, documentId, ledgerWriteForFailedFigures({ outcome }));
    return { stats: { dopplerFigures: { status: "extraction-failed", ledger } } };
  }
  let figures: Awaited<ReturnType<typeof readDopplerFigureDir>> | null = null;
  try {
    figures = await readDopplerFigureDir(args.dir, {
      pageCount: document.pageCount, signal: args.signal, expect: outcome.status === "partial" ? "partial" : "complete",
      sourceSha256: document.sourceSha256 ?? null,
    });
    const stored = await storeDopplerFigures({
      storage: args.storage, document, runId: args.runId, figures, markdown: args.markdown,
      dopplerMarkdownPath: args.markdownPath, source: dopplerSourcePointer(document), signal: args.signal,
    });
    for (const { slot, uri } of stored.slots) state.artifactLedger.recordDocument(documentId, slot, uri);
    // The ledger write takes over the reader's spill (it removes it once written).
    const ledger = queueAssetLedger(state, documentId, ledgerWriteForStoredFigures({ set: figures, storedManifest: stored.manifest, outcome }));
    return { artifactUri: stored.indexUri, stats: { dopplerFigures: { ...stored.stats, manifestVersion: figures.version, ledger } } };
  } catch (error) {
    await disposeDopplerFigureSet(figures);
    if (args.signal.aborted) throw error;
    const rule = error instanceof DopplerFigureRejection ? error.rule : "store-failed";
    console.warn(`[first-pass] figures document=${documentId} status=failed rule=${rule}`);
    const ledger = queueAssetLedger(state, documentId, ledgerWriteForFailedFigures({ outcome }));
    return { stats: { dopplerFigures: { status: "failed", rule, ledger } } };
  }
}

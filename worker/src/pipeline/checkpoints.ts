import { reportException, initializeWorkerErrorReporting } from "@docslurp/shared/error-reporting";
import { createHash } from "node:crypto";

import type { Document } from "../models.js";
import { runWithPerfContext } from "../lib/perf-context.js";
import { noteWorkProgress } from "../lib/work-progress.js";
import { hasFailedDocumentStage } from "./document-health.js";
import { isDocumentLevelFailure } from "../lib/document-failure.js";
import { runWithProviderRateScope } from "../lib/provider-rate-limit.js";
import type { WorkflowState } from "./pipeline.js";
import {
  buildRunProgressEvent,
  recordPageProgress,
} from "./run-ledger.js";

export async function runDocuments<T>(
  documents: Document[],
  concurrency: number,
  fn: (document: Document) => Promise<T>
): Promise<T[]> {
  if (concurrency <= 1) {
    const results: T[] = [];
    for (const doc of documents) {
      results.push(await fn(doc));
    }
    return results;
  }

  const results: T[] = new Array(documents.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = index++;
      if (i >= documents.length) return;
      const doc = documents[i]!;
      results[i] = await fn(doc);
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, documents.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export interface DocumentStageResult {
  artifactUri?: string;
  stats?: Record<string, unknown>;
  message?: string;
}

export class DocumentStageError extends Error {
  readonly artifactUri?: string;
  readonly stats?: Record<string, unknown>;

  constructor(message: string, options?: { artifactUri?: string; stats?: Record<string, unknown> }) {
    super(message);
    this.name = "DocumentStageError";
    this.artifactUri = options?.artifactUri;
    this.stats = options?.stats;
  }
}

/**
 * The run's spend for the run cost cap: billed spend committed to
 * usage_events (`workspace_runs.spent_cents`, as of this state's last
 * checkpoint, including other shards' and page tasks' commits) plus the
 * billable events still buffered in the ledger. Every usage event counts:
 * AI tokens, embeddings, vision, media, per-page fees and billed worker
 * compute. Unbilled compute estimates persist at 0 and do not count; the run
 * cost users see adds them on top as a flagged estimate. O(1).
 */
export function runSpentCents(state: WorkflowState): number {
  return (Number(state.run.spentCents) || 0) + state.usageLedger.pendingBillableCents;
}

export function isCostCapExceeded(state: WorkflowState): boolean {
  const cap = state.run.pipeline.maxCostCents;
  if (cap === null || cap === undefined || cap <= 0) {
    return false;
  }
  return runSpentCents(state) >= cap;
}

export interface RunDocumentStageOptions {
  retryStrategies?: string[];
}

interface DocumentStageAttempt {
  attempt: number;
  totalAttempts: number;
  strategy?: string;
}

interface DocumentStageFailure {
  error: unknown;
  artifactUri?: string;
  stats: Record<string, unknown>;
  message: string;
}

const PLAUSIBILITY_ESCALATION_THRESHOLD = 0.3;

function buildDocumentStageAttempts(retryStrategies: string[]): DocumentStageAttempt[] {
  const strategiesToTry: (string | undefined)[] = [undefined, ...retryStrategies];
  return strategiesToTry.map((strategy, index) => ({
    attempt: index + 1,
    totalAttempts: strategiesToTry.length,
    strategy,
  }));
}

function hasRemainingAttempts(attempt: DocumentStageAttempt): boolean {
  return attempt.attempt < attempt.totalAttempts;
}

function retryCountKey(documentId: string): string {
  return `${documentId}:retryCount`;
}

function recordArtifact(
  state: WorkflowState,
  artifactSlot: string,
  artifactUri: string | undefined,
): void {
  state.artifactLedger.record(artifactSlot, artifactUri);
}

function recordRetryCount(
  state: WorkflowState,
  documentId: string,
  attempts: number,
): void {
  const key = retryCountKey(documentId);
  state.artifactLedger.record(key, String(attempts));
}

function plausibilityScoreFor(stats: Record<string, unknown>): number | undefined {
  return typeof stats.plausibilityScore === "number"
    ? stats.plausibilityScore
    : undefined;
}

function shouldEscalateForLowPlausibility(
  stats: Record<string, unknown>,
  attempt: DocumentStageAttempt,
): { escalate: boolean; plausibilityScore?: number } {
  const plausibilityScore = plausibilityScoreFor(stats);
  return {
    plausibilityScore,
    escalate:
      plausibilityScore !== undefined &&
      plausibilityScore < PLAUSIBILITY_ESCALATION_THRESHOLD &&
      hasRemainingAttempts(attempt),
  };
}

function recordRetryPerformance(
  state: WorkflowState,
  document: Document,
  stageName: string,
  attempt: DocumentStageAttempt,
  reason: "low-plausibility" | "error",
  metadata: Record<string, unknown>,
): void {
  state.pendingPerformance.push({
    documentId: document.id,
    scope: "document",
    stageName,
    metric: "stage-retry",
    value: attempt.attempt,
    unit: "attempt",
    tags: ["document", "retry", reason],
    metadata: { strategy: attempt.strategy ?? "default", ...metadata }
  });
}

function documentStageFailure(error: unknown): DocumentStageFailure {
  const artifactUri = error instanceof DocumentStageError ? error.artifactUri : undefined;
  const stats = error instanceof DocumentStageError ? error.stats ?? {} : {};
  return {
    error,
    artifactUri,
    stats,
    message: error instanceof Error ? error.message : String(error),
  };
}

function completeDocumentStageInMemory(
  state: WorkflowState,
  document: Document,
  stageName: string,
  attempts: number,
  artifactUri: string,
  stats: Record<string, unknown>,
): void {
  state.setDocumentStage({
    runId: state.run.id,
    documentId: document.id,
    stageName,
    status: "completed",
    attempts,
    artifactUri,
    stats,
    error: "",
    startedAt: null,
    completedAt: null,
    updatedAt: new Date()
  });
  state.refreshStats();
}

/** How stale run counters may get between document completions before a checkpoint is forced. */
export const DOCUMENT_PROGRESS_CHECKPOINT_MS = 2_000;

/**
 * A completed document stage forces a progress checkpoint only when it left
 * something durable to persist (usage to bill, vectors, parser evaluations) or
 * the run counters are older than DOCUMENT_PROGRESS_CHECKPOINT_MS. Otherwise
 * the stage-completion checkpoint, moments later, carries the counters; the
 * live view already has the document.completed event.
 */
export function needsDocumentProgressCheckpoint(state: WorkflowState, now = Date.now()): boolean {
  return state.usageLedger.pendingCount > 0
    || state.vectorIndexes.length > 0
    || state.pendingParserEvaluations.length > 0
    || now - state.lastProgressFlushAt >= DOCUMENT_PROGRESS_CHECKPOINT_MS;
}

export async function runDocumentStage(
  state: WorkflowState,
  document: Document,
  stageName: string,
  artifactSlot: string,
  message: string,
  run: (retryStrategy?: string) => Promise<DocumentStageResult>,
  signal?: AbortSignal,
  options?: RunDocumentStageOptions
): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
  }

  if (hasFailedDocumentStage(state, document.id, stageName)) {
    console.log(
      `[checkpoint-debug] document=${document.id} stage=${stageName} skipped=document-failed-earlier`,
    );
    return;
  }

  const checkpoint = state.documentStage(document.id, stageName);
  if (checkpoint?.status === "completed") {
    console.log(
      `[checkpoint-debug] document=${document.id} stage=${stageName} skipped=already-completed ` +
        `artifact=${checkpoint.artifactUri ?? "none"}`,
    );
    if (checkpoint.artifactUri) {
      state.artifactLedger.record(artifactSlot, checkpoint.artifactUri);
    }
    return;
  }

  console.log(
    `[checkpoint-debug] document=${document.id} stage=${stageName} ` +
      `checkpointStatus=${checkpoint?.status ?? "none"} message=${message}`,
  );

  if (state.store) {
    await state.store.startDocumentStage(state, document.id, stageName);
  }

  const attemptsToTry = buildDocumentStageAttempts(options?.retryStrategies ?? []);
  let lastFailure: DocumentStageFailure | undefined;

  for (const attempt of attemptsToTry) {
    console.log(
      `[checkpoint-debug] document=${document.id} stage=${stageName} ` +
        `attempt=${attempt.attempt}/${attempt.totalAttempts} strategy=${attempt.strategy ?? "default"}`,
    );
    try {
      const result = await runWithPerfContext({
        runId: state.run.id,
        documentId: document.id,
        pageCount: document.pageCount,
        scope: "document",
        stageName,
        pushPerformance: (event) => state.pendingPerformance.push(event),
        pushUsage: (event) => state.usageLedger.enqueue(event),
      }, async () => await runWithProviderRateScope({ orgId: state.run.orgId }, () => run(attempt.strategy)));
      const stats = result.stats ?? {};

      const plausibilityDecision = shouldEscalateForLowPlausibility(stats, attempt);
      if (plausibilityDecision.escalate) {
        console.log(
          `[checkpoint-debug] document=${document.id} stage=${stageName} ` +
            `plausibilityScore=${plausibilityDecision.plausibilityScore?.toFixed(3)} below threshold, escalating to next strategy`,
        );
        recordRetryPerformance(state, document, stageName, attempt, "low-plausibility", {
          reason: `plausibilityScore < ${PLAUSIBILITY_ESCALATION_THRESHOLD}`,
          plausibilityScore: plausibilityDecision.plausibilityScore,
        });
        recordRetryCount(state, document.id, attempt.attempt);
        continue;
      }

      const artifactUri = result.artifactUri ?? state.artifactLedger.read(artifactSlot) ?? "";
      recordArtifact(state, artifactSlot, artifactUri);
      recordRetryCount(state, document.id, attempt.attempt);
      completeDocumentStageInMemory(state, document, stageName, attempt.attempt, artifactUri, stats);

      console.log(
        `[checkpoint-debug] document=${document.id} stage=${stageName} completed ` +
          `attempts=${attempt.attempt} artifact=${artifactUri || "none"}`,
      );

      if (state.store) {
        await state.store.completeDocumentStage(state, document.id, stageName, artifactUri, stats);
        if (needsDocumentProgressCheckpoint(state)) await state.store.updateProgress(state);
        await state.store.appendEvent(
          buildRunProgressEvent(state, {
            kind: "document-stage",
            documentId: document.id,
            stageName,
            outcome: "completed",
          }),
        );
      }
      return;
    } catch (error) {
      initializeWorkerErrorReporting();
      reportException(error, { runId: state.run.id, documentId: document.id, stage: stageName });
      lastFailure = documentStageFailure(error);
      recordArtifact(state, artifactSlot, lastFailure.artifactUri);
      console.warn(
        `[checkpoint-debug] document=${document.id} stage=${stageName} ` +
          `attempt=${attempt.attempt} failed reason=${lastFailure.message} ` +
          `partialArtifact=${lastFailure.artifactUri ?? "none"} ` +
          `hasMoreStrategies=${hasRemainingAttempts(attempt)}`,
      );
      recordRetryPerformance(state, document, stageName, attempt, "error", {
        reason: lastFailure.message,
      });
      recordRetryCount(state, document.id, attempt.attempt);

      if (!hasRemainingAttempts(attempt) || !isDocumentLevelFailure(error, signal)) {
        break;
      }
    }
  }

  const finalMessage = lastFailure?.message ?? "document stage failed";
  const finalArtifactUri = lastFailure?.artifactUri;
  const finalStats = lastFailure?.stats;
  const attempts = attemptsToTry.length;

  // An interruption (shutdown, activity cancellation, a Run-wide abort), a
  // Run-wide policy stop or an infrastructure error is not a verdict on the
  // Document. Persist nothing: the stage checkpoint stays "processing" so the
  // retried activity runs the Document again instead of skipping it as failed.
  // Infrastructure errors that keep recurring still end the Run through
  // failRunStage's ordinary-attempt budget.
  const cause = lastFailure?.error ?? new Error(finalMessage);
  if (!isDocumentLevelFailure(cause, signal)) {
    console.warn(
      `[checkpoint-debug] document=${document.id} stage=${stageName} ` +
        `interrupted=true reason=${finalMessage} signalAborted=${signal?.aborted === true}`,
    );
    // Still checkpoint what the attempt spent: provider calls already made are
    // billed even though the Document reruns, and stage-execution's
    // interruption path rethrows without a flush. Best-effort so a failing
    // store (often the very infrastructure error) never masks the cause.
    if (state.store) {
      await state.store.updateProgress(state).catch((flushError: unknown) => console.warn(
        `[checkpoint-debug] document=${document.id} stage=${stageName} interrupted progress flush failed: ` +
          `${flushError instanceof Error ? flushError.message : String(flushError)}`,
      ));
    }
    throw cause;
  }

  // All strategies exhausted on the Document's own input.
  console.error(
    `[checkpoint-error] document=${document.id} stage=${stageName} ` +
      `allStrategiesExhausted attempts=${attempts} message=${finalMessage} ` +
      `partialArtifact=${finalArtifactUri ?? "none"} ` +
      `partialStats=${finalStats ? JSON.stringify(finalStats) : "none"}`,
  );

  // Idempotent with the store's own in-memory update; keeps storeless runs
  // and test stores skipping the Document too.
  state.setDocumentStage({
    runId: state.run.id,
    documentId: document.id,
    stageName,
    status: "failed",
    attempts: attemptsToTry.length,
    artifactUri: finalArtifactUri ?? "",
    stats: finalStats ?? {},
    error: finalMessage,
    startedAt: null,
    completedAt: null,
    updatedAt: new Date(),
  });
  state.refreshStats();
  if (state.store) {
    await state.store.failDocumentStage(
      state,
      document.id,
      stageName,
      finalMessage,
      finalArtifactUri,
      finalStats
    );
    await state.store.updateProgress(state);
    await state.store.appendEvent(
      buildRunProgressEvent(state, {
        kind: "document-stage",
        documentId: document.id,
        stageName,
        outcome: "failed",
        error: finalMessage,
        payload: {
          error: finalMessage,
          partialArtifactUri: finalArtifactUri ?? null,
          attempts,
        },
      }),
    );
  }
  // The Document is failed and skipped from here on; the stage and Run carry
  // on without it.
}

export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function checkDedup(
  state: WorkflowState,
  contentHash: string,
  artifactSlot: string,
  retryStrategy?: string
): string | undefined {
  // A retry strategy asks for a different result (for example escalation after low plausibility);
  // reusing the artifact the failed attempt registered would silently skip it.
  if (retryStrategy) return undefined;
  const existing = state.contentHashes.get(contentHash);
  if (existing) {
    state.artifactLedger.record(artifactSlot, existing);
    return existing;
  }
  return undefined;
}

export function registerHash(
  state: WorkflowState,
  contentHash: string,
  artifactUri: string
): void {
  state.contentHashes.set(contentHash, artifactUri);
}

export function skipCompletedPages(completedPages: Set<number>, pageNumbers: number[]): number[] {
  return pageNumbers.filter((p) => !completedPages.has(p));
}

/**
 * Emit real-time page progress for a document stage.
 * Updates in-memory state, persists page checkpoint, emits a run.progress event,
 * and throttles DB progress flushes to avoid excessive writes.
 */
export async function emitDocumentPageProgress(
  state: WorkflowState,
  document: Document,
  stageName: string,
  pageNumber: number,
  pageCount: number,
  status: "completed" | "failed" | "processing",
  extraStats?: Record<string, unknown>,
): Promise<void> {
  noteWorkProgress(`page:${stageName}`);
  recordPageProgress(state, {
    documentId: document.id,
    stageName,
    pageNumber,
    pageCount,
    status,
  });

  if (status === "completed" && state.store) {
    await state.store.setPageStageComplete(state.run.id, document.id, stageName, pageNumber);
  }

  const now = Date.now();
  const shouldFlushProgress = state.store && (now - state.lastProgressFlushAt > 5_000);

  if (state.store) {
    await state.store.appendEvent(
      buildRunProgressEvent(state, {
        kind: "page",
        documentId: document.id,
        stageName,
        pageNumber,
        pageCount,
        pageStatus: status,
        extraStats,
      }),
    );

    if (shouldFlushProgress) {
      state.lastProgressFlushAt = now;
      await state.store.updateProgress(state);
    }
  }
}

/** Persist already-materialized pages in bounded batches; keep live progress without a round trip per page. */
export async function completeDocumentPages(
  state: WorkflowState, document: Document, stageName: string, pages: number[], pageCount: number, emitProgress = true,
): Promise<void> {
  for (let offset = 0; offset < pages.length; offset += 100) {
    const batch = pages.slice(offset, offset + 100);
    if (state.store?.setPagesStageComplete) {
      await state.store.setPagesStageComplete(state.run.id, document.id, stageName, batch);
    } else if (state.store) {
      for (const page of batch) await state.store.setPageStageComplete(state.run.id, document.id, stageName, page);
    }
    if (!emitProgress) continue;
    for (const pageNumber of batch) recordPageProgress(state, { documentId: document.id, stageName, pageNumber, pageCount, status: "completed" });
    if (state.store) {
      await state.store.appendEvent(buildRunProgressEvent(state, {
        kind: "page", documentId: document.id, stageName, pageNumber: batch[batch.length - 1]!,
        pageCount, pageStatus: "completed", extraStats: { completedPageNumbers: batch },
      }));
      if (Date.now() - state.lastProgressFlushAt > 5_000) {
        state.lastProgressFlushAt = Date.now();
        await state.store.updateProgress(state);
      }
    }
  }
}

import { PRICE_CARD, pageCredits, priceAiUsageEvent } from "@docslurp/shared";
import { emitTelemetryLog } from "./telemetry.js";
import { createHash } from "node:crypto";
import { withObservation, recordMediaTelemetry } from "@docslurp/shared/observability";
import type { ArtifactStore } from "../tools/storage.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import type { MediaConfig } from "./config.js";
import { BilledResponseError } from "./providers.js";
import type { AudioInput, MediaJournal, MediaProvider, MediaScope, Transcription } from "./types.js";

/**
 * Receipt key. For plain 16 kHz WAV chunks it is byte-for-byte the key written before chunk overlap, word timestamps and
 * diarization existed, so a run that was mid-ingest across a deploy replays its paid chunks instead of billing them again.
 * New request shapes (mp3 diarization upload, word-level responses) append a variant tag and never collide with it.
 */
export function mediaRequestKey(scope: MediaScope, provider: Pick<MediaProvider, "id" | "model">, offset: number, input: AudioInput): string {
  const variant = [input.format === "mp3" ? "mp3" : null, input.wordTimestamps ? "words" : null].filter((v): v is string => v !== null);
  return createHash("sha256").update(JSON.stringify([scope, provider.id, provider.model, offset, input.durationSeconds, "wav16k-v1", ...variant]))
    .update(input.bytes).digest("hex");
}

export async function transcribeChunk(args: {
  state: WorkflowState; scope: MediaScope; provider: MediaProvider; journal: MediaJournal;
  storage: ArtifactStore; input: AudioInput; offset: number; metric?: "media-transcription" | "media-diarization"; maxDocumentCostCents?: number; config: MediaConfig; signal?: AbortSignal;
}): Promise<Transcription> {
  const { state, scope, provider, journal, input, config, storage } = args;
  const key = mediaRequestKey(scope, provider, args.offset, input);
  const operation = args.metric === "media-diarization" ? "diarize" : "transcribe";
  args.signal?.throwIfAborted();
  await provider.prepare?.();
  const admission = await journal.admit({ scope, key, provider: provider.id, model: provider.model,
    // Reserve what the customer is billed for these seconds (media minutes as Rich pages); provider cost is ours.
    reserveCents: operation === "diarize" ? 0.001 : Math.max(0.001, pageCredits("rich", input.durationSeconds / 60 * PRICE_CARD.audioMinuteRichPages)),
    maxRunCostCents: state.run.pipeline.maxCostCents ?? null, maxDocumentCostCents: args.maxDocumentCostCents, maxConcurrent: config.maxConcurrent, dailyBudgetCents: config.dailyBudgetCents });
  const id = admission.receipt.id;
  if (!admission.acquired && admission.receipt.status !== "completed") {
    emitTelemetryLog({ severityText: "error", body: "media.request.reconciliation_required", attributes: { ...scope, provider: provider.id, mediaJobId: id } });
    throw new Error(`Remote media request ${id} requires reconciliation before retry`);
  }
  const resultKey = admission.receipt.resultKey ?? `${state.run.userId}/${scope.runId}/media/receipts/${id}.json`;
  const recordUsage = async (result: Transcription) => {
    if (state.artifactLedger.read(`media-usage:${id}`)) {
      if (!state.store) throw new Error("Media requires durable pipeline checkpoints");
      // A previous checkpoint may have failed after the in-memory dedup flag was set.
      await state.store.updateProgress(state);
      await journal.settled(id); return;
    }
    const costCents = result.costUsd * 100;
    state.usageLedger.enqueue(priceAiUsageEvent({ id, provider: provider.id, model: provider.model, metric: args.metric ?? "media-transcription",
      amount: input.durationSeconds, unit: "audio-seconds", costCents,
      inputTokens: result.inputTokens, outputTokens: result.outputTokens,
      metadata: { ...scope, mediaJobId: id, providerRequestId: result.requestId, costSource: result.costSource,
        accounting: result.accounting, providerCostUsd: result.costUsd, pricingMismatch: result.pricingMismatch, expectedCostUsd: result.expectedCostUsd, offsetSeconds: args.offset, priceUsdPerMinute: provider.priceUsdPerMinute } }),
      // Audio-seconds events log too (`[ai-usage] <metric> model=... input_tokens=0 output_tokens=0`), per the repo usage-logging rule.
      { logAiUsage: true });
    state.artifactLedger.record(`media-usage:${id}`, resultKey);
    // Persist usage and the dedup flag together before doing more billable work.
    if (!state.store) throw new Error("Media requires durable pipeline checkpoints");
    await state.store.updateProgress(state);
    await journal.settled(id);
  };
  if (!admission.acquired) {
    const result = await storage.getJson<Transcription>(resultKey, { maxBytes: 4 * 1024 * 1024 });
    await recordUsage(result); return result;
  }
  const started = Date.now();
  const failed = async (error: unknown, billed?: Transcription): Promise<never> => {
    recordMediaTelemetry({ provider: provider.id, model: provider.model, operation, outcome: "uncertain", durationSeconds: (Date.now() - started) / 1000 });
    // A billed-but-unusable (or unpersistable) response must still reach the usage ledger: the money is spent.
    if (billed) await recordUsage(billed).catch(() => emitTelemetryLog({ severityText: "error", body: "media.usage.record_failed", attributes: { ...scope, mediaJobId: id, provider: provider.id } }));
    await journal.uncertain(id);
    emitTelemetryLog({ severityText: "error", body: "media.request.failed_or_uncertain", attributes: { ...scope, mediaJobId: id, provider: provider.id, operation, durationMs: Date.now() - started } });
    // Never log response bodies, transcription, source paths or credentials.
    throw new Error(`Remote media request ${id} failed; inspect its durable receipt before retry`, { cause: error });
  };
  const estimatedBilling = (error: BilledResponseError): Transcription => ({ text: "", segments: [], costUsd: error.expectedCostUsd, costSource: "estimate",
    requestId: error.requestId, expectedCostUsd: error.expectedCostUsd,
    accounting: { state: "estimated", basis: "input-seconds", rateVersion: "unparsed-response", rateSource: provider.id,
      estimatedCostUsd: error.expectedCostUsd, providerRequestId: error.requestId } });
  let result: Transcription;
  try {
    const signal = AbortSignal.any([AbortSignal.timeout(config.requestTimeoutMs), ...(args.signal ? [args.signal] : [])]);
    result = await withObservation({ name: `media.${operation}`, type: "span",
      metadata: { ...scope, mediaJobId: id, provider: provider.id, model: provider.model },
      result: r => ({ metadata: { audioSeconds: input.durationSeconds, providerCostUsd: r.costUsd, costSource: r.costSource, providerRequestId: r.requestId, costState: r.accounting?.state } }),
    }, () => provider.transcribe(input, signal));
  } catch (error) {
    return await failed(error, error instanceof BilledResponseError ? estimatedBilling(error) : undefined);
  }
  let completed = false;
  try {
    recordMediaTelemetry({ provider: provider.id, model: provider.model, operation, outcome: "succeeded",
      durationSeconds: (Date.now() - started) / 1000, audioSeconds: input.durationSeconds, costUsd: result.costUsd, costSource: result.costSource });
    await storage.putJson(resultKey, result);
    // Retain the conservative reservation while units are disputed. A known discrepancy
    // within reserved exposure does not globally stop unrelated organizations.
    const exceedsReserve = (result.accounting?.reportedCostUsd ?? result.costUsd) >
      Math.max(.00001, input.durationSeconds / 60 * provider.priceUsdPerMinute * 1.25 * (provider.reservationMultiplier ?? 1));
    await journal.complete(id, resultKey, result.costUsd * 100, exceedsReserve, result.accounting, 0);
    completed = true;
    await recordUsage(result);
    if (result.pricingMismatch) emitTelemetryLog({ severityText: "error", body: "media.pricing.reconciliation_required",
      attributes: { ...scope, provider: provider.id, model: provider.model, mediaJobId: id, reportedCostUsd: result.accounting?.reportedCostUsd ?? result.costUsd, expectedCostUsd: result.expectedCostUsd ?? 0 } });
    emitTelemetryLog({ severityText: "info", body: "media.request.completed", attributes: { ...scope, mediaJobId: id, operation,
      provider: provider.id, model: provider.model, durationMs: Date.now() - started, audioSeconds: input.durationSeconds,
      costUsd: result.costUsd, costSource: result.costSource, providerRequestId: result.requestId ?? "", costState: result.accounting?.state ?? "estimated" } });
    return result;
  } catch (error) {
    // Once the receipt is completed a retry replays the stored result; only an unpersisted paid response needs its spend recorded here.
    return await failed(error, completed ? undefined : result);
  }
}

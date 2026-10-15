import type { WorkflowState } from "../pipeline/pipeline.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import type { Document } from "../models.js";
import { allowHostedCall } from "../lib/privacy-guard.js";
import type { MediaConfig } from "./config.js";
import { prepareDiarizationAudio } from "./prepare.js";
import { transcribeChunk } from "./processing.js";
import { configuredDiarizationProvider } from "./providers.js";
import { applySpeakers, type TimedSegment } from "./segments.js";
import { emitTelemetryLog } from "./telemetry.js";
import type { MediaJournal, MediaScope, SpeakerTurn } from "./types.js";

export interface DiarizationOutcome {
  status: "applied" | "skipped" | "failed";
  /** Short, content-free code explaining a skip or failure. */
  reason?: string;
  segments: TimedSegment[]; turns: SpeakerTurn[]; costUsd: number;
}

/** Map an error to a content-free reason code (error messages can carry provider detail and are only logged by code). */
export function diarizationFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/budget|cost cap|admission denied|concurrency exhausted|spend/i.test(message)) return "admission-denied";
  if (/reconciliation|pricing/i.test(message)) return "needs-reconciliation";
  if (/exceeds limit/i.test(message)) return "audio-too-large";
  if (/timed? ?out|abort/i.test(message)) return "timeout";
  return "provider-error";
}

/**
 * Optional speaker labelling. One diarization request covers the whole recording (labels are only
 * consistent within a request). It goes through the same admission, spend cap and usage ledger as
 * transcription (metric `media-diarization`, operation `diarize`). Any failure leaves the transcript unlabeled: speakers
 * are an enhancement and must never fail ingest, but the outcome and reason are always reported (log, telemetry, summary).
 */
export async function diarize(args: {
  state: WorkflowState; scope: MediaScope; config: MediaConfig; runner: CommandRunner; source: string; storage: ArtifactStore;
  journal: MediaJournal; document: Document; segments: TimedSegment[]; maxDocumentCostCents?: number; managedProvider: boolean;
  /** Probed media duration (ffprobe), not the end of the last transcript segment: trailing silence is still billed and may carry turns. */
  durationSeconds: number; signal?: AbortSignal;
}): Promise<DiarizationOutcome> {
  const { state, scope, config, document } = args;
  const outcome = (status: DiarizationOutcome["status"], reason?: string, extra: Partial<DiarizationOutcome> = {}): DiarizationOutcome => {
    if (status !== "applied") {
      console.warn(`[media] diarization ${status} for ${document.id}: ${reason}; continuing without speaker labels`);
      emitTelemetryLog({ severityText: "warn", body: `media.diarization.${status}`, attributes: { ...scope, operation: "diarize", reason: reason ?? "" } });
    }
    return { status, reason, segments: args.segments, turns: [], costUsd: 0, ...extra };
  };
  if (!args.managedProvider) return outcome("skipped", "unmanaged-provider");
  try {
    const provider = await configuredDiarizationProvider(config.diarization.model);
    if (!(await allowHostedCall(state, { provider: provider.id, model: provider.model, operation: "media.diarize", target: "hosted" }, [document.id]))) {
      return outcome("skipped", "privacy-mode");
    }
    const bytes = await prepareDiarizationAudio(args.runner, args.source, args.signal);
    const result = await transcribeChunk({ state, scope, provider, journal: args.journal, storage: args.storage,
      input: { bytes, durationSeconds: Math.max(args.durationSeconds, 1), format: "mp3" }, offset: 0, metric: "media-diarization",
      maxDocumentCostCents: args.maxDocumentCostCents, config, signal: args.signal });
    const turns = result.speakerTurns ?? [];
    if (!turns.length) return outcome("skipped", "no-speaker-turns", { costUsd: result.costUsd });
    return { status: "applied", segments: applySpeakers(args.segments, turns), turns, costUsd: result.costUsd };
  } catch (error) {
    if (args.signal?.aborted) throw error;
    console.warn(`[media] diarization error for ${document.id}: ${error instanceof Error ? error.message : String(error)}`);
    return outcome("failed", diarizationFailureReason(error));
  }
}

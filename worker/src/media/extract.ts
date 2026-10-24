import { configuredVisionProvider } from "./vision.js";
import { RunPolicyError } from "../lib/document-failure.js";
import { videoPolicy } from "./video-policy.js";
import { scanVideo, prepareVideoFrame, describeVideoChunk } from "./video-processing.js";
import { LeasedMediaProvider, leasedMediaProvider } from "./capacity/runtime.js";
import type { CapacityLeaseStore } from "./capacity/types.js";
import { createHash } from "node:crypto";
import {
  BILLABLE_UNIT_METRICS,
  DOCUMENT_FAILURE_MARKERS,
  UNIT_CHARGE_PROVIDER,
  mediaRichPages,
  pageCredits,
  unitChargeMetadata,
} from "@docslurp/shared";
import { allowHostedCall } from "../lib/privacy-guard.js";
import { runDocumentStage } from "../pipeline/checkpoints.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import type { Document } from "../models.js";
import type { CommandRunner } from "../tools/runner.js";
import { cleanupTempFile, type ArtifactStore } from "../tools/storage.js";
import { mediaConfig, type MediaConfig } from "./config.js";
import { configuredMediaProvider } from "./providers.js";
import { inspectMedia, prepareAudioChunk } from "./prepare.js";
import { transcribeChunk } from "./processing.js";
import { buildMediaCanonicalDocument, type VisualSegment } from "./canonical.js";
import { diarize, type DiarizationOutcome } from "./diarize.js";
import { SegmentAssembler, planChunkWindows, toTimedSegments, type TimedSegment } from "./segments.js";
import { buildMediaSummary } from "./summary.js";
import type { MediaJournal, SpeakerTurn } from "./types.js";

/**
 * Chunk windows and the word flag are part of every receipt key, so the first plan a document runs with is persisted in the
 * checkpoint and reused by retries: changing MEDIA_CHUNK_OVERLAP_SECONDS / MEDIA_WORD_TIMESTAMPS mid-ingest cannot re-bill
 * chunks that were already paid. Overlap is only used when the provider returns segment timestamps (otherwise the extra
 * audio would be paid for and its text could not be de-duplicated).
 */
export function chunkPlan(state: WorkflowState, documentId: string, provider: { supportsSegments?: boolean }, config: MediaConfig) {
  const slot = `media-plan:${documentId}`;
  const saved = state.artifactLedger.read(slot);
  if (saved) {
    const [chunk, overlap, words] = saved.split("|");
    if (Number.isFinite(Number(chunk)) && Number.isFinite(Number(overlap))) return { chunkSeconds: Number(chunk), overlapSeconds: Number(overlap), wordTimestamps: words === "1" };
  }
  const plan = { chunkSeconds: config.chunkSeconds, overlapSeconds: provider.supportsSegments ? config.chunkOverlapSeconds : 0, wordTimestamps: config.wordTimestamps };
  state.artifactLedger.record(slot, `${plan.chunkSeconds}|${plan.overlapSeconds}|${plan.wordTimestamps ? 1 : 0}`);
  return plan;
}

/**
 * Bill a transcribed media file by its duration (PRICE_CARD): an audio minute
 * is one Rich page, a video minute whose frames were read is three, rounded up
 * per file. Provider transcription and frame costs are recorded but bill 0.
 * One charge per (run, document); the id makes a retried checkpoint a no-op.
 */
export function chargeMediaMinutes(state: WorkflowState, documentId: string, kind: "audio" | "video", durationSeconds: number): void {
  const slot = `media-charge:${documentId}`;
  if (state.artifactLedger.read(slot)) return;
  const pages = mediaRichPages(kind, durationSeconds);
  if (pages <= 0) return;
  state.usageLedger.enqueue({
    id: `media:${state.run.id}:${documentId}`,
    provider: UNIT_CHARGE_PROVIDER, model: "price-card", metric: BILLABLE_UNIT_METRICS.mediaMinutes,
    amount: pages, unit: "page", costCents: pageCredits("rich", pages), inputTokens: 0, outputTokens: 0,
    metadata: unitChargeMetadata({ documentId, kind, durationSeconds, minutes: Math.ceil(durationSeconds / 60) }),
  });
  state.artifactLedger.record(slot, String(pages));
}

export async function extractMedia(args: { state: WorkflowState; document: Document; runner: CommandRunner;
  storage: ArtifactStore; journal?: MediaJournal; capacityStore?: CapacityLeaseStore; signal?: AbortSignal }) {
  const { state, document, runner, storage, signal } = args;
  await runDocumentStage(state, document, "extract-markdown", `${document.id}:markdown`, "transcribed media", async () => {
    const config = mediaConfig();
    if (!config.enabled) throw new RunPolicyError("Remote media processing is disabled; enable MEDIA_REMOTE_ENABLED");
    if (!args.journal || !state.store || !state.run.orgId || !state.run.workspaceId) throw new Error("Media requires durable, tenant-scoped execution");
    const scope = { orgId: state.run.orgId, workspaceId: state.run.workspaceId, runId: state.run.id, documentId: document.id };
    const provider = config.provider === "capacity"
      ? leasedMediaProvider(config.model, scope, args.capacityStore ?? (() => { throw new Error("Capacity store missing"); })(), state.run.pipeline.maxCostCents ?? null)
      : await configuredMediaProvider(config.provider, config.model);
    if (!(await allowHostedCall(state, { provider: provider.id, model: provider.model, operation: "media.transcribe", target: "hosted" }, [document.id]))) {
      throw new RunPolicyError("Workspace privacy mode disallows the configured media provider");
    }
    const source = await storage.downloadToTempFile(document.sourceKey, "source.media", { maxBytes: config.maxSourceBytes });
    try {
      const { duration, hasAudio, hasVideo } = await inspectMedia(runner, source, config, signal);
      // Missing workspace configuration opts in; explicit false wins even for silent video.
      // Platform, privacy, budget and durable quota checks still apply.
      const visualEnabled = process.env.MEDIA_VIDEO_ENABLED === "true" && hasVideo
        && state.run.pipeline.mediaVideo?.enabled !== false;
      if (!hasAudio && !visualEnabled) throw new Error(DOCUMENT_FAILURE_MARKERS.silentVideo);
      const policy = hasVideo ? videoPolicy(state.run.orgFunded, duration, state.run.pipeline.mediaVideo) : undefined;
      if (policy) {
        if (!args.journal.admitVideo) throw new Error("Video requires durable organization quota admission");
        await args.journal.admitVideo(scope, duration, visualEnabled ? policy.frames : 0);
      }
      // Until capacity reservations support a document ledger, reject this combination
      // before any lease or paid call instead of letting host cost bypass the cap.
      if (hasVideo && provider instanceof LeasedMediaProvider) throw new Error("Video document budgets require a managed media provider");
      const vision = hasVideo && visualEnabled ? await configuredVisionProvider() : undefined;
      if (vision && !(await allowHostedCall(state, { provider: vision.id, model: vision.model, operation: "media.vision", target: "hosted" }, [document.id]))) throw new RunPolicyError("Workspace privacy mode disallows video vision");
      const visualSegments: VisualSegment[] = [];
      let scanStats: { candidateCount: number; selectedCount: number; largestGapSeconds: number } | undefined;
      let costUsd = 0;
      const plan = chunkPlan(state, document.id, provider, config);
      const windows = hasAudio ? planChunkWindows(duration, plan.chunkSeconds, plan.overlapSeconds) : [];
      const assembler = new SegmentAssembler();
      for (const [index, window] of windows.entries()) {
        signal?.throwIfAborted();
        const seconds = window.end - window.start;
        const bytes = await prepareAudioChunk(runner, source, window.start, seconds, signal);
        const result = await transcribeChunk({ state, scope, provider, journal: args.journal, storage,
          input: { bytes, durationSeconds: seconds, wordTimestamps: plan.wordTimestamps }, offset: window.start,
          maxDocumentCostCents: policy?.maxCostCents, config, signal });
        costUsd += result.costUsd;
        assembler.add(window, toTimedSegments(result, window), index === windows.length - 1);
      }
      let segments: TimedSegment[] = assembler.segments;
      let speakerTurns: SpeakerTurn[] = [];
      let diarization: DiarizationOutcome | undefined;
      if (config.diarization.enabled && segments.length) {
        diarization = await diarize({ state, scope, config, runner, source, storage, journal: args.journal, document, segments, durationSeconds: duration,
          maxDocumentCostCents: policy?.maxCostCents, managedProvider: !(provider instanceof LeasedMediaProvider) && provider.id === "deepinfra", signal });
        segments = diarization.segments; speakerTurns = diarization.turns; costUsd += diarization.costUsd;
      }
      if (vision && policy) {
        const scan = await scanVideo(runner, source, policy, signal);
        scanStats = { candidateCount: scan.candidateCount, selectedCount: scan.selectedCount, largestGapSeconds: scan.largestGapSeconds };
        for (const batch of scan.batches) {
          signal?.throwIfAborted();
          const frames = [];
          for (const frame of batch) frames.push(await prepareVideoFrame(runner, source, frame.seconds, signal));
          const result = await describeVideoChunk({ state, scope, storage, journal: args.journal, provider: vision, frames, policy, config, signal });
          costUsd += result.costUsd ?? 0;
          visualSegments.push({ id: `${document.id}:visual:${visualSegments.length}`, start: batch[0].seconds, end: batch[batch.length-1].seconds,
            samples: batch.map(f=>f.seconds), text: result.text });
        }
      }
      const coverage = visualSegments.length ? (hasAudio ? "audio-and-sampled-visual" : "sampled-visual-only") : "audio-track-only";
      chargeMediaMinutes(state, document.id, visualSegments.length ? "video" : "audio", duration);
      const mediaKind = hasVideo ? "video" as const : "audio" as const;
      const sourceArtifactUri = storage.uri(document.sourceKey);
      const { text, canonical } = buildMediaCanonicalDocument({ documentId: document.id, mediaKind, durationSeconds: duration, segments,
        visualSegments, sourceArtifactUri, extractor: `media:${provider.id}` });
      const summary = buildMediaSummary({ mediaKind, durationSeconds: duration, segments, visualSegments, coverage, costUsd, diarized: speakerTurns.length > 0,
        diarization: diarization?.status, diarizationReason: diarization?.reason });
      const prefix = `${document.userId}/${state.run.id}/media/${document.id}`;
      await storage.putBytes(`${prefix}.md`, Buffer.from(text), "text/markdown; charset=utf-8");
      await storage.putJson(`${prefix}.json`, { documentId: document.id, provider: provider.id, model: provider.model,
        durationSeconds: duration, segments, speakerTurns, visualSegments, scanStats, samplingVersion: "video-gray96-v1", coverage, summary,
        chunking: { chunkSeconds: plan.chunkSeconds, overlapSeconds: plan.overlapSeconds, wordTimestamps: plan.wordTimestamps },
        diarization: diarization ? { status: diarization.status, ...(diarization.reason ? { reason: diarization.reason } : {}) } : undefined,
        sourceArtifactUri });
      // Blocks carry exact start/end seconds, speaker, mode and timing. Do not claim native video pages.
      await storage.putJson(`${prefix}.canonical.json`, canonical);
      await storage.putJson(`${prefix}.manifest.json`, { documentId: document.id, textArtifactUri: storage.uri(`${prefix}.md`),
        mediaArtifactUri: storage.uri(`${prefix}.json`), coverage, textSha256: createHash("sha256").update(text).digest("hex") });
      // Small stats-only artifact so the document detail API never has to load the full word-level sidecar.
      await storage.putJson(`${prefix}.summary.json`, summary);
      state.artifactLedger.recordDocument(document.id, "media-summary", storage.uri(`${prefix}.summary.json`));
      state.artifactLedger.recordDocument(document.id, "media-transcript", storage.uri(`${prefix}.json`));
      state.artifactLedger.recordDocument(document.id, "canonical-document", storage.uri(`${prefix}.canonical.json`));
      state.artifactLedger.recordDocument(document.id, "markdown-manifest", storage.uri(`${prefix}.manifest.json`));
      document.pageCount = 1;
      return { artifactUri: storage.uri(`${prefix}.md`), stats: { provider: provider.id, model: provider.model,
        durationSeconds: duration, segments: segments.length, speakers: summary.speakerCount, visualSegments: visualSegments.length, coverage } };
    } finally {
      try { await cleanupTempFile(source); } finally {
        if (provider instanceof LeasedMediaProvider) {
          const released = await provider.release();
          if (released && !state.artifactLedger.read(`capacity-usage:${released.leaseId}`)) {
            // Usage was persisted atomically with deletion (the usage_events
            // trigger counted it in spent_cents); this checkpoint refreshes it.
            state.artifactLedger.record(`capacity-usage:${released.leaseId}`, "recorded");
            await state.store.updateProgress(state);
          }
        }
      }
    }
  }, signal);
}

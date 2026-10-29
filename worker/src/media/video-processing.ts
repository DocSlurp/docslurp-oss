import { PRICE_CARD, pageCredits, priceAiUsageEvent } from "@docslurp/shared";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { withObservation, recordMediaTelemetry } from "@docslurp/shared/observability";
import type { WorkflowState } from "../pipeline/pipeline.js";
import type { ArtifactStore } from "../tools/storage.js";
import type { CommandRunner } from "../tools/runner.js";
import type { MediaJournal, MediaScope } from "./types.js";
import type { MediaConfig } from "./config.js";
import type { MediaVisionProvider, VideoFrame, VisionResult } from "./vision.js";
import { selectVideoFrames, packVideoFrames, type VideoCandidate, type VideoPolicy } from "./video-policy.js";
import { emitTelemetryLog } from "./telemetry.js";
import { runArtifactRoot } from "../lib/artifact-root.js";

export async function describeVideoChunk(args: { state: WorkflowState; scope: MediaScope; storage: ArtifactStore; journal: MediaJournal;
  provider: MediaVisionProvider; frames: VideoFrame[]; policy: VideoPolicy; config: MediaConfig; signal?: AbortSignal }): Promise<VisionResult> {
  const { state, scope, storage, journal, provider, frames, policy, config } = args;
  if (!state.store) throw new Error("Video requires durable checkpoints");
  args.signal?.throwIfAborted();
  await provider.prepare?.();
  const hash = createHash("sha256").update(JSON.stringify([scope, provider.id, provider.model, "video-gray96-v1", frames.map(f=>f.seconds)]));
  for (const f of frames) hash.update(f.bytes);
  const { receipt, acquired } = await journal.admit({ scope, key: hash.digest("hex"), provider: provider.id, model: provider.model,
    // Reserve the Rich pages these frames add on top of the audio minutes (video minutes bill as videoMinuteRichPages).
    reserveCents: Math.max(0.001, pageCredits("rich", Math.max(1, frames[frames.length - 1]!.seconds - frames[0]!.seconds) / 60 * (PRICE_CARD.videoMinuteRichPages - PRICE_CARD.audioMinuteRichPages))), maxRunCostCents: state.run.pipeline.maxCostCents ?? null,
    maxDocumentCostCents: policy.maxCostCents, maxConcurrent: config.maxConcurrent, dailyBudgetCents: config.dailyBudgetCents });
  if (!acquired && receipt.status !== "completed") throw new Error("Video request requires reconciliation before retry");
  const resultKey = receipt.resultKey ?? `${scope.runId === state.run.id ? runArtifactRoot(state.run, state.run.userId) : `${state.run.userId}/${scope.runId}`}/media/receipts/${receipt.id}.json`;
  const started = Date.now();
  try {
    const result = acquired ? await withObservation({ name: "media.vision", type: "span",
      metadata: { ...scope, provider: provider.id, model: provider.model, mediaJobId: receipt.id },
      result: r => ({ metadata: { providerRequestId: r.requestId, costState: r.accounting.state } }),
    }, () => provider.describe(frames, AbortSignal.any([AbortSignal.timeout(config.requestTimeoutMs), ...(args.signal ? [args.signal] : [])])))
      : await storage.getJson<VisionResult>(resultKey, { maxBytes: 4*1024*1024 });
    if (acquired) {
      await storage.putJson(resultKey, result);
      await journal.complete(receipt.id, resultKey, result.costUsd*100,
        Math.max(result.costUsd, result.accounting.reportedCostUsd ?? 0) > provider.reserveUsd, result.accounting, 0);
      recordMediaTelemetry({ provider: provider.id, model: provider.model, operation: "vision", outcome: "succeeded", durationSeconds: (Date.now()-started)/1000,
        costUsd: result.costUsd, costSource: result.accounting.state, selectedFrames: frames.length, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
    }
    if (!state.artifactLedger.read(`media-usage:${receipt.id}`)) {
      state.usageLedger.enqueue(priceAiUsageEvent({ id: receipt.id, provider: provider.id, model: provider.model, metric: "media-vision", amount: frames.length, unit: "frames",
        inputTokens: result.inputTokens, outputTokens: result.outputTokens, costCents: result.costUsd*100,
        metadata: { ...scope, mediaJobId: receipt.id, providerRequestId: result.requestId, accounting: result.accounting,
          firstSeconds: frames[0].seconds, lastSeconds: frames[frames.length-1].seconds, samplingVersion: "video-gray96-v1" } }),
        { logAiUsage: result.inputTokens !== undefined || result.outputTokens !== undefined });
      state.artifactLedger.record(`media-usage:${receipt.id}`, resultKey);
    }
    await state.store.updateProgress(state); await journal.settled(receipt.id);
    emitTelemetryLog({ severityText: result.accounting.state === "disputed" ? "warn" : "info", body: "media.vision.completed",
      attributes: { ...scope, mediaJobId: receipt.id, provider: provider.id, model: provider.model, providerRequestId: result.requestId ?? "", costState: result.accounting.state, frames: frames.length, costUsd: result.costUsd } });
    return result;
  } catch {
    await journal.uncertain(receipt.id);
    recordMediaTelemetry({ provider: provider.id, model: provider.model, operation: "vision", outcome: "uncertain", durationSeconds: (Date.now()-started)/1000 });
    throw new Error(`Video request ${receipt.id} failed; reconcile its durable receipt before retry`);
  }
}

export async function scanVideo(runner: CommandRunner, source: string, policy: VideoPolicy, signal?: AbortSignal) {
  const started=Date.now();
  const plan=await runner.videoScan(source,policy.duration,policy.scanFps);
  const data: unknown=JSON.parse((await runner.run(plan,signal)).stdout);
  if (!Array.isArray(data) || data.length>14401 || data.some(r=>!Array.isArray(r) || r.length!==5)) throw new Error("Invalid video scan output");
  const rows: VideoCandidate[]=data.map(r=>({ seconds:r[0],delta:r[1],area:r[2],tile:r[3],histogram:r[4] }));
  const selected=selectVideoFrames(rows,policy);
  recordMediaTelemetry({ provider:"local", model:"gray96-v1", operation:"video-scan", outcome:"succeeded", durationSeconds:(Date.now()-started)/1000,
    candidateFrames:rows.length,selectedFrames:selected.length });
  return { batches:packVideoFrames(selected,policy), candidateCount:rows.length, selectedCount:selected.length,
    largestGapSeconds:Math.max(...[0,...selected.map(f=>f.seconds),policy.duration].slice(1).map((t,i)=>t-[0,...selected.map(f=>f.seconds)][i])) };
}
export async function prepareVideoFrame(runner: CommandRunner, source: string, seconds: number, signal?: AbortSignal): Promise<VideoFrame> {
  // Unique per call: frame batches may be prepared while another batch is still being described.
  const output=path.join(path.dirname(source),`selected-frame-${randomUUID()}.jpg`);
  const plan=await runner.plan("ffmpeg","-nostdin","-v","error","-y","-threads","1","-protocol_whitelist","file,pipe","-format_whitelist","mov,matroska,webm,avi",
    "-ss",String(seconds),"-i",source,"-map","0:v:0","-an","-sn","-dn","-frames:v","1","-vf","scale=384:384:force_original_aspect_ratio=decrease","-q:v","5","-threads","1","-fs","200000",output);
  plan.timeoutMs=30000;
  try {
    await runner.run(plan,signal);
    if ((await stat(output)).size>200000) throw new Error("Video frame exceeds payload budget");
    return { seconds,bytes:new Uint8Array(await readFile(output)) };
  } finally { await unlink(output).catch(()=>{}); }
}

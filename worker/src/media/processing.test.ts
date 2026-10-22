import { describe, expect, it, vi } from "vitest";
import { transcribeChunk, mediaRequestKey } from "./processing.js";
import { BilledResponseError, DeepInfraDiarizationProvider, DeepInfraMediaProvider } from "./providers.js";
import { createHash } from "node:crypto";
import { mediaConfig } from "./config.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { runSpentCents } from "../pipeline/checkpoints.js";
import type { WorkspaceRun } from "../models.js";
import type { MediaJournal, MediaProvider, MediaReceipt } from "./types.js";
import type { ArtifactStore } from "../tools/storage.js";
vi.mock("@docslurp/shared/observability", async (importOriginal) => ({ ...await importOriginal<typeof import("@docslurp/shared/observability")>(), withObservation: (_: unknown, run: () => unknown) => run(), emitTelemetryLog: vi.fn(), recordMediaTelemetry: vi.fn() }));
function fixture() {
  let receipt: MediaReceipt | undefined;
  const journal: MediaJournal = {
    admit: vi.fn(async () => { if (receipt) return { receipt, acquired: false };
      receipt = { id: "receipt-id", status: "submitting", resultKey: null, costCents: null }; return { receipt, acquired: true }; }),
    complete: vi.fn(async (_id, key, cost) => { receipt = { id: "receipt-id", status: "completed", resultKey: key, costCents: cost }; }),
    settled: vi.fn(async () => {}),
    uncertain: vi.fn(async () => { if (receipt?.status === "submitting") receipt.status = "uncertain"; }),
  };
  const provider: MediaProvider = { id: "test", model: "speech", priceUsdPerMinute: .01,
    transcribe: vi.fn(async () => ({ text: "spoken", segments: [], costUsd: .0001, costSource: "provider" as const })) };
  const state = new WorkflowState({ id: "r", userId: "u", orgId: "o", workspaceId: "w", stats: {}, artifacts: {},
    spentCents: 0, pipeline: { maxCostCents: 1 } } as WorkspaceRun, []);
  state.store = { updateProgress: vi.fn(async () => {}) } as unknown as NonNullable<WorkflowState["store"]>;
  let saved: unknown;
  const storage = { putJson: vi.fn(async (_: string, value: unknown) => { saved = value; }),
    getJson: vi.fn(async () => saved) } as unknown as ArtifactStore;
  return { state, provider, journal, storage, scope: { orgId: "o", workspaceId: "w", runId: "r", documentId: "d" },
    input: { bytes: new Uint8Array([1,2]), durationSeconds: 2 }, offset: 0, config: mediaConfig({}) };
}
describe("durable media request execution", () => {
  it("replays the receipt without another paid call or duplicate run cost", async () => {
    const f = fixture(); await transcribeChunk(f); await transcribeChunk(f);
    expect(f.provider.transcribe).toHaveBeenCalledTimes(1);
    expect(f.state.usageLedger.snapshot()).toHaveLength(1);
    expect(f.state.usageLedger.snapshot()[0]).toMatchObject({ id: "receipt-id", amount: 2, unit: "audio-seconds", costCents: 0, metadata: { providerCostCents: .01, billable: false } });
    expect(runSpentCents(f.state)).toBe(0);
  });
  it("keeps cost reserved through a failed checkpoint and retries only persistence", async () => {
    const f = fixture(); vi.mocked(f.state.store!.updateProgress).mockRejectedValueOnce(new Error("database unavailable"));
    await expect(transcribeChunk(f)).rejects.toThrow("failed");
    expect(f.journal.settled).not.toHaveBeenCalled();
    await transcribeChunk(f);
    expect(f.provider.transcribe).toHaveBeenCalledTimes(1);
    expect(f.state.usageLedger.snapshot()).toHaveLength(1);
    expect(f.journal.settled).toHaveBeenCalledTimes(1);
  });
  it("holds ambiguous failures and refuses automatic resubmission", async () => {
    const f = fixture(); vi.mocked(f.provider.transcribe).mockRejectedValue(new Error("timeout"));
    await expect(transcribeChunk(f)).rejects.toThrow("failed");
    await expect(transcribeChunk(f)).rejects.toThrow("reconciliation");
    expect(f.provider.transcribe).toHaveBeenCalledTimes(1);
    expect(f.journal.uncertain).toHaveBeenCalledTimes(1);
  });
  it("makes no request when admission fails or cancellation precedes it", async () => {
    const f = fixture(); vi.mocked(f.journal.admit).mockRejectedValue(new Error("budget"));
    await expect(transcribeChunk(f)).rejects.toThrow("budget"); expect(f.provider.transcribe).not.toHaveBeenCalled();
    await expect(transcribeChunk({ ...f, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(f.journal.admit).toHaveBeenCalledTimes(1);
  });
  it("passes a video document cap to admission before dispatching audio", async () => {
    const f=fixture();vi.mocked(f.journal.admit).mockImplementation(async args => {
      if (args.maxDocumentCostCents === .001) throw new Error("document cost cap");
      throw new Error("missing document cap");
    });
    await expect(transcribeChunk({...f,maxDocumentCostCents:.001})).rejects.toThrow("document cost cap");
    expect(f.provider.transcribe).not.toHaveBeenCalled();
  });

  it("keeps the pre-overlap receipt key for plain wav chunks so in-flight runs are not re-billed after deploy", () => {
    const scope = { orgId: "o", workspaceId: "w", runId: "r", documentId: "d" };
    const provider = { id: "deepinfra", model: "m" }; const bytes = new Uint8Array([1, 2, 3]);
    const legacy = createHash("sha256").update(JSON.stringify([scope, "deepinfra", "m", 296, 308, "wav16k-v1"])).update(bytes).digest("hex");
    expect(mediaRequestKey(scope, provider, 296, { bytes, durationSeconds: 308 })).toBe(legacy);
    expect(mediaRequestKey(scope, provider, 296, { bytes, durationSeconds: 308, wordTimestamps: true })).not.toBe(legacy);
    expect(mediaRequestKey(scope, provider, 296, { bytes, durationSeconds: 308, format: "mp3" })).not.toBe(legacy);
    expect(mediaRequestKey(scope, provider, 300, { bytes, durationSeconds: 300 })).not.toBe(legacy);
  });
  it("records spend for a billed response whose body could not be used, and never pays twice", async () => {
    const f = fixture(); vi.mocked(f.provider.transcribe).mockRejectedValue(new BilledResponseError("Invalid transcript text", .0005, "req-1"));
    await expect(transcribeChunk(f)).rejects.toThrow("failed");
    expect(f.state.usageLedger.snapshot()).toHaveLength(1);
    expect(f.state.usageLedger.snapshot()[0]).toMatchObject({ unit: "audio-seconds", costCents: 0, metadata: expect.objectContaining({ providerRequestId: "req-1", costSource: "estimate", providerCostCents: .05, billable: false }) });
    await expect(transcribeChunk(f)).rejects.toThrow("reconciliation");
    expect(f.provider.transcribe).toHaveBeenCalledTimes(1);
    expect(f.state.usageLedger.snapshot()).toHaveLength(1);
  });
  it("records spend when persisting a paid response fails, without a second paid call", async () => {
    const f = fixture(); vi.mocked(f.storage.putJson).mockRejectedValueOnce(new Error("storage down"));
    await expect(transcribeChunk(f)).rejects.toThrow("failed");
    expect(f.state.usageLedger.snapshot()).toHaveLength(1);
    expect(f.journal.uncertain).toHaveBeenCalledTimes(1);
    await expect(transcribeChunk(f)).rejects.toThrow("reconciliation");
    expect(f.provider.transcribe).toHaveBeenCalledTimes(1);
  });
  it("labels diarization telemetry/usage and reserves nothing extra for it: audio minutes bill once, on transcription", async () => {
    const f = fixture();
    const diar = new DeepInfraDiarizationProvider("nvidia/Nemotron-3-Diarization", "k", vi.fn());
    const asr = new DeepInfraMediaProvider("openai/whisper-large-v3-turbo", "k", vi.fn());
    vi.spyOn(diar, "prepare").mockResolvedValue(); vi.spyOn(asr, "prepare").mockResolvedValue();
    vi.spyOn(diar, "transcribe").mockResolvedValue({ text: "", segments: [], costUsd: .036, costSource: "estimate" });
    const hour = { bytes: new Uint8Array([1]), durationSeconds: 3600, format: "mp3" as const };
    await transcribeChunk({ ...f, provider: diar, input: hour, metric: "media-diarization" });
    const reserved = vi.mocked(f.journal.admit).mock.calls[0][0].reserveCents;
    // Customers pay per audio minute (PRICE_CARD), charged with the transcription; diarization holds a token reserve.
    expect(reserved).toBeCloseTo(0.001, 9);
    vi.spyOn(asr, "transcribe").mockResolvedValue({ text: "", segments: [], costUsd: .012, costSource: "estimate" });
    await transcribeChunk({ ...f, provider: asr, input: { ...hour, bytes: new Uint8Array([2]) }, offset: 3600 });
    // Transcription reserves the customer price of the audio: 60 minutes = 60 Rich pages = 15 credits.
    expect(vi.mocked(f.journal.admit).mock.calls.at(-1)![0].reserveCents).toBeCloseTo(15, 9);
    expect(diar.reservationMultiplier).toBe(2); expect(asr.reservationMultiplier).toBe(100);
    expect(f.state.usageLedger.snapshot()[0]).toMatchObject({ metric: "media-diarization", amount: 3600 });
    const { recordMediaTelemetry } = await import("@docslurp/shared/observability");
    expect(recordMediaTelemetry).toHaveBeenCalledWith(expect.objectContaining({ operation: "diarize", outcome: "succeeded" }));
  });
});

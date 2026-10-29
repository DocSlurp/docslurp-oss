import { inspectMedia } from "./prepare.js";
import { describeVideoChunk } from "./video-processing.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractMedia } from "./extract.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import type { WorkspaceRun, Document } from "../models.js";
import type { ArtifactStore } from "../tools/storage.js";
import type { CommandRunner } from "../tools/runner.js";
import type { MediaJournal } from "./types.js";
import { allowHostedCall } from "../lib/privacy-guard.js";
import { transcribeChunk } from "./processing.js";
import { DOCUMENT_FAILURE_MARKERS } from "@docslurp/shared";
vi.mock("./rates.js", () => ({ verifyDeepInfraRate: vi.fn(async () => {}) }));
vi.mock("../lib/privacy-guard.js", () => ({ allowHostedCall: vi.fn(async () => true) }));
vi.mock("./prepare.js", () => ({ inspectMedia: vi.fn(async () => ({ duration: 301, hasAudio: true, hasVideo: false })), prepareAudioChunk: vi.fn(async () => new Uint8Array([1])), prepareDiarizationAudio: vi.fn(async () => new Uint8Array([1])) }));
vi.mock("./video-processing.js", () => ({
  scanVideo: vi.fn(async () => ({ batches: [[{seconds:0},{seconds:1}]], candidateCount:4, selectedCount:2, largestGapSeconds:1 })),
  prepareVideoFrame: vi.fn(async (_runner,_source,seconds) => ({ seconds, bytes: new Uint8Array([1]) })),
  describeVideoChunk: vi.fn(async () => ({ text: "[1s] A visible label", costUsd: .001 })),
}));
vi.mock("./processing.js", () => ({ transcribeChunk: vi.fn(async () => ({ text: "speech", segments: [{ start: 0, end: .5, text: "speech" }], costUsd: 0, costSource: "estimate" })) }));
vi.mock("../tools/storage.js", () => ({ cleanupTempFile: vi.fn(async () => {}) }));
function fixture() {
  const document = { id: "doc", userId: "user", sourceKey: "source", pageCount: 0, status: "uploaded" } as Document;
  const state = new WorkflowState({ id: "run", userId: "user", orgId: "org", workspaceId: "workspace", stats: {}, artifacts: {},
    spentCents: 0, pipeline: {} } as WorkspaceRun, [document]);
  state.store = Object.fromEntries(["startDocumentStage", "completeDocumentStage", "failDocumentStage", "updateProgress", "appendEvent"]
    .map(key => [key, vi.fn(async () => {})])) as unknown as NonNullable<WorkflowState["store"]>;
  const storage = { downloadToTempFile: vi.fn(async () => "/tmp/media/source"), putBytes: vi.fn(async () => {}), putJson: vi.fn(async () => {}), uri: (key: string) => `memory://${key}` };
  return { state, document, storage, runner: {} as CommandRunner, journal: {} as MediaJournal };
}
// Word timestamps and diarization default on; these boundary tests opt in explicitly where they need them.
beforeEach(() => { vi.stubEnv("MEDIA_WORD_TIMESTAMPS", "false"); vi.stubEnv("MEDIA_DIARIZATION", "false"); });
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); vi.mocked(allowHostedCall).mockResolvedValue(true); vi.mocked(inspectMedia).mockResolvedValue({duration:301,hasAudio:true,hasVideo:false}); });
describe("multimedia extraction pipeline boundary", () => {
  it("refuses disabled or privacy-blocked jobs before downloading or sending media", async () => {
    const f = fixture();
    vi.stubEnv("MEDIA_REMOTE_ENABLED", "false");
    await expect(extractMedia({ ...f, storage: f.storage as unknown as ArtifactStore })).rejects.toThrow("disabled");
    vi.stubEnv("MEDIA_REMOTE_ENABLED", "true"); vi.stubEnv("DEEPINFRA_API_KEY", "test");
    vi.mocked(allowHostedCall).mockResolvedValue(false);
    await expect(extractMedia({ ...f, storage: f.storage as unknown as ArtifactStore })).rejects.toThrow("privacy");
    expect(f.storage.downloadToTempFile).not.toHaveBeenCalled(); expect(transcribeChunk).not.toHaveBeenCalled();
  });
  it("publishes canonical searchable Markdown and absolute timestamps across overlapping chunks", async () => {
    vi.stubEnv("MEDIA_REMOTE_ENABLED", "true"); vi.stubEnv("MEDIA_CHUNK_OVERLAP_SECONDS", "4"); vi.stubEnv("DEEPINFRA_API_KEY", "test");
    const f = fixture(); await extractMedia({ ...f, storage: f.storage as unknown as ArtifactStore });
    expect(transcribeChunk).toHaveBeenCalledTimes(2);
    const markdown = f.storage.putBytes.mock.calls[0] as unknown as [string, Buffer];
    expect(markdown[1].toString()).toBe("[00:00] speech\n\n[04:56] speech");
    // The second window re-sends the 4 s before the 300 s boundary so a sentence is never cut.
    expect(vi.mocked(transcribeChunk).mock.calls.map(c => [c[0].offset, c[0].input.durationSeconds])).toEqual([[0, 301], [296, 5]]);
    expect(f.state.artifactLedger.read("doc:markdown")).toContain(".md");
    expect(f.storage.putJson).toHaveBeenCalledWith(expect.stringContaining(".json"), expect.objectContaining({ coverage: "audio-track-only", durationSeconds: 301 }));
    expect(f.state.documentStage("doc", "extract-markdown")?.status).toBe("completed");
  });
  it("indexes silent-video evidence with timestamps without an audio call", async () => {
    vi.stubEnv("MEDIA_REMOTE_ENABLED","true");vi.stubEnv("MEDIA_VIDEO_ENABLED","true");vi.stubEnv("DEEPINFRA_API_KEY","test");
    const f=fixture();f.state.run.pipeline.mediaVideo={enabled:true};f.journal.admitVideo=vi.fn(async()=>{});
    vi.mocked(inspectMedia).mockResolvedValue({duration:2,hasAudio:false,hasVideo:true});
    await extractMedia({...f,storage:f.storage as unknown as ArtifactStore});
    expect(transcribeChunk).not.toHaveBeenCalled();expect(describeVideoChunk).toHaveBeenCalledTimes(1);
    expect(f.journal.admitVideo).toHaveBeenCalledWith(expect.objectContaining({orgId:"org"}),2,24);
    expect(f.storage.putJson).toHaveBeenCalledWith(expect.stringContaining(".json"),expect.objectContaining({coverage:"sampled-visual-only",visualSegments:[expect.objectContaining({id:"doc:visual:0",samples:[0,1]})]}));
    const markdown=f.storage.putBytes.mock.calls[0] as unknown as [string,Buffer];expect(markdown[1].toString()).toBe("[00:00–00:01] On screen: [1s] A visible label");
    const canonical = (f.storage.putJson.mock.calls as unknown as [string, unknown][]).find(c => c[0].endsWith(".canonical.json"))![1] as { blocks: { metadata: Record<string, unknown> }[] };
    expect(canonical.blocks).toHaveLength(1);
    expect(canonical.blocks[0].metadata).toMatchObject({ mode: "shown", mediaKind: "video", startSeconds: 0, endSeconds: 1, frameSeconds: [0, 1], evidenceId: "doc:visual:0" });
  });

  it("defaults silent videos to frame reading when workspace configuration is missing", async () => {
    vi.stubEnv("MEDIA_REMOTE_ENABLED","true");vi.stubEnv("MEDIA_VIDEO_ENABLED","true");vi.stubEnv("DEEPINFRA_API_KEY","test");
    const f=fixture();f.journal.admitVideo=vi.fn(async()=>{});
    vi.mocked(inspectMedia).mockResolvedValue({duration:2,hasAudio:false,hasVideo:true});
    await extractMedia({...f,storage:f.storage as unknown as ArtifactStore});
    expect(transcribeChunk).not.toHaveBeenCalled();expect(describeVideoChunk).toHaveBeenCalledTimes(1);
    expect(f.storage.putJson).toHaveBeenCalledWith(expect.stringContaining(".json"),expect.objectContaining({coverage:"sampled-visual-only"}));
  });

  it("keeps audio-only coverage for a narrated video when explicitly disabled", async () => {
    vi.stubEnv("MEDIA_REMOTE_ENABLED","true");vi.stubEnv("MEDIA_VIDEO_ENABLED","true");vi.stubEnv("DEEPINFRA_API_KEY","test");
    const f=fixture();f.state.run.pipeline.mediaVideo={enabled:false};f.journal.admitVideo=vi.fn(async()=>{});
    vi.mocked(inspectMedia).mockResolvedValue({duration:2,hasAudio:true,hasVideo:true});
    await extractMedia({...f,storage:f.storage as unknown as ArtifactStore});
    expect(transcribeChunk).toHaveBeenCalledTimes(1);expect(describeVideoChunk).not.toHaveBeenCalled();
    expect(f.journal.admitVideo).toHaveBeenCalledWith(expect.objectContaining({orgId:"org"}),2,0);
  });

  it("fails a silent video with the public marker when the deployment has video frames off", async () => {
    vi.stubEnv("MEDIA_REMOTE_ENABLED","true");vi.stubEnv("MEDIA_VIDEO_ENABLED","false");vi.stubEnv("DEEPINFRA_API_KEY","test");
    const f=fixture();f.state.run.pipeline.mediaVideo={enabled:true};f.journal.admitVideo=vi.fn(async()=>{});
    vi.mocked(inspectMedia).mockResolvedValue({duration:2,hasAudio:false,hasVideo:true});
    vi.spyOn(console, "info").mockImplementation(() => {});vi.spyOn(console, "error").mockImplementation(() => {});
    await extractMedia({...f,storage:f.storage as unknown as ArtifactStore});
    expect(f.state.documentStage("doc","extract-markdown")).toMatchObject({status:"failed",error:DOCUMENT_FAILURE_MARKERS.silentVideo});
    expect(describeVideoChunk).not.toHaveBeenCalled();expect(f.journal.admitVideo).not.toHaveBeenCalled();
  });

  it("preflights visual privacy before any paid audio call",async()=>{
    vi.stubEnv("MEDIA_REMOTE_ENABLED","true");vi.stubEnv("MEDIA_VIDEO_ENABLED","true");vi.stubEnv("DEEPINFRA_API_KEY","test");
    const f=fixture();f.state.run.pipeline.mediaVideo={enabled:true};f.journal.admitVideo=vi.fn(async()=>{});
    vi.mocked(inspectMedia).mockResolvedValue({duration:2,hasAudio:true,hasVideo:true});
    vi.mocked(allowHostedCall).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(extractMedia({...f,storage:f.storage as unknown as ArtifactStore})).rejects.toThrow("privacy");
    expect(transcribeChunk).not.toHaveBeenCalled();
  });


  describe("diarization outcomes", () => {
    const turns = [{ start: 0, end: 301, speaker: "speaker_0" }];
    const setup = () => {
      vi.stubEnv("MEDIA_REMOTE_ENABLED", "true"); vi.stubEnv("DEEPINFRA_API_KEY", "test"); vi.stubEnv("MEDIA_DIARIZATION", "true");
      vi.spyOn(console, "warn").mockImplementation(() => {});
      return fixture();
    };
    const summaryOf = (f: ReturnType<typeof fixture>) => (f.storage.putJson.mock.calls as unknown as [string, unknown][]).find(c => c[0].endsWith(".summary.json"))![1] as Record<string, unknown>;
    it("sizes the diarization upload by the probed duration, not the last transcript segment, and reports applied", async () => {
      const f = setup();
      vi.mocked(transcribeChunk).mockImplementation((async (args: { metric?: string }) => args.metric === "media-diarization"
        ? { text: "", segments: [], speakerTurns: turns, costUsd: .0002, costSource: "estimate" }
        : { text: "speech", segments: [{ start: 0, end: .5, text: "speech" }], costUsd: 0, costSource: "estimate" }) as never);
      await extractMedia({ ...f, storage: f.storage as unknown as ArtifactStore });
      const call = vi.mocked(transcribeChunk).mock.calls.find(c => c[0].metric === "media-diarization")![0];
      expect(call.input).toMatchObject({ durationSeconds: 301, format: "mp3" });
      expect(summaryOf(f)).toMatchObject({ diarized: true, diarization: "applied" });
    });
    it("records why speakers are missing when diarization is denied by admission", async () => {
      const f = setup();
      vi.mocked(transcribeChunk).mockImplementation((async (args: { metric?: string }) => {
        if (args.metric === "media-diarization") throw new Error("Media daily budget exhausted");
        return { text: "speech", segments: [{ start: 0, end: .5, text: "speech" }], costUsd: 0, costSource: "estimate" };
      }) as never);
      await extractMedia({ ...f, storage: f.storage as unknown as ArtifactStore });
      expect(summaryOf(f)).toMatchObject({ diarized: false, diarization: "failed", diarizationReason: "admission-denied" });
      expect(f.state.documentStage("doc", "extract-markdown")?.status).toBe("completed");
    });
    it("skips with a reason in privacy mode and for unmanaged providers without a paid diarization call", async () => {
      const f = setup();
      vi.mocked(transcribeChunk).mockImplementation((async () => ({ text: "speech", segments: [{ start: 0, end: .5, text: "speech" }], costUsd: 0, costSource: "estimate" })) as never);
      vi.mocked(allowHostedCall).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      await extractMedia({ ...f, storage: f.storage as unknown as ArtifactStore });
      expect(summaryOf(f)).toMatchObject({ diarization: "skipped", diarizationReason: "privacy-mode" });
      expect(vi.mocked(transcribeChunk).mock.calls.some(c => c[0].metric === "media-diarization")).toBe(false);
      vi.clearAllMocks(); vi.stubEnv("MEDIA_PROVIDER", "huggingface"); vi.stubEnv("MEDIA_HF_ENDPOINT", "https://asr.endpoints.huggingface.cloud");
      vi.stubEnv("HF_TOKEN", "t"); vi.stubEnv("MEDIA_HF_USD_PER_MINUTE", "0.01");
      const g = fixture(); await extractMedia({ ...g, storage: g.storage as unknown as ArtifactStore });
      expect(summaryOf(g)).toMatchObject({ diarization: "skipped", diarizationReason: "unmanaged-provider" });
    });
    it("leaves the summary free of diarization fields when the feature is off", async () => {
      vi.stubEnv("MEDIA_REMOTE_ENABLED", "true"); vi.stubEnv("DEEPINFRA_API_KEY", "test");
      const f = fixture(); await extractMedia({ ...f, storage: f.storage as unknown as ArtifactStore });
      expect(summaryOf(f)).not.toHaveProperty("diarization");
    });
  });

  describe("chunk overlap per provider type", () => {
    const windows = () => vi.mocked(transcribeChunk).mock.calls.map(c => [c[0].offset, c[0].input.durationSeconds]);
    it("overlaps segment-timestamped providers by 4 s by default", async () => {
      vi.stubEnv("MEDIA_REMOTE_ENABLED", "true"); vi.stubEnv("DEEPINFRA_API_KEY", "test");
      const f = fixture(); await extractMedia({ ...f, storage: f.storage as unknown as ArtifactStore });
      expect(windows()).toEqual([[0, 301], [296, 5]]);
    });
    it("sends no extra paid audio with overlap set to 0 (matches the pre-overlap windows)", async () => {
      vi.stubEnv("MEDIA_REMOTE_ENABLED", "true"); vi.stubEnv("DEEPINFRA_API_KEY", "test"); vi.stubEnv("MEDIA_CHUNK_OVERLAP_SECONDS", "0");
      const f = fixture(); await extractMedia({ ...f, storage: f.storage as unknown as ArtifactStore });
      expect(windows()).toEqual([[0, 300], [300, 1]]);
    });
    it("does not overlap text-only providers even when overlap is configured", async () => {
      vi.stubEnv("MEDIA_REMOTE_ENABLED", "true"); vi.stubEnv("MEDIA_CHUNK_OVERLAP_SECONDS", "4"); vi.stubEnv("MEDIA_PROVIDER", "huggingface");
      vi.stubEnv("MEDIA_HF_ENDPOINT", "https://asr.endpoints.huggingface.cloud"); vi.stubEnv("HF_TOKEN", "t"); vi.stubEnv("MEDIA_HF_USD_PER_MINUTE", "0.01");
      const f = fixture(); await extractMedia({ ...f, storage: f.storage as unknown as ArtifactStore });
      expect(windows()).toEqual([[0, 300], [300, 1]]);
    });
    it("reuses the persisted plan on retry so a config change cannot re-bill paid chunks", async () => {
      vi.stubEnv("MEDIA_REMOTE_ENABLED", "true"); vi.stubEnv("DEEPINFRA_API_KEY", "test"); vi.stubEnv("MEDIA_CHUNK_OVERLAP_SECONDS", "4");
      const f = fixture();
      f.state.artifactLedger.record("media-plan:doc", "300|0|0");
      await extractMedia({ ...f, storage: f.storage as unknown as ArtifactStore });
      expect(windows()).toEqual([[0, 300], [300, 1]]);
    });
  });
});

describe("video workspace defaults and explicit disable", () => {
  it.each([
    { enabled: undefined, hasAudio: false }, { enabled: undefined, hasAudio: true },
    { enabled: true, hasAudio: false }, { enabled: true, hasAudio: true },
    { enabled: false, hasAudio: false }, { enabled: false, hasAudio: true },
  ])("enabled=$enabled, audio=$hasAudio preserves the workspace choice", async ({ enabled, hasAudio }) => {
    vi.stubEnv("MEDIA_REMOTE_ENABLED", "true");
    vi.stubEnv("MEDIA_VIDEO_ENABLED", "true");
    vi.stubEnv("DEEPINFRA_API_KEY", "test");
    const f = fixture();
    if (enabled !== undefined) f.state.run.pipeline.mediaVideo = { enabled };
    f.journal.admitVideo = vi.fn(async () => {});
    vi.mocked(inspectMedia).mockResolvedValue({ duration: 2, hasAudio, hasVideo: true });
    await extractMedia({ ...f, storage: f.storage as unknown as ArtifactStore });
    expect(describeVideoChunk).toHaveBeenCalledTimes(enabled === false ? 0 : 1);
    expect(transcribeChunk).toHaveBeenCalledTimes(hasAudio ? 1 : 0);
    if (enabled === false && !hasAudio) {
      expect(f.state.documentStage("doc", "extract-markdown")).toMatchObject({ status: "failed", error: DOCUMENT_FAILURE_MARKERS.silentVideo });
      expect(f.journal.admitVideo).not.toHaveBeenCalled();
    } else {
      expect(f.state.documentStage("doc", "extract-markdown")?.status).toBe("completed");
      expect(f.journal.admitVideo).toHaveBeenCalled();
    }
  });
  it("retains platform and durable quota gates for missing workspace configuration", async () => {
    vi.stubEnv("MEDIA_REMOTE_ENABLED", "true");
    vi.stubEnv("MEDIA_VIDEO_ENABLED", "true");
    vi.stubEnv("DEEPINFRA_API_KEY", "test");
    const f = fixture();
    f.journal.admitVideo = vi.fn(async () => { throw new Error("video quota exceeded"); });
    vi.mocked(inspectMedia).mockResolvedValue({ duration: 2, hasAudio: true, hasVideo: true });
    await extractMedia({ ...f, storage: f.storage as unknown as ArtifactStore });
    expect(describeVideoChunk).not.toHaveBeenCalled();
    expect(transcribeChunk).not.toHaveBeenCalled();
    expect(f.state.documentStage("doc", "extract-markdown")?.status).toBe("failed");
  });
});

describe("concurrent media windows", () => {
  const run = async (concurrency: string) => {
    vi.stubEnv("MEDIA_REMOTE_ENABLED", "true"); vi.stubEnv("MEDIA_CHUNK_OVERLAP_SECONDS", "4"); vi.stubEnv("DEEPINFRA_API_KEY", "test");
    vi.stubEnv("MEDIA_WINDOW_CONCURRENCY", concurrency);
    vi.mocked(inspectMedia).mockResolvedValue({ duration: 1290, hasAudio: true, hasVideo: false });
    // Later windows answer first, so completion order differs from window order.
    vi.mocked(transcribeChunk).mockImplementation((async (args: { offset: number; input: { durationSeconds: number } }) => {
      await new Promise((resolve) => setTimeout(resolve, Math.max(1, 40 - args.offset / 40)));
      return { text: `speech at ${args.offset}`, segments: [{ start: 0, end: 2, text: `speech at ${args.offset}` }], costUsd: 0.01, costSource: "estimate" };
    }) as never);
    const f = fixture();
    await extractMedia({ ...f, storage: f.storage as unknown as ArtifactStore });
    const offsets = vi.mocked(transcribeChunk).mock.calls.map((c) => c[0].offset);
    const markdown = (f.storage.putBytes.mock.calls[0] as unknown as [string, Buffer])[1].toString();
    const json = (f.storage.putJson.mock.calls as unknown as [string, unknown][]).map(([key, value]) => [key, JSON.stringify(value)]);
    vi.mocked(transcribeChunk).mockClear();
    return { offsets: [...offsets].sort((a, b) => a - b), markdown, json, status: f.state.documentStage("doc", "extract-markdown")?.status };
  };

  it("publishes identical artifacts with 1 and 4 windows in flight", async () => {
    const sequential = await run("1");
    const concurrent = await run("4");
    expect(sequential.offsets).toEqual([0, 296, 596, 896, 1196]);
    expect(concurrent).toEqual(sequential);
    expect(concurrent.status).toBe("completed");
  });

  it("fails the document after draining in-flight windows when one window fails", async () => {
    vi.stubEnv("MEDIA_REMOTE_ENABLED", "true"); vi.stubEnv("DEEPINFRA_API_KEY", "test"); vi.stubEnv("MEDIA_WINDOW_CONCURRENCY", "4");
    vi.mocked(inspectMedia).mockResolvedValue({ duration: 1290, hasAudio: true, hasVideo: false });
    let inFlight = 0;
    vi.mocked(transcribeChunk).mockImplementation((async (args: { offset: number }) => {
      inFlight++;
      try {
        await new Promise((resolve) => setTimeout(resolve, 10));
        if (args.offset === 296) throw new Error("Remote media request failed; inspect its durable receipt before retry");
        return { text: "x", segments: [], costUsd: 0, costSource: "estimate" };
      } finally { inFlight--; }
    }) as never);
    vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fixture();
    await extractMedia({ ...f, storage: f.storage as unknown as ArtifactStore }).catch(() => {});
    expect(inFlight).toBe(0);
    expect(f.state.documentStage("doc", "extract-markdown")?.status).toBe("failed");
    expect(f.storage.putBytes).not.toHaveBeenCalled();
  });
});

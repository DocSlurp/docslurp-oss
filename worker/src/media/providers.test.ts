import { describe, expect, it, vi } from "vitest";
import { DeepInfraMediaProvider, HuggingFaceMediaProvider, parseTranscription } from "./providers.js";
import { mediaConfig } from "./config.js";

describe("remote media provider boundary", () => {
  it("preserves disputed native cost separately from duration-rate charges", async () => {
    const http = vi.fn(async () => Response.json({ text: "hello", segments: [{ start: 0, end: 1, text: "hello" }],
      inference_status: { status: "succeeded", cost: 0.002, tokens_input: 3, tokens_generated: 2 } }));
    const provider = new DeepInfraMediaProvider("openai/whisper-large-v3-turbo", "test-secret", http);
    expect(await provider.transcribe({ bytes: new Uint8Array([1]), durationSeconds: 2 }, new AbortController().signal))
      .toMatchObject({ costSource: "estimate", pricingMismatch: true, inputTokens: 3, outputTokens: 2, accounting: { state: "disputed", reportedCostUsd: .002, estimatedCostUsd: .00000666 } });
    const [url, options] = (http.mock.calls as unknown as [string, RequestInit][])[0];
    expect(url).toBe("https://api.deepinfra.com/v1/inference/openai/whisper-large-v3-turbo");
    expect(options.redirect).toBe("error"); expect(options.body).toBeInstanceOf(FormData);
  });
  it("does not print upstream bodies or retry a failure", async () => {
    const http = vi.fn(async () => new Response("private text or key", { status: 429 }));
    const provider = new DeepInfraMediaProvider("openai/whisper-large-v3", "test", http);
    await expect(provider.transcribe({ bytes: new Uint8Array(), durationSeconds: 1 }, new AbortController().signal)).rejects.toThrow("HTTP 429");
    expect(http).toHaveBeenCalledTimes(1);
  });
  it("rejects invalid timestamps and distinguishes estimates", () => {
    expect(() => parseTranscription({ text: "x", segments: [{ start: 4, end: 2, text: "x" }] }, 10, .01)).toThrow();
    expect(parseTranscription({ text: "x" }, 10, .01)).toMatchObject({ costSource: "estimate", costUsd: .01, segments: [] });
    expect(() => new HuggingFaceMediaProvider("x", "https://evil.example", "k", 1)).toThrow();
    expect(() => new DeepInfraMediaProvider("unknown/model", "k")).toThrow();
    expect(() => mediaConfig({ MEDIA_MAX_CONCURRENT: "NaN" })).toThrow();
  });
});

describe("precision options", () => {
  it("requests word timestamps only when asked and sends diarization audio as mp3", async () => {
    const http = vi.fn(async () => Response.json({ text: "", segments: [], speaker_segments: [{ start: 0, end: 1, speaker: "speaker_0" }], inference_status: { status: "succeeded" } }));
    const { DeepInfraDiarizationProvider } = await import("./providers.js");
    const asr = new DeepInfraMediaProvider("openai/whisper-large-v3-turbo", "k", http);
    await asr.transcribe({ bytes: new Uint8Array([1]), durationSeconds: 1 }, new AbortController().signal);
    await asr.transcribe({ bytes: new Uint8Array([1]), durationSeconds: 1, wordTimestamps: true }, new AbortController().signal);
    const forms = (http.mock.calls as unknown as [string, { body: FormData }][]).map(c => c[1].body);
    expect(forms[0].get("chunk_level")).toBeNull(); expect(forms[1].get("chunk_level")).toBe("word");
    const diar = new DeepInfraDiarizationProvider("nvidia/Nemotron-3-Diarization", "k", http);
    expect(diar.priceUsdPerMinute).toBeCloseTo(0.0006);
    const result = await diar.transcribe({ bytes: new Uint8Array([1]), durationSeconds: 60, format: "mp3" }, new AbortController().signal);
    expect(result.speakerTurns).toEqual([{ start: 0, end: 1, speaker: "speaker_0" }]);
    const body = (http.mock.calls.at(-1) as unknown as [string, { body: FormData }])[1].body;
    expect((body.get("audio") as File).name).toBe("audio.mp3");
  });
  it("defaults the precision features on and lets each be turned off", () => {
    expect(mediaConfig({})).toMatchObject({ wordTimestamps: true, diarization: { enabled: true }, chunkOverlapSeconds: 4 });
    expect(mediaConfig({ MEDIA_DIARIZATION: "false", MEDIA_WORD_TIMESTAMPS: "false", MEDIA_CHUNK_OVERLAP_SECONDS: "0" }))
      .toMatchObject({ wordTimestamps: false, diarization: { enabled: false }, chunkOverlapSeconds: 0 });
  });
});

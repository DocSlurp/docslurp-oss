import { instrumentFetch } from "@docslurp/shared/observability";
import { jsonResponse } from "./http.js";
export { jsonResponse } from "./http.js";
import { verifyDeepInfraRate } from "./rates.js";
import { disputed, MEDIA_RATE_VERSION } from "./accounting.js";
import type { AudioInput, MediaProvider, SpeakerTurn, Transcription, TranscriptSegment, TranscriptWord } from "./types.js";

// Official metadata checked 2026-10-13. Native speech cost units are disputed; preserve raw evidence.
export const deepinfraSpeechPrices: Record<string, number> = {
  "openai/whisper-large-v3-turbo": 0.0001998,
  "openai/whisper-large-v3": 0.00045,
};
/** Speaker diarization (who spoke when), billed per input second: 0.001 cents/s = $0.036/hour (catalog read 2026-10-13). */
export const deepinfraDiarizationPrices: Record<string, number> = {
  "nvidia/Nemotron-3-Diarization": 0.0006,
};
/** The provider answered successfully (so the request is billable) but the body was unusable. Callers still record the estimated spend. */
export class BilledResponseError extends Error {
  constructor(message: string, readonly expectedCostUsd: number, readonly requestId?: string) { super(message); this.name = "BilledResponseError"; }
}
/** Parse a successful provider response; any failure keeps the estimated cost attached so the spend is not lost. */
function parseBilled(body: unknown, duration: number, expectedCostUsd: number, response: Response): Transcription {
  try { return parseTranscription(body, duration, expectedCostUsd); } catch (error) {
    throw new BilledResponseError(error instanceof Error ? error.message : "Invalid transcription response", expectedCostUsd,
      response.headers.get("x-request-id")?.slice(0, 200));
  }
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
/**
 * Word timestamps and speaker turns are optional enhancements to an already-paid response. They are parsed
 * leniently: bad items are dropped or clamped, never thrown, so one odd timestamp cannot fail required
 * transcription or strand a billed receipt. Segment timing remains the fallback.
 */
const MAX_WORDS = 200000;
const MAX_TURNS = 100000;
/** Attach each word to the segment that contains its midpoint. Returns the number of words dropped. */
function attachWords(segments: TranscriptSegment[], raw: unknown, duration: number): number {
  if (!Array.isArray(raw) || !raw.length || !segments.length) return 0;
  if (raw.length > MAX_WORDS) return raw.length;
  const words: TranscriptWord[] = [];
  let dropped = 0;
  for (const item of raw as Array<Record<string, unknown> | null>) {
    const start = item?.start; const end = item?.end; const text = item?.word ?? item?.text;
    if (!finite(start) || !finite(end) || typeof text !== "string" || start >= duration + 2 || end < start) { dropped++; continue; }
    const clean = text.trim();
    if (!clean) continue;
    words.push({ start: Math.min(start, duration), end: Math.min(end, duration), text: clean });
  }
  words.sort((a, b) => a.start - b.start);
  let index = 0;
  for (const word of words) {
    const mid = (word.start + word.end) / 2;
    while (index < segments.length - 1 && mid >= segments[index + 1].start - 1e-6) index++;
    (segments[index].words ??= []).push(word);
  }
  return dropped;
}
/** Valid turns are clamped to the audio length (providers may report a trailing turn past it); invalid ones are dropped. */
export function parseSpeakerTurns(raw: unknown, duration: number): SpeakerTurn[] | undefined {
  if (!Array.isArray(raw) || raw.length > MAX_TURNS) return undefined;
  const turns: SpeakerTurn[] = [];
  for (const item of raw as Array<Record<string, unknown> | null>) {
    const start = item?.start; const end = item?.end; const speaker = item?.speaker;
    if (!finite(start) || !finite(end) || end < start || start >= duration || typeof speaker !== "string" || !speaker || speaker.length > 64) continue;
    turns.push({ start, end: Math.min(end, duration), speaker });
  }
  return turns;
}
export function parseTranscription(value: unknown, duration: number, estimateUsd: number): Transcription {
  if (!value || typeof value !== "object") throw new Error("Invalid transcription response");
  const data = value as Record<string, unknown>;
  if (typeof data.text !== "string" || data.text.length > 1_000_000) throw new Error("Invalid transcript text");
  const segments: TranscriptSegment[] = [];
  const items = data.segments ?? data.chunks ?? [];
  if (!Array.isArray(items) || items.length > 20000) throw new Error("Invalid transcript segments");
  for (const item of items) {
    const start = item.start ?? item.timestamp?.[0];
    const end = item.end ?? item.timestamp?.[1];
    if (!finite(start) || !finite(end) || end < start || end > duration + 2 || typeof item.text !== "string") {
      throw new Error("Invalid transcript timestamp");
    }
    segments.push({ start, end: Math.min(end, duration), text: item.text });
  }
  attachWords(segments, data.words, duration);
  const speakerTurns = parseSpeakerTurns(data.speaker_segments, duration);
  // Text-only providers retain a coarse whole-chunk interval, explicitly labeled downstream.
  const status = data.inference_status as Record<string, unknown> | undefined;
  if (status?.status && !["succeeded", "success", "completed"].includes(String(status.status))) {
    throw new Error("Provider inference did not succeed");
  }
  return { text: data.text, segments, ...(speakerTurns ? { speakerTurns } : {}),
    ...(typeof data.language === "string" ? { language: data.language.slice(0, 32) } : {}),
    ...(typeof data.request_id === "string" ? { requestId: data.request_id.slice(0, 200) } : {}),
    costUsd: finite(status?.cost) ? status.cost : estimateUsd,
    costSource: finite(status?.cost) ? "provider" : "estimate",
    ...(finite(status?.tokens_input) ? { inputTokens: status.tokens_input } : {}),
    ...(finite(status?.tokens_generated) ? { outputTokens: status.tokens_generated } : {}),
  };
}
export class DeepInfraMediaProvider implements MediaProvider {
  readonly id = "deepinfra";
  readonly reservationMultiplier: number = 100;
  /** whisper responses carry segment timestamps, so overlapping windows can be de-duplicated exactly. */
  readonly supportsSegments: boolean = true;
  readonly priceUsdPerMinute: number;
  constructor(readonly model: string, private readonly key: string, private readonly http: typeof fetch = fetch,
    prices: Record<string, number> = deepinfraSpeechPrices) {
    this.priceUsdPerMinute = prices[model];
    if (!this.priceUsdPerMinute || !key) throw new Error("DeepInfra speech model or credential is not configured");
  }
  async prepare(): Promise<void> { await verifyDeepInfraRate(this.model, { perSecondCents: this.priceUsdPerMinute * 100 / 60 }); }
  async transcribe(input: AudioInput, signal: AbortSignal): Promise<Transcription> {
    const form = new FormData();
    const mp3 = input.format === "mp3";
    form.set("audio", new Blob([Uint8Array.from(input.bytes)], { type: mp3 ? "audio/mpeg" : "audio/wav" }), mp3 ? "audio.mp3" : "audio.wav");
    if (input.wordTimestamps) form.set("chunk_level", "word");
    const response = await instrumentFetch(this.id, "transcribe", this.http)(`https://api.deepinfra.com/v1/inference/${this.model}`, {
      method: "POST", headers: { Authorization: `Bearer ${this.key}` }, body: form, signal, redirect: "error",
    });
    const expectedCostUsd = input.durationSeconds / 60 * this.priceUsdPerMinute;
    const result = parseBilled(await jsonResponse(response), input.durationSeconds, expectedCostUsd, response);
    // The official native schema labels cost USD. Never silently rescale a discrepant field.
    const reported = result.costSource === "provider" ? result.costUsd : undefined;
    const mismatch = disputed(reported, expectedCostUsd);
    const requestId = result.requestId ?? response.headers.get("x-request-id")?.slice(0, 200);
    return { ...result, requestId, costUsd: expectedCostUsd, costSource: "estimate", expectedCostUsd,
      pricingMismatch: mismatch, accounting: { state: mismatch ? "disputed" : "estimated", basis: "input-seconds",
        rateVersion: MEDIA_RATE_VERSION, rateSource: `https://api.deepinfra.com/models/${this.model}`,
        reportedCostUsd: reported, estimatedCostUsd: expectedCostUsd, providerRequestId: requestId,
        inputTokens: result.inputTokens, outputTokens: result.outputTokens } };
  }
}
/**
 * Speaker diarization on the DeepInfra transcription endpoint. It returns `speaker_segments`
 * with arrival-ordered labels (speaker_0, speaker_1, ...) that are consistent within one request,
 * so send a whole document, not independent chunks.
 */
export class DeepInfraDiarizationProvider extends DeepInfraMediaProvider {
  /**
   * Diarization is billed per input second at a verified list price; the ASR native-unit dispute that justifies the
   * 100x ASR reservation does not apply. 2x covers rounding and a modest price drift without making a 2 h recording
   * (about 14 cents reserved) inadmissible under the default daily budget.
   */
  override readonly reservationMultiplier: number = 2;
  override readonly supportsSegments: boolean = false;
  constructor(model: string, key: string, http: typeof fetch = fetch) {
    super(model, key, http, deepinfraDiarizationPrices);
  }
}
/** Dedicated HF ASR endpoint; lifecycle may be managed independently by the capacity controller. */
export class HuggingFaceMediaProvider implements MediaProvider {
  readonly id = "huggingface";
  /** Response shape is endpoint-defined; do not assume segment timestamps, so no overlap is sent. */
  readonly supportsSegments = false;
  constructor(readonly model: string, private readonly endpoint: string, private readonly key: string,
    readonly priceUsdPerMinute: number, private readonly http: typeof fetch = fetch) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".endpoints.huggingface.cloud") || url.username || url.password || url.search || url.hash) {
      throw new Error("Expected an authenticated Hugging Face inference endpoint");
    }
    if (!key || !finite(priceUsdPerMinute) || priceUsdPerMinute === 0) throw new Error("HF credential and verified price required");
  }
  async transcribe(input: AudioInput, signal: AbortSignal): Promise<Transcription> {
    const response = await instrumentFetch(this.id, "transcribe", this.http)(this.endpoint, { method: "POST", signal, redirect: "error",
      headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "audio/wav" }, body: Uint8Array.from(input.bytes) });
    const expectedCostUsd = input.durationSeconds / 60 * this.priceUsdPerMinute;
    const result = parseBilled(await jsonResponse(response), input.durationSeconds, expectedCostUsd, response);
    const reported = result.costSource === "provider" ? result.costUsd : undefined;
    const requestId = result.requestId ?? response.headers.get("x-request-id")?.slice(0, 200);
    const mismatch = disputed(reported, expectedCostUsd);
    return { ...result, requestId, costUsd: expectedCostUsd, costSource: "estimate", expectedCostUsd, pricingMismatch: mismatch,
      accounting: { state: mismatch ? "disputed" : "estimated", basis: "input-seconds", rateVersion: "operator-configured",
        rateSource: "MEDIA_HF_USD_PER_MINUTE", reportedCostUsd: reported, estimatedCostUsd: expectedCostUsd, providerRequestId: requestId,
        inputTokens: result.inputTokens, outputTokens: result.outputTokens } };
  }
}
export class MediaProviderRegistry {
  private readonly providers = new Map<string, MediaProvider>();
  register(provider: MediaProvider): this {
    if (this.providers.has(provider.id)) throw new Error(`Duplicate media provider: ${provider.id}`);
    this.providers.set(provider.id, provider); return this;
  }
  resolve(id: string): MediaProvider { const provider = this.providers.get(id);
    if (!provider) throw new Error(`Media provider is not configured: ${id}`); return provider;
  }
}
export async function configuredMediaProvider(provider: string, model: string, env: NodeJS.ProcessEnv = process.env): Promise<MediaProvider> {
  const registry = new MediaProviderRegistry();
  if (provider === "deepinfra") await verifyDeepInfraRate(model, { perSecondCents: (deepinfraSpeechPrices[model] ?? NaN) * 100 / 60 });
  if (provider === "deepinfra") registry.register(new DeepInfraMediaProvider(model, env.DEEPINFRA_API_KEY ?? env.DEEPINFRA_TOKEN ?? ""));
  if (provider === "huggingface") registry.register(new HuggingFaceMediaProvider(model, env.MEDIA_HF_ENDPOINT ?? "", env.HF_TOKEN ?? "", Number(env.MEDIA_HF_USD_PER_MINUTE)));
  return registry.resolve(provider);
}

/** Diarization provider for the configured model; callers record spend through the same journal as transcription. */
export async function configuredDiarizationProvider(model: string, env: NodeJS.ProcessEnv = process.env): Promise<MediaProvider> {
  await verifyDeepInfraRate(model, { perSecondCents: (deepinfraDiarizationPrices[model] ?? NaN) * 100 / 60 });
  return new DeepInfraDiarizationProvider(model, env.DEEPINFRA_API_KEY ?? env.DEEPINFRA_TOKEN ?? "");
}

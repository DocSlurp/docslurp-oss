import { startTelemetrySpan } from "@docslurp/shared/observability";
import { assertCanSpend } from "../services/billing/spend-guard.js";
import { MastraVoice } from "@mastra/core/voice";
import { z } from "zod";
import { assertProviderAllowed, authorizePrivateModelCall, isPrivateModelUri, lookupPrivateModelRoute, privacyModeAllowsHosted, readProviderCharge, type PrivacyMode } from "@docslurp/shared";
import { CHAT_VOICE_MODEL, CHAT_VOICE_MAX_BYTES } from "@docslurp/shared/chat-voice";
import { recordUsageEvent, type UsageScope } from "./ai-usage.js";
import { resolveOpenRouterApiKey } from "./ai.js";
import { allowHostedCallForWorkspace, openRouterCall } from "./privacy.js";

export class ChatVoiceError extends Error {
  constructor(message: string, public status: 400 | 403 | 413 | 415 | 502 | 503, options?: ErrorOptions) {
    super(message, options);
  }
}

const transcriptionSchema = z.object({
  text: z.string(),
  usage: z.object({
    seconds: z.number().nonnegative(),
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    cost: z.number().nonnegative(),
  }).passthrough(),
});

const privateTranscriptionSchema = z.object({
  text: z.string(),
  usage: z.object({
    seconds: z.number().nonnegative().optional(),
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
  }).passthrough().optional(),
  duration: z.number().nonnegative().optional(),
}).passthrough();

/**
 * Operator speech-to-text route for workspaces that forbid hosted providers:
 * `DOCSLURP_PRIVATE_STT_MODEL` when it names a registered `stt` model.
 * Standard workspaces keep the hosted route.
 */
export function privateSttModelFor(privacyMode: PrivacyMode): string | undefined {
  if (privacyModeAllowsHosted(privacyMode)) return undefined;
  const model = process.env.DOCSLURP_PRIVATE_STT_MODEL?.trim();
  return model && isPrivateModelUri(model) && lookupPrivateModelRoute({ ref: model, capability: "stt" }).ok ? model : undefined;
}

/** Duration of a PCM WAV recording from its header, for usage when the server reports none. */
export function wavDurationSeconds(bytes: Uint8Array): number | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 44 || view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) return undefined;
  let offset = 12;
  let byteRate = 0;
  while (offset + 8 <= bytes.byteLength) {
    const id = view.getUint32(offset, false);
    const size = view.getUint32(offset + 4, true);
    if (id === 0x666d7420 && offset + 16 <= bytes.byteLength) byteRate = view.getUint32(offset + 16, true);
    if (id === 0x64617461) return byteRate > 0 ? Math.min(size, bytes.byteLength - offset - 8) / byteRate : undefined;
    offset += 8 + size + (size % 2);
  }
  return undefined;
}

const RECORDING_FORMATS: Record<string, string> = {
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/webm": "webm", "audio/mp4": "m4a",
};
function recordingFormat(audio: Blob): string | undefined {
  return RECORDING_FORMATS[audio.type.split(";")[0].trim().toLowerCase()];
}

function validateRecording(audio: unknown, wavOnly = false): Blob {
  if (!(audio instanceof Blob) || audio.size === 0) throw new ChatVoiceError("Record some audio first.", 400);
  if (audio.size > CHAT_VOICE_MAX_BYTES) throw new ChatVoiceError("Recording exceeds the 8 MB limit.", 413);
  if (!recordingFormat(audio) || (wavOnly && recordingFormat(audio) !== "wav")) {
    throw new ChatVoiceError("Unsupported recording format. Use PCM WAV audio.", 415);
  }
  return audio;
}

/** Mastra's text-only listen contract, with provider usage persisted before returning.
 * A request-scoped adapter preserves JSON usage that text-only voice providers drop.
 */
export class WorkspaceChatVoice extends MastraVoice {
  constructor(
    private readonly context: { userId: string; scope: UsageScope },
    /** Speech-to-text is hosted-only, so non-standard privacy modes disable it. */
    private readonly privacyMode: PrivacyMode,
  ) {
    super({ name: "workspace-chat-voice", listeningModel: { name: CHAT_VOICE_MODEL } });
  }

  async getListener() {
    return {
      enabled: Boolean(privateSttModelFor(this.privacyMode))
        || (Boolean(resolveOpenRouterApiKey()?.trim()) && privacyModeAllowsHosted(this.privacyMode)),
    };
  }

  async speak(): Promise<never> {
    throw new Error("Workspace voice supports speech input only");
  }

  async listen(audio: unknown): Promise<string> {
    const privateModel = privateSttModelFor(this.privacyMode);
    if (privateModel) return await this.listenPrivate(validateRecording(audio, true), privateModel);
    const apiKey = resolveOpenRouterApiKey()?.trim();
    if (!apiKey) throw new ChatVoiceError("Voice input is not configured. You can still type your message.", 503);
    // Audio is workspace input; refuse before reading it when the workspace forbids hosted providers.
    if (!(await allowHostedCallForWorkspace({
      privacyMode: this.privacyMode,
      workspaceId: this.context.scope.workspaceId ?? null,
      call: openRouterCall("api.chat.transcription", CHAT_VOICE_MODEL),
    }))) {
      throw new ChatVoiceError(
        `Voice input is unavailable because this workspace's privacy mode (${this.privacyMode}) does not allow hosted speech-to-text. You can still type your message.`,
        403,
      );
    }
    assertProviderAllowed(this.privacyMode, { provider: "openrouter", model: CHAT_VOICE_MODEL, operation: "api.chat.transcription", target: "hosted" });
    audio = validateRecording(audio);
    if (!(audio instanceof Blob)) throw new ChatVoiceError("Record some audio first.", 400);

    await assertCanSpend(this.context.scope.orgId, this.context.scope.workspaceId);
    const body = JSON.stringify({
      model: CHAT_VOICE_MODEL,
      input_audio: { data: Buffer.from(await audio.arrayBuffer()).toString("base64"), format: recordingFormat(audio) },
      response_format: "json",
    });
    const providerStarted = performance.now();
    const span = startTelemetrySpan("docslurp.chat", "chat.transcribe.provider", {
      "gen_ai.request.model": CHAT_VOICE_MODEL, "docslurp.audio.bytes": audio.size,
      "docslurp.audio.format": recordingFormat(audio),
    }, { kind: "client" });
    let response: Response;
    try {
      response = await span.run(() => fetch("https://openrouter.ai/api/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(60_000),
      }));
      span.set({ "http.response.status_code": response.status });
      span.end(response.ok ? undefined : new Error("SpeechProviderError"));
    } catch (cause) {
      span.end(cause);
      throw new ChatVoiceError("Transcription could not connect. Try again or type your message.", 502, { cause });
    }
    if (!response.ok) {
      console.error(`[chat-voice] transcription_failed model=${CHAT_VOICE_MODEL} status=${response.status}`);
      throw new ChatVoiceError("Transcription is unavailable. Try again or type your message.", 502, {
        cause: new Error(`Speech provider HTTP ${response.status}: ${(await response.text().catch(() => "unreadable response")).slice(0, 16000)}`),
      });
    }
    const parsed = transcriptionSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ChatVoiceError("Transcription returned an incomplete response.", 502, { cause: parsed.error });
    const { text, usage } = parsed.data;
    const charge = readProviderCharge(usage);
    if (charge.costCents === undefined) throw new ChatVoiceError("Transcription returned incomplete usage accounting.", 502);
    await recordUsageEvent({
      ...this.context,
      usage: {
        provider: "openrouter",
        model: CHAT_VOICE_MODEL,
        metric: "chat.transcription",
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        amount: usage.seconds,
        unit: "second",
        costCents: charge.costCents,
        metadata: {
          ...charge.metadata,
          generationId: response.headers.get("x-generation-id"),
          tokenUsageReported: usage.input_tokens !== undefined && usage.output_tokens !== undefined,
          audioBytes: audio.size,
          audioFormat: recordingFormat(audio),
          providerResponseMs: Math.round(performance.now() - providerStarted),
        },
      },
    });
    return text.trim();
  }

  /**
   * OpenAI-compatible `/audio/transcriptions` on the operator's private
   * endpoint (multipart upload). Strict-privacy writes the audit row first.
   */
  private async listenPrivate(audio: Blob, modelUri: string): Promise<string> {
    let call: Awaited<ReturnType<typeof authorizePrivateModelCall>>;
    try {
      call = await authorizePrivateModelCall({
        privacyMode: this.privacyMode,
        modelUri,
        capability: "stt",
        operation: "api.chat.transcription",
        auditScope: { workspaceId: this.context.scope.workspaceId ?? null },
      });
    } catch (error) {
      console.error(`[chat-voice] private_transcription_refused model=${modelUri} error=${error instanceof Error ? error.message : String(error)}`);
      throw new ChatVoiceError("Voice input is unavailable. You can still type your message.", 503, { cause: error });
    }
    await assertCanSpend(this.context.scope.orgId, this.context.scope.workspaceId);
    const bytes = new Uint8Array(await audio.arrayBuffer());
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "audio/wav" }), "recording.wav");
    form.append("model", call.model);
    form.append("response_format", "json");
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await call.fetch(`${call.baseUrl}/audio/transcriptions`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    } catch (cause) {
      throw new ChatVoiceError("Transcription could not connect. Try again or type your message.", 502, { cause });
    }
    if (!response.ok) {
      console.error(`[chat-voice] transcription_failed provider=private alias=${call.route.alias} model=${call.model} status=${response.status}`);
      throw new ChatVoiceError("Transcription is unavailable. Try again or type your message.", 502, {
        cause: new Error(`Speech provider HTTP ${response.status}: ${(await response.text().catch(() => "unreadable response")).slice(0, 16000)}`),
      });
    }
    const parsed = privateTranscriptionSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new ChatVoiceError("Transcription returned an incomplete response.", 502, { cause: parsed.error });
    const { text, usage } = parsed.data;
    const inputTokens = usage?.input_tokens ?? usage?.prompt_tokens;
    const outputTokens = usage?.output_tokens ?? usage?.completion_tokens;
    const reportedSeconds = usage?.seconds ?? parsed.data.duration;
    const seconds = reportedSeconds ?? wavDurationSeconds(bytes) ?? 0;
    const cost = call.cost({ inputTokens, outputTokens, durationMs: Date.now() - startedAt });
    await recordUsageEvent({
      ...this.context,
      usage: {
        provider: call.provider,
        model: call.usageModel,
        metric: "chat.transcription",
        inputTokens,
        outputTokens,
        amount: seconds,
        unit: "second",
        costCents: cost.costCents,
        metadata: {
          ...cost.metadata,
          servedModel: call.model,
          secondsSource: reportedSeconds !== undefined ? "provider" : "wav-header",
          tokenUsageReported: inputTokens !== undefined && outputTokens !== undefined,
          audioBytes: audio.size,
        },
      },
    });
    return text.trim();
  }
}

import { parseProviderModelUri } from "@docslurp/shared";
export interface MediaConfig {
  enabled: boolean; provider: string; model: string; maxDurationSeconds: number;
  maxSourceBytes: number; chunkSeconds: number; requestTimeoutMs: number;
  maxConcurrent: number; dailyBudgetCents: number;
  /** Seconds of audio re-sent on each side of a chunk boundary so sentences are never cut. */
  chunkOverlapSeconds: number;
  /** Ask the speech provider for word timestamps (default off: measured ~1.7x slower ASR). */
  wordTimestamps: boolean;
  /** Label speaker turns with a diarization model (default off: adds a paid call per document). */
  diarization: { enabled: boolean; model: string };
}
function positive(env: NodeJS.ProcessEnv, name: string, fallback: number, maximum: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0 || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
function nonNegative(env: NodeJS.ProcessEnv, name: string, fallback: number, maximum: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0 || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
}
/**
 * MEDIA_TRANSCRIPTION_MODEL is a provider model id or `llm://<provider>/<model>`
 * (e.g. llm://deepinfra/openai/whisper-large-v3-turbo), whose provider then
 * stands in for MEDIA_PROVIDER. A URI naming a different provider than an
 * explicit MEDIA_PROVIDER is a configuration error.
 */
function mediaModelSetting(env: NodeJS.ProcessEnv): { provider: string; model: string } {
  const raw = env.MEDIA_TRANSCRIPTION_MODEL?.trim();
  const uri = parseProviderModelUri(raw);
  if (uri) {
    const explicit = env.MEDIA_PROVIDER?.trim();
    if (explicit && explicit !== uri.provider) throw new Error(`MEDIA_TRANSCRIPTION_MODEL names provider ${uri.provider} but MEDIA_PROVIDER is ${explicit}`);
    return { provider: uri.provider, model: uri.model };
  }
  if (raw?.toLowerCase().startsWith("llm://")) throw new Error("MEDIA_TRANSCRIPTION_MODEL must be llm://<provider>/<model> or a provider model id");
  return { provider: env.MEDIA_PROVIDER ?? "deepinfra", model: raw || "openai/whisper-large-v3-turbo" };
}
export function mediaConfig(env: NodeJS.ProcessEnv = process.env): MediaConfig {
  return {
    enabled: env.MEDIA_REMOTE_ENABLED === "true",
    ...mediaModelSetting(env),
    maxDurationSeconds: positive(env, "MEDIA_MAX_DURATION_SECONDS", 7200, 14400),
    maxSourceBytes: positive(env, "MEDIA_MAX_SOURCE_BYTES", 128 * 1024 * 1024, 1024 * 1024 * 1024),
    chunkSeconds: positive(env, "MEDIA_CHUNK_SECONDS", 300, 600),
    requestTimeoutMs: positive(env, "MEDIA_REQUEST_TIMEOUT_MS", 180000, 600000),
    maxConcurrent: Math.floor(positive(env, "MEDIA_MAX_CONCURRENT", 4, 100)),
    dailyBudgetCents: positive(env, "MEDIA_DAILY_BUDGET_CENTS", 500, 1000000),
    chunkOverlapSeconds: nonNegative(env, "MEDIA_CHUNK_OVERLAP_SECONDS", 4, 10),
    wordTimestamps: env.MEDIA_WORD_TIMESTAMPS !== "false",
    diarization: { enabled: env.MEDIA_DIARIZATION !== "false", model: env.MEDIA_DIARIZATION_MODEL ?? "nvidia/Nemotron-3-Diarization" },
  };
}

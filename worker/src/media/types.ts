import type { MediaAccounting } from "./accounting.js";
/** Provider transport and billable capacity are deliberately separate contracts. */
export interface MediaScope {
  orgId: string; workspaceId: string; runId: string; documentId: string;
}
export interface AudioInput {
  bytes: Uint8Array; durationSeconds: number;
  /** Container of `bytes`; defaults to 16 kHz mono WAV. */
  format?: "wav" | "mp3";
  /** Request word-level timestamps when the provider supports them. */
  wordTimestamps?: boolean;
}
export interface TranscriptWord { start: number; end: number; text: string; }
/** `timing`: word = bounds come from word timestamps, segment = provider segment timestamps, chunk = only the audio window is known. */
export interface TranscriptSegment { start: number; end: number; text: string; speaker?: string; words?: TranscriptWord[]; }
export type SegmentTiming = "word" | "segment" | "chunk";
/** One diarized stretch of speech; `speaker` is a provider label such as "speaker_0". */
export interface SpeakerTurn { start: number; end: number; speaker: string; }
export interface Transcription {
  text: string; segments: TranscriptSegment[]; speakerTurns?: SpeakerTurn[]; language?: string; requestId?: string;
  accounting?: MediaAccounting;
  costUsd: number; costSource: "provider" | "estimate"; pricingMismatch?: boolean; expectedCostUsd?: number; inputTokens?: number; outputTokens?: number;
}
export interface MediaProvider {
  readonly id: string;
  readonly model: string;
  readonly priceUsdPerMinute: number;
  /** Upper billing exposure when the native cost unit is disputed. */
  readonly reservationMultiplier?: number;
  /** True only when responses carry segment/word timestamps, which chunk overlap needs to de-duplicate text. */
  readonly supportsSegments?: boolean;
  /** No automatic retry: a lost response may already have incurred a charge. */
  prepare?(): Promise<void>;
  transcribe(input: AudioInput, signal: AbortSignal): Promise<Transcription>;
}
export interface MediaReceipt {
  id: string; status: "submitting" | "completed" | "uncertain";
  resultKey: string | null; costCents: number | null;
}
export interface MediaJournal {
  /** Atomically checks spend/concurrency and creates one durable admission. */
  admit(args: { scope: MediaScope; key: string; provider: string; model: string;
    reserveCents: number; maxRunCostCents: number | null; maxConcurrent: number; dailyBudgetCents: number; maxDocumentCostCents?: number;
  }): Promise<{ receipt: MediaReceipt; acquired: boolean }>;
  complete(id: string, resultKey: string, costCents: number, pricingMismatch?: boolean, accounting?: MediaAccounting, chargedCostCents?: number): Promise<void>;
  admitVideo?(scope: MediaScope, durationSeconds: number, frames: number): Promise<void>;
  settled(id: string): Promise<void>;
  uncertain(id: string): Promise<void>;
}

import { z } from "zod";

/**
 * Per-recording stats shown in the media focus view ("This recording"). Computed at ingest and stored
 * in the media sidecar; exposed additively on the document detail response as `media`.
 */
export const mediaSummarySchema = z.object({
  mediaKind: z.enum(["audio", "video"]).default("audio"),
  durationSeconds: z.number().nonnegative(),
  wordCount: z.number().int().nonnegative(),
  /** Distinct diarized speakers; 0 when diarization was not run. */
  speakerCount: z.number().int().nonnegative(),
  segmentCount: z.number().int().nonnegative(),
  /** Sampled video frames sent to the vision model. */
  keyframesIndexed: z.number().int().nonnegative(),
  /** Sampled frames whose description reports legible on-screen text (heuristic on the description). */
  framesWithText: z.number().int().nonnegative(),
  coverage: z.enum(["audio-track-only", "audio-and-sampled-visual", "sampled-visual-only"]),
  /** Provider cost of transcription, diarization and vision for this recording, in cents (before margin). */
  ingestCostCents: z.number().nonnegative(),
  /** Finest transcript timing available: word, segment or chunk. */
  timing: z.enum(["word", "segment", "chunk"]).default("segment"),
  diarized: z.boolean().default(false),
  /** Present only when diarization was requested: whether it labelled speakers, was skipped, or failed (and a short non-content reason). */
  diarization: z.enum(["applied", "skipped", "failed"]).optional(),
  diarizationReason: z.string().max(200).optional(),
});
export type MediaSummary = z.infer<typeof mediaSummarySchema>;

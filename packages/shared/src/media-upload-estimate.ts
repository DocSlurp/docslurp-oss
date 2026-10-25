import { z } from "zod";

import { MEDIA_BYTES_PER_MINUTE, mediaRichPages, pageCredits } from "./billing.js";

/** Audio and video are priced by duration, not by page. */
export type UploadMediaKind = "audio" | "video";

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "weba"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm"]);

/** Which media kind a file is, from its MIME type then its extension; null for everything priced per page. */
export function uploadMediaKind(file: { name: string; type?: string | null }): UploadMediaKind | null {
  const type = (file.type ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  const dot = file.name.lastIndexOf(".");
  const extension = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  return null;
}

export const uploadMediaEstimateSchema = z.object({
  audioFiles: z.number().int().nonnegative(),
  videoFiles: z.number().int().nonnegative(),
  audioMinutes: z.number().nonnegative(),
  videoMinutes: z.number().nonnegative(),
  /** True when a file's duration was not supplied and was guessed from its size. */
  durationsAssumed: z.boolean(),
  /** Whether the workspace reads sampled video frames (`mediaVideo.enabled`), which triples a video minute's price. */
  videoFrames: z.boolean(),
  /** Credits for the media files: `low` reads video from its audio track only, `high` also reads frames. */
  credits: z.object({ low: z.number().nonnegative(), high: z.number().nonnegative() }),
  /**
   * The cheaper way to process these files, or null when the price is already the lowest. Pass `pipeline` as the
   * upload's pipeline overrides to apply it to that upload only.
   */
  lighter: z.object({
    kind: z.literal("video-audio-track-only"),
    credits: z.number().nonnegative(),
    savedCredits: z.number().nonnegative(),
    pipeline: z.object({ mediaVideo: z.object({ enabled: z.literal(false) }) }),
  }).nullable(),
});
export type UploadMediaEstimate = z.infer<typeof uploadMediaEstimateSchema>;

export type UploadMediaFile = { name: string; size: number; type?: string | null; durationSeconds?: number };

/**
 * What the audio and video among `files` will cost. Prices follow PRICE_CARD: an audio minute is one Rich page, a
 * video minute whose frames are read is three, rounded up per file. A video read from its audio track alone bills as
 * audio, which is the cheaper option offered as `lighter`. Null when no file is media.
 */
export function estimateUploadMedia(files: readonly UploadMediaFile[], options: { videoFrames: boolean }): UploadMediaEstimate | null {
  let audioFiles = 0;
  let videoFiles = 0;
  let audioSeconds = 0;
  let videoSeconds = 0;
  let audioPages = 0;
  let videoFramePages = 0;
  let videoTrackPages = 0;
  let assumed = false;
  for (const file of files) {
    const kind = uploadMediaKind(file);
    if (!kind) continue;
    const known = typeof file.durationSeconds === "number" && Number.isFinite(file.durationSeconds) && file.durationSeconds > 0;
    if (!known) assumed = true;
    const seconds = known
      ? file.durationSeconds!
      : (Math.max(0, file.size) / MEDIA_BYTES_PER_MINUTE[kind]) * 60;
    if (kind === "audio") {
      audioFiles += 1;
      audioSeconds += seconds;
      audioPages += mediaRichPages("audio", seconds);
    } else {
      videoFiles += 1;
      videoSeconds += seconds;
      videoFramePages += mediaRichPages("video", seconds);
      videoTrackPages += mediaRichPages("audio", seconds);
    }
  }
  if (audioFiles + videoFiles === 0) return null;
  const low = pageCredits("rich", audioPages + videoTrackPages);
  const high = options.videoFrames ? pageCredits("rich", audioPages + videoFramePages) : low;
  return uploadMediaEstimateSchema.parse({
    audioFiles,
    videoFiles,
    audioMinutes: round(audioSeconds / 60),
    videoMinutes: round(videoSeconds / 60),
    durationsAssumed: assumed,
    videoFrames: options.videoFrames,
    credits: { low, high },
    lighter: options.videoFrames && videoFiles > 0 && high > low
      ? { kind: "video-audio-track-only", credits: low, savedCredits: high - low, pipeline: { mediaVideo: { enabled: false } } }
      : null,
  });
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

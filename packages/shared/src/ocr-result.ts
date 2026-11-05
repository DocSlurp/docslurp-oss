/*
 * The result of one OCR job (`docslurp_ocr.py`, protocol `docslurp-ocr@1`), whether a VM provider or the self-hosted
 * local sandbox ran it. Producer output is untrusted: every field is bounded, unknown keys are refused, and the host
 * checks frame numbers, image names and text sizes again before it uses any of it (worker/src/ocr/result.ts).
 */
import { z } from "zod";

export const OCR_RESULT_PROTOCOL = "docslurp-ocr@1";
/** Most frames one job may return (pages of a PDF job, frames of a multi-frame image). */
export const OCR_MAX_FRAMES = 512;
/** Most text one frame may carry. */
export const OCR_MAX_FRAME_TEXT_CHARS = 1_000_000;
/** Most lines one frame may carry. */
export const OCR_MAX_FRAME_LINES = 20_000;

const int = (min: number, max: number) => z.number().int().min(min).max(max);
const unit = z.number().finite().min(0).max(1);
const family = z.enum(["multi", "korean", "eslav", "arabic", "devanagari", "greek", "thai"]);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

const ocrLineSchema = z.strictObject({
  text: z.string().max(100_000),
  confidence: unit,
  box: z.tuple([int(0, 65_535), int(0, 65_535), int(0, 65_535), int(0, 65_535)]),
});

const ocrAttemptSchema = z.strictObject({
  recogniser: family,
  meanConfidence: unit.nullable(),
  lines: int(0, OCR_MAX_FRAME_LINES),
});

export const ocrFrameSchema = z.strictObject({
  frame: int(1, 100_000),
  width: int(1, 65_535),
  height: int(1, 65_535),
  sourceWidth: int(1, 65_535),
  sourceHeight: int(1, 65_535),
  /** Null when detection found no text (a blank frame skips recognition). */
  recogniser: family.nullable(),
  attempts: z.array(ocrAttemptSchema).max(7),
  text: z.string().max(OCR_MAX_FRAME_TEXT_CHARS),
  lines: z.array(ocrLineSchema).max(OCR_MAX_FRAME_LINES),
  meanConfidence: unit.nullable(),
  chars: int(0, OCR_MAX_FRAME_TEXT_CHARS),
  elapsedMs: int(0, 3_600_000),
  /** A bounded PNG of the frame as OCR saw it, written beside the result for escalation; null when not requested. */
  image: z.string().regex(/^frame-[0-9]{4,6}\.png$/).nullable(),
  /** The frame's text was cut at OCR_MAX_FRAME_TEXT_CHARS. */
  textTruncated: z.boolean().optional(),
});
export type OcrFrameRecord = z.infer<typeof ocrFrameSchema>;

export const ocrResultSchema = z.strictObject({
  protocol: z.literal(OCR_RESULT_PROTOCOL),
  engine: z.strictObject({
    name: z.literal("rapidocr"),
    version: z.string().regex(/^[0-9][0-9A-Za-z.+-]{0,31}$/),
    onnxruntime: z.string().regex(/^[0-9][0-9A-Za-z.+-]{0,31}$/),
  }),
  models: z.array(z.strictObject({ id: modelId, sha256 })).min(2).max(16),
  truncatedFrames: z.boolean(),
  frames: z.array(ocrFrameSchema).max(OCR_MAX_FRAMES),
  peakRssKb: int(0, 1_000_000_000),
  cpuMs: int(0, 1_000_000_000),
  /** Per-line geometry was dropped to keep the result under its size bound. */
  linesDropped: z.boolean().optional(),
});
export type OcrResultRecord = z.infer<typeof ocrResultSchema>;

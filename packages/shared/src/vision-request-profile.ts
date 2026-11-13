/**
 * How a vision request is shaped for one model: prompt mode, sampling, output cap and the page image's long edge.
 *
 * Some OCR models are trained on one exact request and degrade on anything else (a text instruction, other sampling,
 * a larger image). A profile records that request so the worker sends it. Built-in profiles copy the model authors'
 * published client settings; an operator can override them per private-endpoint model
 * (`DOCSLURP_PRIVATE_MODEL_ENDPOINTS[].models[].vision`). Absent fields keep the worker's generic behaviour.
 */
import { z } from "zod";

export const visionRequestProfileSchema = z.object({
  /**
   * `template` (default): the worker's text prompt beside the image. `image-only`: the image alone, for models
   * trained to transcribe a page from the image with no instruction.
   */
  promptMode: z.enum(["template", "image-only"]).optional(),
  /**
   * Send the worker's system message (default true). Models trained on a single user turn may treat it as page
   * content; their output is still handled as untrusted data downstream.
   */
  systemMessage: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().gt(0).max(1).optional(),
  /**
   * Output cap sent as `max_tokens`. `server` sends none, so the server's context limit applies (a fixed cap can
   * overflow a small context once a large page image is counted); `contextTokens` then bounds admission.
   */
  maxOutputTokens: z.union([z.number().int().min(256).max(131_072), z.literal("server")]).optional(),
  /** The served model's context window in tokens; required with `maxOutputTokens: "server"`. */
  contextTokens: z.number().int().min(1_024).max(1_048_576).optional(),
  /** Longest page-image edge in pixels the model was trained on; PDF pages render no larger. */
  maxLongEdgePx: z.number().int().min(256).max(4_000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.maxOutputTokens === "server" && value.contextTokens === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["contextTokens"], message: "maxOutputTokens \"server\" needs contextTokens to bound admission" });
  }
});
export type VisionRequestProfile = z.infer<typeof visionRequestProfileSchema>;

/**
 * LightOnOCR-3 as LightOn's own client sends it (github.com/lightonai/LightOnOCR @36755d4, lightonocr/client.py and
 * models.py; serving flags in its README): image only, temperature 0.2, top_p 1.0, no max_tokens, page image at
 * most 2048 px (1540 px for the 1B), with vLLM serving `--max-model-len 18000` (16384 for the 1B).
 */
const LIGHTONOCR_3: VisionRequestProfile = Object.freeze({
  promptMode: "image-only",
  systemMessage: false,
  temperature: 0.2,
  topP: 1,
  maxOutputTokens: "server",
  contextTokens: 18_000,
  maxLongEdgePx: 2_048,
});

/** Built-in profiles keyed by the served model id. */
export const KNOWN_VISION_REQUEST_PROFILES: Readonly<Record<string, VisionRequestProfile>> = Object.freeze({
  "lightonai/LightOnOCR-3-0.8B": LIGHTONOCR_3,
  "lightonai/LightOnOCR-3-4B": LIGHTONOCR_3,
  "lightonai/LightOnOCR-3-1B": Object.freeze({ ...LIGHTONOCR_3, contextTokens: 16_384, maxLongEdgePx: 1_540 }),
});

/** The profile for `modelId`: the built-in one with any operator override applied field by field. */
export function visionRequestProfileFor(modelId: string | undefined, override?: VisionRequestProfile | null): VisionRequestProfile | undefined {
  const known = modelId ? KNOWN_VISION_REQUEST_PROFILES[modelId] : undefined;
  if (!known && !override) return undefined;
  const merged = { ...known, ...override };
  return visionRequestProfileSchema.parse(merged);
}

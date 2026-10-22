import sharp from "sharp";

/**
 * Per-model page-transcription settings for hosted vision models, keyed by the exact
 * OpenRouter model id. Models without an entry keep the worker's generic request shape.
 */
export interface VisionModelProfile {
  /** Template key used in place of the generic `<OCR>` default; an explicitly chosen template still wins. */
  defaultPrompt?: string;
  /** OpenAI-style `image_url.detail` sent with the page image. */
  imageDetail?: "auto" | "low" | "high";
  /** Downscale page images whose longer side exceeds this many pixels before sending them. */
  maxImageLongSide?: number;
  /** Strip a ```markdown / ```md fence that wraps the whole transcription (seen on ~1 in 2,000 Luna pages). */
  unwrapMarkdownFence?: boolean;
}

/** The generic default template key; a per-model `defaultPrompt` replaces only this. */
export const GENERIC_VISION_PROMPT_KEY = "<OCR>";

export const VISION_MODEL_PROFILES: Readonly<Record<string, VisionModelProfile>> = {
  // 2026-10-21 tuning (tune split, 68 pages x 2): the LaTeX/table template lifts math and content F1;
  // detail "high" plus a 1,600 px long side cuts image tokens ~20% at equal quality (1,280 px lost math).
  "openai/gpt-6-luna": { defaultPrompt: "page-markdown-latex", imageDetail: "high", maxImageLongSide: 1_600, unwrapMarkdownFence: true },
};

export function visionModelProfile(model: string | undefined): VisionModelProfile | undefined {
  return model ? VISION_MODEL_PROFILES[model] : undefined;
}

/** The template key to use for a model: its profile default replaces the generic `<OCR>` key only. */
export function profileVisionPromptKey(prompt: string | undefined, model: string | undefined): string | undefined {
  const key = prompt?.trim() || GENERIC_VISION_PROMPT_KEY;
  const profileDefault = visionModelProfile(model)?.defaultPrompt;
  return key === GENERIC_VISION_PROMPT_KEY && profileDefault ? profileDefault : prompt;
}

/**
 * Applies the profile's image limit. Images within the limit, unknown formats and undecodable
 * bytes are returned unchanged, so a profile can never turn a sendable page into a failure.
 */
export async function prepareVisionImage(
  image: Buffer,
  mimeType: string,
  profile: VisionModelProfile | undefined,
): Promise<Buffer> {
  const limit = profile?.maxImageLongSide;
  if (!limit || (mimeType !== "image/png" && mimeType !== "image/jpeg")) return image;
  try {
    const source = sharp(image);
    const { width = 0, height = 0 } = await source.metadata();
    if (Math.max(width, height) <= limit) return image;
    const resized = source.resize({ width: limit, height: limit, fit: "inside" });
    return mimeType === "image/png" ? await resized.png().toBuffer() : await resized.jpeg({ quality: 90 }).toBuffer();
  } catch {
    return image;
  }
}

const WHOLE_MARKDOWN_FENCE = /^```(?:markdown|md|gfm)[ \t]*\r?\n([\s\S]*?)\r?\n?```[ \t]*$/i;

/**
 * Removes one Markdown-tagged fence around the entire output when the profile asks for it. Untagged
 * or other-language fences (a page that is a code listing) and outputs with inner fences are kept.
 */
export function postProcessVisionText(text: string, profile: VisionModelProfile | undefined): string {
  if (!profile?.unwrapMarkdownFence) return text;
  const match = WHOLE_MARKDOWN_FENCE.exec(text.trim());
  if (!match || match[1]!.includes("\n```")) return text;
  return match[1]!.trim();
}

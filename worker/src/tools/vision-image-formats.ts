import { readFile, rm } from "node:fs/promises";

import { sniffImageMimeType } from "../pipeline/page-image-format.js";
import type { CommandRunner } from "./runner.js";

/**
 * Image formats each hosted vision model is known to accept. PNG and JPEG are the baseline every
 * route takes. WebP is listed only where a live probe proved it: 2026-10-26, a lossless WebP of a
 * short text line sent through OpenRouter with the routing each profile pins
 * (`allow_fallbacks: false`), and each one transcribed it:
 *
 * - deepseek/deepseek-v4.1-flash-1017: Together, Fireworks, Parasail
 * - xiaomi/mimo-v2.6-flash: Relace, DeepInfra
 * - openai/gpt-6-luna: OpenAI, Amazon Bedrock us-east-1, Azure US (Azure garbled PNG and WebP alike)
 * - z-ai/glm-5.3-flash: Wafer, Friendli, InferenceNet
 * - google/gemini-3.1-flash-lite, google/gemini-2.5-flash-lite: Google (default routing)
 * - nvidia/nemotron-3.5-super-vl: CoreWeave (default routing)
 *
 * Every other route (direct OpenAI, self-hosted vLLM, private endpoints, new catalog entries)
 * gets PNG until it is probed and added here.
 */
export const WEBP_VERIFIED_VISION_MODELS: ReadonlySet<string> = new Set([
  "deepseek/deepseek-v4.1-flash-1017",
  "xiaomi/mimo-v2.6-flash",
  "openai/gpt-6-luna",
  "z-ai/glm-5.3-flash",
  "google/gemini-3.1-flash-lite",
  "google/gemini-2.5-flash-lite",
  "nvidia/nemotron-3.5-super-vl",
]);

const BASELINE_FORMATS = new Set(["image/png", "image/jpeg"]);

export function visionModelAcceptsImage(model: string, mimeType: string): boolean {
  if (BASELINE_FORMATS.has(mimeType)) return true;
  return mimeType === "image/webp" && WEBP_VERIFIED_VISION_MODELS.has(model);
}

/**
 * The bytes to send `model` for `imagePath`: as stored when the model accepts the format, else a
 * PNG made by `dwebp` through the parser sandbox (the pixels come from customer files, so the
 * worker never decodes them in-process for this). Lossless both ways, so the pixels are equal.
 */
export async function visionImageForModel(args: {
  model: string;
  imagePath: string;
  fallbackMimeType: string;
  runner: Pick<CommandRunner, "run"> & Partial<Pick<CommandRunner, "decodeWebpToPng">>;
  signal?: AbortSignal;
}): Promise<{ bytes: Buffer; mimeType: string; transcoded: boolean }> {
  const bytes = await readFile(args.imagePath);
  const mimeType = sniffImageMimeType(bytes) ?? args.fallbackMimeType;
  if (mimeType !== "image/webp" || visionModelAcceptsImage(args.model, mimeType)) return { bytes, mimeType, transcoded: false };
  const output = `${args.imagePath}.vision.png`;
  const plan = args.runner.decodeWebpToPng ? await args.runner.decodeWebpToPng(args.imagePath, output) : null;
  if (!plan?.available) {
    // dwebp ships in the same package as cwebp, so this means a broken image. Sending the WebP is a
    // format risk (the provider may reject it), not an isolation one.
    console.warn(`[page-image] WARNING dwebp unavailable; sending WebP to unverified vision model ${args.model}`);
    return { bytes, mimeType, transcoded: false };
  }
  try {
    await args.runner.run(plan, args.signal);
    const png = await readFile(output);
    if (sniffImageMimeType(png) !== "image/png") throw new Error("dwebp produced no PNG");
    return { bytes: png, mimeType: "image/png", transcoded: true };
  } finally {
    await rm(output, { force: true });
  }
}

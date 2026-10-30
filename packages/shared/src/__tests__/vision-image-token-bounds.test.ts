import { describe, expect, it } from "vitest";

import { visionImageTokens, visionModelCatalog, visionModelRefusal } from "../embedding.js";

/**
 * The catalog image-token bound of every priced hosted vision model against the provider's own published rule,
 * re-implemented here from the source (not from `visionImageTokens`): tiny images that processors upscale to a
 * minimum size, extreme aspect ratios and large pages. Sources, checked 2026-10-29:
 *
 * - Nemotron 3.5 Super VL: nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B `preprocessor_config.json` and
 *   `image_processing_nemotron_h_omni.py` (`_compute_target_patches`), `processing_nemotron_h_omni.py` framing.
 * - DeepSeek V4.1 Flash 1017: deepseek-ai/DeepSeek-V4.1-Flash-1017 `inference/config.json` and
 *   `inference/image_processor.py` (`plan_image_grid`, `num_image_tokens`).
 * - MiMo V2.6 Flash: XiaomiMiMo/MiMo-V2.6-Flash `preprocessor_config.json` (`Qwen2VLImageProcessor`, `smart_resize`).
 * - GLM 5.3 Flash: zai-org/GLM-5.3-Flash `processor_config.json` and transformers' `image_processing_glm5_next.py`.
 * - OpenAI: images-vision guide (32-px patches, at most 1,536 patches, times the model multiplier).
 * - Gemini 2.x: 258 tokens for an image within 384 px, else 258 per 768-px tile; Gemini 3: at most 2,240 (`ultra_high`).
 */

/** Python's `round` (half to even). */
function pyRound(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Nemotron H Omni: one dynamic-resolution tile, 16-px patches, 2x2 pixel shuffle, `<img>` ... `</img>`. */
function nemotronTokens(width: number, height: number): number {
  const patch = 16, minPatches = 1_024, maxPatches = 13_312, maxModelLen = 16_384, divisor = 2;
  const budget = Math.max((maxModelLen - 4) * divisor ** 2, minPatches);
  const available = Math.max(Math.min(budget, maxPatches), minPatches);
  const closestH = pyRound(height / patch + 0.5);
  const closestW = pyRound(width / patch + 0.5);
  const factor = Math.min(Math.sqrt(available / (closestH * closestW)), 1);
  let h = Math.floor(factor * closestH);
  let w = Math.floor(factor * closestW);
  if (available > minPatches && h * w < minPatches) {
    const up = Math.sqrt(minPatches / (h * w));
    h = Math.ceil(up * h);
    w = Math.ceil(up * w);
  }
  const remH = h % divisor;
  if (remH) h = (h + divisor - remH) * w <= available ? h + divisor - remH : Math.max(divisor, h - remH);
  const remW = w % divisor;
  if (remW) w = h * (w + divisor - remW) <= available ? w + divisor - remW : Math.max(divisor, w - remW);
  return Math.floor((w * h) / divisor ** 2) + 2;
}

/** DeepSeek V4.1: 14-px patches, 3x3 aligner, rows with a new-line token, start and end; at most 1,024 in all. */
function deepseekTokens(width: number, height: number): number {
  const p = 14, ratio = 3, maxTokens = 1_024, minPixels = 295_936;
  const count = (h: number, w: number) => {
    const nh = Math.ceil(Math.floor(h / p) / ratio);
    const nw = Math.ceil(Math.floor(w / p) / ratio);
    return nh * (nw + 1) + 2;
  };
  let w = width, h = height;
  if (w * h > 0 && w * h < minPixels) {
    const scale = Math.sqrt(minPixels / (w * h));
    w = Math.trunc(w * scale);
    h = Math.trunc(h * scale);
  }
  let bestH = Math.ceil(h / p) * p;
  let bestW = Math.ceil(w / p) * p;
  if (count(bestH, bestW) > maxTokens) {
    const r = h / w;
    const maxW = Math.sqrt((maxTokens - 2) / r + 0.25) - 0.5;
    const maxH = maxW * r;
    const cell = p * ratio;
    if (maxW < 1) [bestH, bestW] = [Math.floor((maxTokens - 2) / 2) * cell, cell];
    else if (maxH < 1) [bestH, bestW] = [cell, (maxTokens - 3) * cell];
    else {
      const beta = Math.min((Math.floor(maxW) * cell) / w, (Math.floor(maxH) * cell) / h);
      [bestH, bestW] = [Math.floor((h * beta) / p) * p, Math.floor((w * beta) / p) * p];
    }
  }
  return count(bestH, bestW);
}

/** Qwen2-VL `smart_resize` (MiMo: 16-px patches, 2x2 merge, 8,192 to 8,388,608 px); null when it refuses the image. */
function qwen2vlTokens(width: number, height: number): number | null {
  const factor = 32, minPixels = 8_192, maxPixels = 8_388_608;
  if (Math.max(width, height) / Math.min(width, height) > 200) return null;
  let h = Math.max(factor, pyRound(height / factor) * factor);
  let w = Math.max(factor, pyRound(width / factor) * factor);
  if (h * w > maxPixels) {
    const beta = Math.sqrt((height * width) / maxPixels);
    h = Math.max(factor, Math.floor(height / beta / factor) * factor);
    w = Math.max(factor, Math.floor(width / beta / factor) * factor);
  } else if (h * w < minPixels) {
    const beta = Math.sqrt(minPixels / (height * width));
    h = Math.ceil((height * beta) / factor) * factor;
    w = Math.ceil((width * beta) / factor) * factor;
  }
  return (h / 16) * (w / 16) / 4 + 2;
}

/** GLM5-Next `smart_resize` (14-px patches, 2x2 merge, 2 frames, 16 to 8,000 merged tokens), start and end tokens. */
function glm5NextTokens(width: number, height: number): number {
  const factor = 28, frames = 2;
  const minPixels = 16 * frames * factor ** 2;
  const maxPixels = 8_000 * frames * factor ** 2;
  const align = (value: number) => Math.ceil(value / factor) * factor;
  let h = align(height), w = align(width);
  if (frames * h * w < minPixels) {
    const scale = Math.sqrt(minPixels / (frames * height * width));
    h = align(Math.max(1, Math.ceil(height * scale)));
    w = align(Math.max(1, Math.ceil(width * scale)));
  }
  if (frames * h * w > maxPixels) {
    let low = 1, high = height;
    let best: [number, number] = [factor, factor];
    while (low <= high) {
      const contentH = Math.floor((low + high) / 2);
      const contentW = Math.max(1, Math.floor((width * contentH) / height));
      const candidate: [number, number] = [align(contentH), align(contentW)];
      if (frames * candidate[0] * candidate[1] <= maxPixels) {
        best = candidate;
        low = contentH + 1;
      } else {
        high = contentH - 1;
      }
    }
    [h, w] = best;
  }
  return (h * w) / factor ** 2 + 2;
}

function openAiTokens(multiplier: number) {
  return (width: number, height: number) => Math.ceil(Math.min(Math.ceil(width / 32) * Math.ceil(height / 32), 1_536) * multiplier);
}

function gemini2Tokens(width: number, height: number): number {
  if (width <= 384 && height <= 384) return 258;
  return Math.ceil(width / 768) * Math.ceil(height / 768) * 258;
}

// Nemotron (`nemotronTokens`) and MiMo (`qwen2vlTokens`) are refused: their processor maxima are not proven at the
// serving level, so they carry no bound; the rules stay for the evidence their re-admission needs.
const RULES: Record<string, (width: number, height: number) => number | null> = {
  "deepseek/deepseek-v4.1-flash-1017": deepseekTokens,
  "z-ai/glm-5.3-flash": glm5NextTokens,
  "gpt-4.1-mini": openAiTokens(1.62),
  // No multiplier published for GPT-6 Luna: the largest OpenAI lists (gpt-4.1-nano).
  "openai/gpt-6-luna": openAiTokens(2.46),
  "google/gemini-2.5-flash-lite": gemini2Tokens,
  "google/gemini-3.1-flash-lite": () => 2_240,
};

const SIZES: Array<[number, number]> = [
  [1, 1], [14, 14], [16, 16], [1, 4_000], [4_000, 1], [14, 4_095], [4_095, 14], [20, 4_000], [4_000, 20],
  [300, 60_000], [600, 800], [1_000, 1_400], [1_700, 2_200], [2_550, 3_300], [4_095, 4_095], [4_096, 4_096],
  [8_000, 8_000], [16_000, 1_000],
];

describe("vision image-token bounds against each model's published image processor", () => {
  it("has a rule for every admitted priced catalog model, and refused models have no bound", () => {
    const priced = visionModelCatalog.filter((spec) => spec.tokenPricing && !visionModelRefusal(spec.id)).map((spec) => spec.id);
    expect(Object.keys(RULES).sort()).toEqual([...priced].sort());
    for (const model of ["nvidia/nemotron-3.5-super-vl", "xiaomi/mimo-v2.6-flash"]) {
      expect(visionModelRefusal(model), model).not.toBeNull();
      expect(visionImageTokens(model, null), model).toBeNull();
    }
  });

  for (const [model, rule] of Object.entries(RULES)) {
    it.each(SIZES)(`${model}: %i x %i px stays within the bound`, (width, height) => {
      const bound = visionImageTokens(model, { widthPx: width, heightPx: height });
      expect(bound).not.toBeNull();
      const actual = rule(width, height);
      if (actual !== null) expect(bound!).toBeGreaterThanOrEqual(actual);
      // An unreadable size is priced at least as high as the largest raster the worker renders.
      expect(visionImageTokens(model, null)!).toBeGreaterThanOrEqual(rule(4_096, 4_096) ?? 0);
    });
  }

  it("covers the minimum-size upscaling the patch formula alone would miss", () => {
    // A 14 px square is one 14-px patch, but these processors enlarge it to their minimum size.
    expect(nemotronTokens(14, 14)).toBe(1_024 / 4 + 2);
    expect(deepseekTokens(14, 14)).toBeGreaterThan(100);
    expect(glm5NextTokens(14, 14)).toBeGreaterThanOrEqual(16);
    expect(qwen2vlTokens(14, 14)).toBeGreaterThanOrEqual(8_192 / 1_024);
    for (const model of ["deepseek/deepseek-v4.1-flash-1017", "z-ai/glm-5.3-flash"]) {
      expect(visionImageTokens(model, { widthPx: 14, heightPx: 14 })!).toBeGreaterThanOrEqual(RULES[model]!(14, 14)!);
    }
  });

  it("reaches each processor's documented maximum on large pages", () => {
    expect(nemotronTokens(4_096, 4_096)).toBeLessThanOrEqual(13_312 / 4 + 2);
    expect(nemotronTokens(4_096, 4_096)).toBeGreaterThan(3_200);
    expect(deepseekTokens(4_096, 4_096)).toBeLessThanOrEqual(1_024);
    expect(qwen2vlTokens(8_000, 8_000)).toBeLessThanOrEqual(8_194);
    expect(glm5NextTokens(8_000, 8_000)).toBeLessThanOrEqual(8_002);
    expect(glm5NextTokens(8_000, 8_000)).toBeGreaterThan(7_900);
  });
});

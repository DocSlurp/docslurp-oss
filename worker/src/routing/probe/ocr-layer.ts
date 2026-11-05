/**
 * TL1 OCR-layer agreement: how well a hidden text layer agrees with a fresh OCR of one band of the page.
 * Same algorithm and thresholds as page_probe.py (`ocr_layer_agreement`).
 *
 * Off in the worker: the thresholds were tuned against Tesseract's band reads, and the OCR engine is now PP-OCR in an
 * isolated boundary. No production caller passes a recogniser, so OCR-layer pages stay unverified (as they always were
 * without one) until the agreement threshold is re-measured for the new recogniser. A recogniser passed here must run
 * in that boundary; nothing in this module runs OCR itself.
 */
import { tokenAgreement } from "@docslurp/shared";

import type { ProbeBindingPage } from "./binding.js";
import { round } from "./features.js";
import { TRUST_RULE } from "../trust.js";

export const OCR_CHECK_BAND = 0.25;
export const OCR_CHECK_DPI = 100;
export const OCR_CHECK_MIN_TOKENS = 10;
/**
 * Largest band OCR'd (pixels at OCR_CHECK_DPI). A Letter page's band is about 0.23 MP; a hostile page size makes a
 * band a recogniser spends a minute and about 1 GB on, so larger bands are left unverified.
 */
export const OCR_CHECK_MAX_PIXELS = 4_000_000;
/** Least agreement (lesser of precision and recall) of the layer with the OCR; the shared text-layer cross-check threshold. */
export const OCR_AGREEMENT_MIN = TRUST_RULE.ocrLayerAgreementMin;

export interface OcrLayerCheck {
  agreement: number | null;
  tokens: number;
  cpuMs: number;
  wallMs: number;
}

/** OCR of one PNG; `language` is an OCR language string for the layer's script (the recogniser's default when absent). */
export type Recogniser = (png: Buffer, signal?: AbortSignal, language?: string) => Promise<string | null>;

/** OCR language codes for the dominant script of a text; null when no script is mapped (the check is skipped). */
export function ocrLanguageForText(text: string): string | null {
  const sample = text.slice(0, 20_000);
  const scripts: Array<[string, RegExp]> = [
    ["eng", /\p{Script=Latin}/gu],
    ["rus+ukr", /\p{Script=Cyrillic}/gu],
    ["ell", /\p{Script=Greek}/gu],
    ["ara", /\p{Script=Arabic}/gu],
    ["heb", /\p{Script=Hebrew}/gu],
    ["hin", /\p{Script=Devanagari}/gu],
    ["tha", /\p{Script=Thai}/gu],
    ["kor", /\p{Script=Hangul}/gu],
    ["jpn", /[\p{Script=Hiragana}\p{Script=Katakana}]/gu],
    ["chi_sim+chi_tra", /\p{Script=Han}/gu],
  ];
  const counts = new Map(scripts.map(([language, pattern]) => [language, (sample.match(pattern) ?? []).length]));
  // Japanese text is mostly Han plus Kana: any real amount of Kana makes it Japanese.
  if ((counts.get("jpn") ?? 0) >= 5) return "jpn+chi_sim";
  let best: { language: string; count: number } | null = null;
  for (const [language, count] of counts) if (count > (best?.count ?? 0)) best = { language, count };
  return best && best.count >= 5 ? best.language : null;
}

export async function ocrLayerAgreement(
  page: ProbeBindingPage,
  size: { widthPt: number; heightPt: number },
  recognise: Recogniser,
  signal?: AbortSignal,
): Promise<OcrLayerCheck> {
  const wall0 = performance.now();
  const cpu0 = process.cpuUsage();
  const out: OcrLayerCheck = { agreement: null, tokens: 0, cpuMs: 0, wallMs: 0 };
  // Words with a vertical position (span centre), like the original Python probe's word list.
  const words: Array<{ text: string; y: number }> = [];
  for (const span of page.spans()) {
    const y = (span.bbox[1] + span.bbox[3]) / 2;
    for (const w of span.text.split(/\s+/)) if (w) words.push({ text: w, y });
  }
  if (words.length > 0) {
    const ys = words.map((w) => w.y).sort((a, b) => a - b);
    const mid = ys[Math.floor(ys.length / 2)]!;
    const clip: [number, number, number, number] = [
      0, Math.max(0, mid - (OCR_CHECK_BAND * size.heightPt) / 2), size.widthPt, Math.min(size.heightPt, mid + (OCR_CHECK_BAND * size.heightPt) / 2),
    ];
    // The layer's words inside the OCR'd band, in the layer's reading order: what the OCR can be compared with.
    const bandText = words.filter((w) => w.y >= clip[1] && w.y <= clip[3]).map((w) => w.text).join(" ");
    const language = ocrLanguageForText(bandText);
    const bandPixels = ((clip[2] - clip[0]) * OCR_CHECK_DPI / 72) * ((clip[3] - clip[1]) * OCR_CHECK_DPI / 72);
    const text = language !== null && Number.isFinite(bandPixels) && bandPixels <= OCR_CHECK_MAX_PIXELS
      ? await recognise(await page.renderAsync({ dpi: OCR_CHECK_DPI, clip, gray: true, format: "png" }), signal, language)
      : null;
    if (text !== null) {
      const agreement = tokenAgreement(bandText, text, OCR_CHECK_MIN_TOKENS);
      out.tokens = agreement?.ocrTokens ?? 0;
      // Both directions in reading order: precision alone passes a word salad drawn from the layer's vocabulary.
      if (agreement) out.agreement = round(Math.min(agreement.precision, agreement.recall), 4);
    }
  }
  const cpu = process.cpuUsage(cpu0);
  out.cpuMs = round((cpu.user + cpu.system) / 1000, 1);
  out.wallMs = round(performance.now() - wall0, 1);
  return out;
}

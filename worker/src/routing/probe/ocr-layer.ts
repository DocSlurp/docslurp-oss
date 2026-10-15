/**
 * TL1 OCR-layer agreement: how well a hidden text layer agrees with a fresh OCR of one band of the page.
 * Same algorithm and thresholds as page_probe.py (`ocr_layer_agreement`); tesseract stays the recogniser.
 */
import { spawn } from "node:child_process";

import type { ProbeBindingPage } from "./binding.js";
import { round, tokens } from "./features.js";

export const OCR_CHECK_BAND = 0.25;
export const OCR_CHECK_DPI = 100;
export const OCR_CHECK_MIN_TOKENS = 10;
/** Chosen on development+calibration pages (TL1, tuned with tesseract); re-tune before changing the recogniser. */
export const OCR_AGREEMENT_MIN = 0.4;

export interface OcrLayerCheck {
  agreement: number | null;
  tokens: number;
  cpuMs: number;
  wallMs: number;
}

/** Recognise a PNG with the `tesseract` binary (stdin to stdout). Resolves null when tesseract is unavailable. */
export function tesseractRecognise(png: Buffer, signal?: AbortSignal, timeoutMs = 60_000): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("tesseract", ["stdin", "stdout", "--psm", "4", "-l", "eng"], {
      env: { ...process.env, OMP_THREAD_LIMIT: "1" },
      stdio: ["pipe", "pipe", "ignore"],
      signal,
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (error.code === "ENOENT") resolve(null);
      else reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(png);
  });
}

export type Recogniser = (png: Buffer, signal?: AbortSignal) => Promise<string | null>;

export async function ocrLayerAgreement(
  page: ProbeBindingPage,
  size: { widthPt: number; heightPt: number },
  recognise: Recogniser = tesseractRecognise,
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
    const png = await page.renderAsync({ dpi: OCR_CHECK_DPI, clip, gray: true, format: "png" });
    const text = await recognise(png, signal);
    if (text !== null) {
      const got = tokens(text, 4);
      const vocab = new Set(tokens(words.map((w) => w.text).join(" "), 4));
      out.tokens = got.length;
      if (got.length >= OCR_CHECK_MIN_TOKENS) out.agreement = round(got.filter((t) => vocab.has(t)).length / got.length, 4);
    }
  }
  const cpu = process.cpuUsage(cpu0);
  out.cpuMs = round((cpu.user + cpu.system) / 1000, 1);
  out.wallMs = round(performance.now() - wall0, 1);
  return out;
}

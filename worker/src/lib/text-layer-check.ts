/**
 * OCR cross-check for suspect text layers (docs/page-text-layer-quality.md): render the page, read it with Tesseract
 * in the script of the layer, and compare the two token sequences in both directions (`tokenAgreement`). Runs only
 * for the few pages `assessTextLayer` calls suspect, a sample per document, through the same sandboxed command
 * runner as every other parser. Any failure (no Tesseract, no language data, a render error) is `null`: unchecked,
 * never "matches" and never "differs".
 */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { tokenAgreement, textLayerMatchesOcr } from "@docslurp/shared";

import type { CommandRunner } from "../tools/runner.js";
import { sandboxedTesseract, type Recogniser } from "../routing/probe/ocr-layer.js";
import type { TextLayerVerifier } from "./page-image-evidence.js";

const CHECK_DPI = 100;
/** Longest edge of the check render, in pixels (the render is scaled before pixels are allocated). */
const CHECK_MAX_EDGE_PX = 1600;

/** Tesseract language packs for the dominant script of a text; null when no pack is mapped (the check is skipped). */
export function tesseractLanguageForText(text: string): string | null {
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
  let best: { language: string; count: number } | null = null;
  const counts = new Map(scripts.map(([language, pattern]) => [language, (sample.match(pattern) ?? []).length]));
  // Japanese text is mostly Han plus Kana: any real amount of Kana makes it Japanese.
  if ((counts.get("jpn") ?? 0) >= 5) return "jpn+chi_sim";
  for (const [language, count] of counts) if (count > (best?.count ?? 0)) best = { language, count };
  return best && best.count >= 5 ? best.language : null;
}

export function createTextLayerVerifier(args: {
  runner: Pick<CommandRunner, "renderPdfPageRange" | "plan" | "run">;
  sourcePath: string;
  /** Recogniser factory, for tests; defaults to the sandboxed Tesseract in the layer's script. */
  recogniser?: (language: string) => Recogniser;
  timeoutMs?: number;
}): TextLayerVerifier {
  const recogniserFor = args.recogniser ?? ((language: string) => sandboxedTesseract(args.runner, args.timeoutMs ?? 60_000, language));
  return async (pages, signal) => {
    const verdicts = new Map<number, boolean | null>();
    for (const page of pages) {
      verdicts.set(page.pageNumber, null);
      const language = tesseractLanguageForText(page.text);
      if (!language) continue;
      const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-layer-check-"));
      try {
        signal?.throwIfAborted();
        const prefix = path.join(scratch, "page");
        const plan = await args.runner.renderPdfPageRange(args.sourcePath, prefix, page.pageNumber, page.pageNumber, CHECK_DPI, CHECK_MAX_EDGE_PX);
        if (!plan.available) continue;
        await args.runner.run({ ...plan, readOnlyInputs: true, timeoutMs: args.timeoutMs ?? 60_000 }, signal);
        const file = (await readdir(scratch)).find((name) => name.startsWith("page-") && name.endsWith(".png"));
        if (!file) continue;
        const text = await recogniserFor(language)(await readFile(path.join(scratch, file)), signal);
        if (text === null) continue;
        const agreement = tokenAgreement(page.text, text);
        verdicts.set(page.pageNumber, agreement ? textLayerMatchesOcr(agreement) : null);
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn(`[text-layer-check] page=${page.pageNumber} unchecked: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    }
    return verdicts;
  };
}

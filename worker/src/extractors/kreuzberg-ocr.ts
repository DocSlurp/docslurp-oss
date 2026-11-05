/**
 * The project's OCR language (`documentExtraction.ocr.language`) for the engines that OCR on the main extraction
 * path: Kreuzberg (images, and scanned PDF pages) and the planned Tesseract command of the canonical stage. Without
 * this they read English only, so a Greek, Arabic or Chinese scan came out as junk.
 *
 * - A named language (`deu`, `chi_sim`, `eng+deu`) is used as given.
 * - `auto` has no script detection to lean on here (Kreuzberg takes one language string for the whole file), so it
 *   becomes English plus the installed packs of the most widely used other scripts, at most `AUTO_LANGUAGE_LIMIT`
 *   in all: Tesseract reads every listed language at once and slows with each. Per-page script detection with retry
 *   is `ocrImageText` (lib/ocr-language.ts), which the page OCR routes use.
 * - A language the project set on the Kreuzberg options themselves (`options.kreuzberg.ocr.language`) wins, and
 *   options that disable OCR (`disableOcr`, set by Fast) are left as they are.
 */
import { OCR_AUTO, installedPacks } from "../lib/ocr-language.js";

/** Other scripts' packs for `auto`, most widely used first (Han, Cyrillic, Arabic, Japanese, Korean, Devanagari...). */
const AUTO_SCRIPT_PACKS = ["chi_sim", "rus", "ara", "jpn", "kor", "hin", "ell", "heb", "tha"];
/** Languages Tesseract is asked to read at once under `auto`, English included. */
export const AUTO_LANGUAGE_LIMIT = 4;

/** Tesseract codes for the setting, or null when no pack is installed (OCR then reports itself unavailable). */
export function resolveOcrLanguages(setting: string | undefined, env: NodeJS.ProcessEnv = process.env, exists?: (path: string) => boolean): string | null {
  const value = setting?.trim();
  if (value && value !== OCR_AUTO) return value;
  const installed = installedPacks(["eng", ...AUTO_SCRIPT_PACKS], env, exists);
  return installed.length ? installed.slice(0, AUTO_LANGUAGE_LIMIT).join("+") : null;
}

/** `options` with Kreuzberg's `ocr.language` filled from the project setting; the rest is untouched. */
export function withKreuzbergOcrLanguage(
  options: Record<string, unknown>,
  setting: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  exists?: (path: string) => boolean,
): Record<string, unknown> {
  const kreuzberg = (options.kreuzberg ?? {}) as { disableOcr?: boolean; ocr?: { language?: string } };
  // OCR off (Fast) stays off: no language to set, and the options stay exactly as the quality tier left them.
  if (kreuzberg.disableOcr || kreuzberg.ocr?.language) return options;
  const language = resolveOcrLanguages(setting, env, exists);
  if (!language) return options;
  return { ...options, kreuzberg: { ...kreuzberg, ocr: { ...kreuzberg.ocr, language } } };
}

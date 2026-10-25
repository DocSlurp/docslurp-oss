/**
 * Whether local OCR can run on this worker. Kreuzberg's bundled Tesseract resolves language data from
 * TESSDATA_PREFIX, then from the system locations below, and otherwise from the path of the CI machine that
 * built it, which never exists in a runtime image. The lean worker image ships no Tesseract, so every image
 * OCR there dies with "Error opening data file"; the planner asks first and routes images to vision instead.
 * `Dockerfile.full` installs tesseract-ocr language packs, which this finds under /usr/share/tesseract-ocr.
 */
import { existsSync } from "node:fs";
import path from "node:path";

export const SYSTEM_TESSDATA_DIRS = [
  "/opt/homebrew/share/tessdata",
  "/opt/homebrew/opt/tesseract/share/tessdata",
  "/usr/local/opt/tesseract/share/tessdata",
  "/usr/share/tesseract-ocr/5/tessdata",
  "/usr/share/tesseract-ocr/4/tessdata",
  "/usr/share/tessdata",
  "/usr/local/share/tessdata",
];

export interface TessdataProbe {
  env?: Record<string, string | undefined>;
  exists?: (path: string) => boolean;
  /** Tesseract language code, `+`-joined for several; every one must be installed. */
  language?: string;
}

/** Directory holding `<language>.traineddata` for every requested language, or null when OCR cannot run. */
export function findTessdataDir({ env = process.env, exists = existsSync, language = "eng" }: TessdataProbe = {}): string | null {
  const languages = language.split("+").map((entry) => entry.trim()).filter(Boolean);
  if (languages.length === 0) languages.push("eng");
  const complete = (dir: string) => languages.every((entry) => exists(path.join(dir, `${entry}.traineddata`)));
  const prefix = env.TESSDATA_PREFIX?.trim();
  // Tesseract ignores a prefix that does not exist; one that exists is authoritative.
  if (prefix && exists(prefix)) return complete(prefix) ? prefix : null;
  return SYSTEM_TESSDATA_DIRS.find((dir) => exists(dir) && complete(dir)) ?? null;
}

/** DOCSLURP_OCR=off never attempts OCR; anything else detects installed language data. */
export function ocrAvailable(probe: TessdataProbe = {}): boolean {
  const env = probe.env ?? process.env;
  if (/^(off|0|false|no)$/i.test(env.DOCSLURP_OCR?.trim() ?? "")) return false;
  return findTessdataDir({ ...probe, env }) !== null;
}

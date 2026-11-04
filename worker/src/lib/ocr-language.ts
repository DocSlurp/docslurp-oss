import { ocrLanguageSchema } from "@docslurp/shared";

import { findTessdataDir } from "../extractors/ocr-capability.js";

/**
 * OCR language selection.
 *
 * OCR with the wrong language pack returns confident-looking junk, so the
 * language is not assumed to be English. With the `auto` setting the script of
 * the page is found first (Tesseract's orientation and script detection,
 * `--psm 0`), the packs for that script run, and a result with low confidence
 * is retried with the next candidate packs instead of being accepted. A page
 * that no installed pack can read fails with `OcrLowConfidenceError`, so the
 * stage can send it to a stronger reader rather than index noise. A language
 * named by the workspace (`eng+deu`) is used as given.
 */

export const OCR_AUTO = "auto";

/** Mean word confidence below which a result is retried with other packs. */
export const OCR_RETRY_BELOW_CONFIDENCE = 60;
/** Mean word confidence below which a result with enough words is junk and is refused. */
export const OCR_REJECT_BELOW_CONFIDENCE = 40;
/** A result with fewer words than this cannot be judged junk. */
const MIN_WORDS_TO_JUDGE = 8;
/** Trial runs per page: the first plus at most this many more. */
const MAX_ATTEMPTS = 5;

export class OcrLowConfidenceError extends Error {
  constructor(readonly languages: string, readonly meanConfidence: number, readonly words: number, readonly script: string | null) {
    super(`OCR produced low-confidence text (languages=${languages} script=${script ?? "unknown"} words=${words} meanConfidence=${meanConfidence.toFixed(1)})`);
    this.name = "OcrLowConfidenceError";
  }
}

export function ocrLanguageSettingFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DOCSLURP_OCR_LANGUAGE?.trim();
  return value ? value : OCR_AUTO;
}

/** Tesseract language packs for each script its orientation detection reports, most likely first. */
const SCRIPT_PACKS: Record<string, string[]> = {
  Latin: ["eng", "deu+fra+spa+ita+nld+pol+por+tur+eng"],
  Vietnamese: ["vie+eng"],
  Cyrillic: ["rus+ukr+eng"],
  Greek: ["ell+eng"],
  Arabic: ["ara+eng"],
  Hebrew: ["heb+eng"],
  Devanagari: ["hin+eng"],
  Thai: ["tha+eng"],
  Hangul: ["kor+eng"],
  Japanese: ["jpn+eng"],
  Han: ["chi_sim+eng", "chi_tra+eng", "jpn+eng"],
};

/** Order tried when the script is unknown: the widest-use scripts first. */
const UNKNOWN_SCRIPT_ORDER = ["Latin", "Han", "Cyrillic", "Arabic", "Japanese", "Hangul", "Devanagari", "Greek", "Hebrew", "Thai", "Vietnamese"];

export interface OsdResult {
  script: string | null;
  scriptConfidence: number | null;
}

/** Reads `Script: Latin` / `Script confidence: 2.53` from `tesseract --psm 0` output. */
export function parseOsdOutput(output: string): OsdResult {
  const script = output.match(/^Script:\s*(\S+)/m)?.[1] ?? null;
  const confidence = output.match(/^Script confidence:\s*([\d.]+)/m)?.[1];
  return { script, scriptConfidence: confidence === undefined ? null : Number(confidence) };
}

export interface TsvResult {
  text: string;
  words: number;
  meanConfidence: number | null;
}

const IDEOGRAPHIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/** Text and mean word confidence from `tesseract ... tsv` output. */
export function parseTesseractTsv(tsv: string): TsvResult {
  const lines: string[][] = [];
  let currentKey = "";
  let paragraph = "";
  let total = 0;
  let words = 0;
  for (const row of tsv.split(/\r?\n/).slice(1)) {
    const cells = row.split("\t");
    if (cells.length < 12 || cells[0] === "") continue;
    const [level, , block, par, line, , , , , , conf, ...rest] = cells;
    const text = rest.join("\t").trim();
    if (level !== "5" || !text) continue;
    const confidence = Number(conf);
    if (Number.isFinite(confidence) && confidence >= 0) {
      total += confidence;
      words += 1;
    }
    const key = `${block}/${par}/${line}`;
    const blockPar = `${block}/${par}`;
    if (key !== currentKey) {
      if (lines.length && blockPar !== paragraph) lines.push([]);
      lines.push([]);
      currentKey = key;
      paragraph = blockPar;
    }
    lines[lines.length - 1]!.push(text);
  }
  const joined = (parts: string[]) => parts.reduce((acc, part, index) => {
    if (index === 0) return part;
    // Scripts written without spaces keep their words together.
    const spaceless = IDEOGRAPHIC.test(acc.at(-1) ?? "") && IDEOGRAPHIC.test(part[0] ?? "");
    return acc + (spaceless ? "" : " ") + part;
  }, "");
  const text = lines.map(joined).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, words, meanConfidence: words ? total / words : null };
}

/** Runs `tesseract <args>` and returns its standard output. */
export type TesseractRun = (args: string[]) => Promise<string>;

export interface OcrOutcome {
  text: string;
  languages: string;
  script: string | null;
  words: number;
  meanConfidence: number | null;
  /** More than one language set was tried for the page. */
  escalated: boolean;
  attempts: Array<{ languages: string; words: number; meanConfidence: number | null }>;
}

/** Installed Tesseract packs among `codes` (`+`-joined sets keep only their installed members). */
export function installedPacks(sets: string[], env: NodeJS.ProcessEnv = process.env, exists?: (path: string) => boolean): string[] {
  const kept: string[] = [];
  for (const set of sets) {
    const members = set.split("+").filter((code) => findTessdataDir({ env, language: code, ...(exists ? { exists } : {}) }) !== null);
    if (members.length) kept.push(members.join("+"));
  }
  return [...new Set(kept)];
}

/** The language sets to try, in order, for a page whose script was (or was not) detected. */
export function candidateLanguageSets(script: string | null, env: NodeJS.ProcessEnv = process.env, exists?: (path: string) => boolean): string[] {
  const known = script ? SCRIPT_PACKS[script] : undefined;
  const sets = known
    ? [...known, ...(script === "Latin" ? [] : ["eng"])]
    : UNKNOWN_SCRIPT_ORDER.flatMap((name) => SCRIPT_PACKS[name]!.slice(0, 1));
  const installed = installedPacks(sets, env, exists);
  return installed.length ? installed : ["eng"];
}

/**
 * OCR of one page image. `setting` is `auto` (detect the script, retry on low
 * confidence) or the workspace's own language codes.
 */
export async function ocrImageText(args: { image: string; setting?: string; run: TesseractRun; env?: NodeJS.ProcessEnv }): Promise<OcrOutcome> {
  const env = args.env ?? process.env;
  const setting = (args.setting ?? ocrLanguageSettingFromEnv(env)).trim() || OCR_AUTO;
  const attempts: OcrOutcome["attempts"] = [];
  let script: string | null = null;
  let candidates: string[];

  if (setting === OCR_AUTO) {
    try {
      script = parseOsdOutput(await args.run([args.image, "stdout", "--psm", "0", "-l", "osd"])).script;
    } catch {
      // Too little text for orientation detection: fall back to trying the common scripts.
    }
    candidates = candidateLanguageSets(script, env);
  } else {
    const parsed = ocrLanguageSchema.safeParse(setting);
    if (!parsed.success) throw new Error(`invalid OCR language: ${setting}`);
    candidates = [parsed.data];
  }

  let best: (TsvResult & { languages: string }) | null = null;
  // Confidence counts in full once a result has a handful of words; fewer words cannot outvote a longer reading.
  const score = (result: TsvResult) => (result.meanConfidence ?? 0) * Math.min(1, result.words / 5);
  for (const languages of candidates.slice(0, MAX_ATTEMPTS)) {
    const result = parseTesseractTsv(await args.run([args.image, "stdout", "-l", languages, "--psm", "3", "tsv"]));
    attempts.push({ languages, words: result.words, meanConfidence: result.meanConfidence });
    if (!best || score(result) > score(best)) best = { ...result, languages };
    // Confident text needs no second opinion. Nothing read is a blank page once the script is known, or once two
    // different packs both found nothing (script detection also fails on blank pages).
    if ((result.meanConfidence ?? 0) >= OCR_RETRY_BELOW_CONFIDENCE) break;
    if (result.words === 0 && (script !== null || attempts.filter((attempt) => attempt.words === 0).length >= 2 || setting !== OCR_AUTO)) break;
  }

  const outcome = best!;
  if (outcome.words >= MIN_WORDS_TO_JUDGE && (outcome.meanConfidence ?? 0) < OCR_REJECT_BELOW_CONFIDENCE) {
    throw new OcrLowConfidenceError(outcome.languages, outcome.meanConfidence ?? 0, outcome.words, script);
  }
  return {
    text: outcome.text,
    languages: outcome.languages,
    script,
    words: outcome.words,
    meanConfidence: outcome.meanConfidence,
    escalated: attempts.length > 1,
    attempts,
  };
}

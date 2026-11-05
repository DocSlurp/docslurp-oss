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
 * named by the project (`eng+deu`) is used as given.
 */

export const OCR_AUTO = "auto";

/** Mean word confidence below which a result is retried with other packs. */
export const OCR_RETRY_BELOW_CONFIDENCE = 60;
/** Mean word confidence below which a result with enough words is junk and is refused. */
export const OCR_REJECT_BELOW_CONFIDENCE = 40;
/** A result with fewer words than this cannot be judged junk. */
const MIN_WORDS_TO_JUDGE = 8;
/**
 * Trial runs per page in `auto`: the language sets tried before the best reading stands. Script detection plus five sets
 * ran ~40-50 s on a hard page. With the script detected, three sets cover its own pack, its wider pack and English. With
 * the script unknown (detection fails on a page with little text, and an Arabic scan then needs the fourth common script)
 * the cap is the five sets the unknown-script order reaches, still bounded by the page's time budget and by the rule that
 * two empty reads end a blank page. `DOCSLURP_OCR_MAX_ATTEMPTS` (1 to 5) overrides both; a language the project names is one
 * run whatever this says.
 */
export const OCR_MAX_ATTEMPTS = 3;
export const OCR_MAX_ATTEMPTS_UNKNOWN_SCRIPT = 5;
/** Wall-clock budget for one page across script detection and every trial run; no further trial starts past it. */
export const OCR_PAGE_BUDGET_MS = 60_000;

/** Trial runs per page this worker allows (`DOCSLURP_OCR_MAX_ATTEMPTS`, an integer from 1 to 5, else the default for the script). */
export function ocrMaxAttempts(env: NodeJS.ProcessEnv = process.env, scriptKnown = true): number {
  const parsed = Number(env.DOCSLURP_OCR_MAX_ATTEMPTS?.trim());
  if (Number.isInteger(parsed) && parsed >= 1) return Math.min(5, parsed);
  return scriptKnown ? OCR_MAX_ATTEMPTS : OCR_MAX_ATTEMPTS_UNKNOWN_SCRIPT;
}

/** Milliseconds one page's OCR may run before no further trial starts (`DOCSLURP_OCR_PAGE_BUDGET_MS`, at least 1,000). */
export function ocrPageBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.DOCSLURP_OCR_PAGE_BUDGET_MS?.trim());
  return Number.isFinite(parsed) && parsed >= 1_000 ? Math.floor(parsed) : OCR_PAGE_BUDGET_MS;
}

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
  /** Trials were cut short by the attempt cap or the page's time budget before a confident reading. */
  capped: "attempts" | "time" | null;
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
 * confidence) or the project's own language codes.
 */
export async function ocrImageText(args: {
  image: string;
  setting?: string;
  run: TesseractRun;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Which traineddata files exist (tests); defaults to the filesystem. */
  exists?: (path: string) => boolean;
}): Promise<OcrOutcome> {
  const env = args.env ?? process.env;
  const now = args.now ?? Date.now;
  const started = now();
  const budgetMs = ocrPageBudgetMs(env);
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
    candidates = candidateLanguageSets(script, env, args.exists);
  } else {
    const parsed = ocrLanguageSchema.safeParse(setting);
    if (!parsed.success) throw new Error(`invalid OCR language: ${setting}`);
    candidates = [parsed.data];
  }

  const maxAttempts = ocrMaxAttempts(env, script !== null);
  let best: (TsvResult & { languages: string }) | null = null;
  // Confidence counts in full once a result has a handful of words; fewer words cannot outvote a longer reading.
  const score = (result: TsvResult) => (result.meanConfidence ?? 0) * Math.min(1, result.words / 5);
  let capped: OcrOutcome["capped"] = null;
  for (const [index, languages] of candidates.entries()) {
    if (index >= maxAttempts) { capped = "attempts"; break; }
    // The first trial always runs; a later one starts only inside the page's time budget.
    if (index > 0 && now() - started >= budgetMs) { capped = "time"; break; }
    const result = parseTesseractTsv(await args.run([args.image, "stdout", "-l", languages, "--psm", "3", "tsv"]));
    attempts.push({ languages, words: result.words, meanConfidence: result.meanConfidence });
    if (!best || score(result) > score(best)) best = { ...result, languages };
    // Confident text needs no second opinion. Nothing read is a blank page once the script is known, or once two
    // different packs both found nothing (script detection also fails on blank pages).
    if ((result.meanConfidence ?? 0) >= OCR_RETRY_BELOW_CONFIDENCE) { capped = null; break; }
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
    capped,
    attempts,
  };
}

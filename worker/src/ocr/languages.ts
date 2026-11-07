/*
 * OCR language settings keep their public vocabulary (`auto`, or three-letter codes such as `eng`, `chi_sim`, `eng+deu`;
 * `ocrLanguageSchema`) and map here to PP-OCR recogniser families. One PP-OCRv6 `small` model reads Chinese, Japanese,
 * English and the Latin-script languages; the PP-OCRv5 mobile recognisers cover Korean, East Slavic Cyrillic, Arabic,
 * Devanagari, Greek and Thai. Benchmark: docs/evals/ocr-replacement-benchmark (app repo), section 4.2.
 */
import { ocrLanguageSchema } from "@docslurp/shared";

export const OCR_RECOGNISERS = ["multi", "korean", "eslav", "arabic", "devanagari", "greek", "thai"] as const;
export type OcrRecogniser = (typeof OCR_RECOGNISERS)[number];

export const OCR_AUTO = "auto";

/**
 * Families PP-OCR reads poorly where a hosted model was measured better (Arabic BCER 0.16-0.28, Devanagari 0.08 on clean
 * synthetic pages): every page read with one of these is escalated when escalation is enabled.
 */
export const ESCALATE_RECOGNISERS: readonly OcrRecogniser[] = ["arabic", "devanagari"];

/** Three-letter codes (the part before any `_suffix`) by recogniser family. Anything else Latin-script reads as `multi`. */
const FAMILY_CODES: Record<Exclude<OcrRecogniser, "multi">, readonly string[]> = {
  korean: ["kor"],
  eslav: ["rus", "ukr", "bel", "bul", "srp", "mkd", "kaz", "kir", "mon", "tgk", "tat", "bak", "chv", "uzb_cyrl"],
  arabic: ["ara", "fas", "per", "urd", "pus", "uig", "snd", "kur"],
  devanagari: ["hin", "mar", "nep", "san", "bho", "mai", "new"],
  greek: ["ell", "grc", "gre"],
  thai: ["tha"],
};

/**
 * Codes no recogniser reads (scripts PP-OCR has no model for). A page in one of these is read by `multi` and always
 * escalated, so the hosted reader decides; without escalation the text is what `multi` saw.
 */
const UNSUPPORTED_CODES = new Set(["heb", "yid", "ben", "asm", "tam", "tel", "kan", "mal", "guj", "pan", "ori", "sin", "mya", "khm", "lao", "tib", "bod", "amh", "geo", "kat", "hye", "arm", "div", "syr", "chr", "iku"]);

/** Order tried under `auto` after `multi`: widest use first. */
const AUTO_ORDER: readonly OcrRecogniser[] = ["multi", "eslav", "korean", "arabic", "devanagari", "greek", "thai"];

export interface OcrLanguagePlan {
  /** Recognisers to try, in order, while a frame's confidence stays low. */
  recognisers: OcrRecogniser[];
  /** The setting named a script no recogniser reads: escalate every page. */
  unsupportedScript: boolean;
  /** The setting as resolved (`auto` or codes), for logs and ledger metadata. */
  setting: string;
}

/**
 * The worker's default OCR language (`DOCSLURP_OCR_LANGUAGE`): codes such as `eng`, or empty/`auto`. Throws on anything else,
 * so a typo stops the worker at startup.
 */
export function ocrLanguageSettingFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DOCSLURP_OCR_LANGUAGE?.trim();
  if (!value || value === OCR_AUTO) return OCR_AUTO;
  const parsed = ocrLanguageSchema.safeParse(value);
  if (!parsed.success) throw new Error("DOCSLURP_OCR_LANGUAGE must be auto or language codes such as eng or eng+deu");
  return parsed.data;
}

/** The project's setting when it names languages; otherwise (`auto` or unset) the worker's `DOCSLURP_OCR_LANGUAGE`. */
export function effectiveOcrLanguageSetting(setting: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const value = setting?.trim();
  if (value && value !== OCR_AUTO) return value;
  return ocrLanguageSettingFromEnv(env);
}

/** Recogniser family for one code (`chi_sim_vert` → `multi`, `rus` → `eslav`), or null for a script no model reads. */
export function recogniserForCode(code: string): OcrRecogniser | null {
  const base = code.trim().toLowerCase();
  const head = base.split("_")[0]!;
  if (UNSUPPORTED_CODES.has(head)) return null;
  for (const [family, codes] of Object.entries(FAMILY_CODES) as Array<[Exclude<OcrRecogniser, "multi">, readonly string[]]>) {
    if (codes.includes(base) || codes.includes(head)) return family;
  }
  return "multi";
}

/** Trial runs per page (`DOCSLURP_OCR_MAX_ATTEMPTS`, 1 to 7); default 3 under `auto`. A named language tries only its families. */
export function ocrMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.DOCSLURP_OCR_MAX_ATTEMPTS?.trim());
  if (Number.isInteger(parsed) && parsed >= 1) return Math.min(OCR_RECOGNISERS.length, parsed);
  return 3;
}

/** The recogniser plan for a project setting (`auto`, `eng`, `eng+kor`). Throws on a malformed setting. */
export function planOcrLanguages(setting: string | undefined, env: NodeJS.ProcessEnv = process.env): OcrLanguagePlan {
  const resolved = effectiveOcrLanguageSetting(setting, env);
  if (resolved === OCR_AUTO) {
    return { recognisers: AUTO_ORDER.slice(0, ocrMaxAttempts(env)), unsupportedScript: false, setting: OCR_AUTO };
  }
  const parsed = ocrLanguageSchema.safeParse(resolved);
  if (!parsed.success) throw new Error(`invalid OCR language: ${resolved}`);
  const families: OcrRecogniser[] = [];
  let unsupportedScript = false;
  for (const code of parsed.data.split("+")) {
    const family = recogniserForCode(code);
    if (family === null) unsupportedScript = true;
    const chosen = family ?? "multi";
    if (!families.includes(chosen)) families.push(chosen);
  }
  // A script-specific recogniser first: `multi` would read Korean or Arabic as junk with high confidence.
  families.sort((a, b) => (a === "multi" ? 1 : 0) - (b === "multi" ? 1 : 0));
  return { recognisers: families, unsupportedScript, setting: parsed.data };
}

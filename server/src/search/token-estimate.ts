import { hasCjk } from "./text-fold.js";

/**
 * A script-aware token estimate for text no tokenizer has counted. `length / 4` is an English rule and
 * undercounts everything else by 2x to 4x (a CJK character is about one token, a Cyrillic or accented word
 * several), which understates context budgets and fallback usage. Reported usage always wins over this.
 * Characters per token: 4 for ASCII, 2 for other alphabetic scripts, 1 for CJK, kana and Hangul.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0;
  let otherScript = 0;
  let cjk = 0;
  for (const char of text) {
    if (char.codePointAt(0)! < 0x80) ascii += 1;
    else if (hasCjk(char)) cjk += 1;
    else otherScript += 1;
  }
  return Math.ceil(ascii / 4 + otherScript / 2 + cjk);
}

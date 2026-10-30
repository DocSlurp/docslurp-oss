/**
 * Collapses padding whitespace in vision/OCR transcriptions before they are stored.
 *
 * Some vision models pad Markdown with long runs of wide spaces (U+3000 ideographic space, NBSP, the U+2000
 * block), even on English pages, and sprinkle zero-width characters. Outside fenced code blocks:
 *
 * - a run of 2+ space separators that contains a non-ASCII one becomes one ASCII space, except a single U+3000
 *   is kept between CJK characters and at a line start (CJK paragraph indent) when the run had one;
 * - zero-width space and BOM (U+200B, U+FEFF) are removed; ZWNJ/ZWJ (U+200C/U+200D) are removed unless they
 *   join two letters or marks, where they carry spelling (Persian, Indic) or emoji sequences;
 * - trailing whitespace (those characters, ASCII spaces, tabs and CR) is stripped at line ends, so a padded
 *   line becomes empty, and 3+ consecutive blank lines collapse to 2.
 *
 * Runs of ASCII spaces alone are left as they are. One pass over the lines; lines without a non-ASCII space
 * or trailing whitespace are kept as the same string.
 */

const WIDE_SPACE = "\u00A0\u2000-\u200A\u202F\u205F\u3000";
const ZERO_WIDTH = "\u200B-\u200D\uFEFF";
/** Any character this module may rewrite inside a line (fast-path test). */
const SPECIAL = new RegExp(`[${WIDE_SPACE}${ZERO_WIDTH}]`);
const SPACE_RUN = new RegExp(`[ ${WIDE_SPACE}]{2,}`, "g");
const WIDE_IN_RUN = new RegExp(`[${WIDE_SPACE}]`);
const ZERO_WIDTH_DROP = /[\u200B\uFEFF]|(?<![\p{L}\p{M}])[\u200C\u200D]|[\u200C\u200D](?![\p{L}\p{M}])/gu;
const TRAILING = new RegExp(`[ \\t\\r${WIDE_SPACE}${ZERO_WIDTH}]+$`);
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

function isCjk(code: number): boolean {
  return (code >= 0x2e80 && code <= 0x2fdf) // radicals
    || (code >= 0x3001 && code <= 0x33ff) // CJK punctuation, kana, bopomofo, compatibility (not U+3000)
    || (code >= 0x3400 && code <= 0x4dbf) // extension A
    || (code >= 0x4e00 && code <= 0x9fff) // unified ideographs
    || (code >= 0xac00 && code <= 0xd7af) // Hangul syllables
    || (code >= 0xf900 && code <= 0xfaff) // compatibility ideographs
    || (code >= 0xff00 && code <= 0xffef) // half/full-width forms
    || (code >= 0x20000 && code <= 0x3134f); // extensions B-G (surrogate pairs)
}

function cjkBefore(line: string, index: number): boolean {
  if (index <= 0) return false;
  const low = line.charCodeAt(index - 1);
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) return isCjk(line.codePointAt(index - 2) ?? 0);
  return isCjk(low);
}

function collapseRun(run: string, offset: number, line: string): string {
  if (!WIDE_IN_RUN.test(run)) return run;
  const ideographic = run.includes("\u3000");
  if (ideographic && (offset === 0 || (cjkBefore(line, offset) && isCjk(line.codePointAt(offset + run.length) ?? 0)))) return "\u3000";
  return " ";
}

function normalizeLine(line: string): string {
  if (SPECIAL.test(line)) {
    line = line.replace(ZERO_WIDTH_DROP, "").replace(SPACE_RUN, collapseRun);
  }
  return endsWithSpace(line) ? line.replace(TRAILING, "") : line;
}

/** Cheaper than testing TRAILING, which re-scans from every space inside a long line. */
function endsWithSpace(line: string): boolean {
  if (!line) return false;
  const code = line.charCodeAt(line.length - 1);
  return code === 0x20 || code === 0x09 || code === 0x0d || (code >= 0xa0 && SPECIAL.test(line[line.length - 1]!));
}

export function normalizeVisionWhitespace(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  let fence: string | null = null;
  let blanks = 0;
  let write = 0;
  for (let read = 0; read < lines.length; read += 1) {
    const original = lines[read]!;
    if (fence) {
      // Code is kept byte for byte; a closing fence repeats the opening character at least as many times.
      const close = FENCE.exec(original);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length && !original.slice(close[0].length).trim()) fence = null;
      lines[write++] = original;
      blanks = 0;
      continue;
    }
    const open = FENCE.exec(original);
    if (open && !(open[1]![0] === "`" && original.slice(open[0].length).includes("`"))) {
      fence = open[1]!;
      lines[write++] = endsWithSpace(original) ? original.replace(TRAILING, "") : original;
      blanks = 0;
      continue;
    }
    const line = normalizeLine(original);
    if (line === "") {
      blanks += 1;
      if (blanks > 2) continue;
    } else {
      blanks = 0;
    }
    lines[write++] = line;
  }
  lines.length = write;
  return lines.join("\n");
}

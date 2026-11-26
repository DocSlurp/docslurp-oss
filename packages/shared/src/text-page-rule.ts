/*
 * The text page rule: pages of a text file from its decoded text. Pure and dependency-free, so the parser VM's text-pages
 * guest (worker/scripts/text-pages.mjs) loads it without the rest of the package.
 */

/** Text pages: one per TEXT_PAGE_LINES lines or per TEXT_PAGE_CHARS characters, whichever is more. */
export const TEXT_PAGE_LINES = 60;
export const TEXT_PAGE_CHARS = 3_500;

/** East Asian characters carry about three times the content of a Latin one, so each counts as this many characters toward a page. */
export const TEXT_PAGE_CJK_WEIGHT = 3;

function isCjkCodePoint(code: number): boolean {
  return (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff66 && code <= 0xff9f)
    || (code >= 0x20000 && code <= 0x2fa1f);
}

function asciiLower(code: number): number {
  return code >= 65 && code <= 90 ? code + 32 : code;
}

/** Index of lower-case ASCII `needle` in `text` ignoring ASCII case, from `from`; -1 when absent. */
function indexOfAsciiInsensitive(text: string, needle: string, from: number): number {
  for (let at = from; at + needle.length <= text.length; at++) {
    let hit = true;
    for (let offset = 0; offset < needle.length && hit; offset++) hit = asciiLower(text.charCodeAt(at + offset)) === needle.charCodeAt(offset);
    if (hit) return at;
  }
  return -1;
}

/** Longest stretch of text measured in full; a longer file is measured on its first part and scaled. */
export const TEXT_MEASURE_SAMPLE_CHARS = 2_000_000;

/**
 * The visible text of HTML: tags, comments, scripts and styles removed. Markup is not content a page holds.
 * One forward pass: every search starts at the cursor and a search that finds nothing is never repeated, so
 * hostile input ("<a" repeated, unclosed comments or scripts) costs O(n).
 */
export function stripHtmlMarkup(text: string): string {
  const parts: string[] = [];
  // Literal text from `pending` is not yet copied: a "<" that is not markup stays in it, so a flood of them is
  // one slice instead of one part each.
  let pending = 0;
  let at = 0;
  // Position of the next ">" at or after the last search, or -1 once none remains, so a "<" that never
  // closes does not rescan the rest of the file.
  let nextClose = -2;
  const closeFrom = (from: number): number => {
    if (nextClose === -1 || nextClose >= from) return nextClose;
    nextClose = text.indexOf(">", from);
    return nextClose;
  };
  const skip = (open: number, resume: number, replacement: string) => {
    if (open > pending) parts.push(text.slice(pending, open));
    if (replacement) parts.push(replacement);
    pending = resume;
    at = resume;
  };
  while (at < text.length) {
    const open = text.indexOf("<", at);
    if (open < 0) break;
    if (text.startsWith("<!--", open)) {
      const close = text.indexOf("-->", open + 4);
      skip(open, close < 0 ? text.length : close + 3, "");
      continue;
    }
    const first = text.charCodeAt(open + 1);
    const lowerFirst = asciiLower(first);
    // Only "<s..." can open a script or style.
    const block = lowerFirst === 115 ? ["script", "style"].find((name) => {
      if (indexOfAsciiInsensitive(text.slice(open, open + name.length + 2), `<${name}`, 0) !== 0) return false;
      const next = text.charAt(open + name.length + 1);
      return next === ">" || next === "/" || next === " " || next === "\t" || next === "\n" || next === "\r" || next === "\f";
    }) : undefined;
    if (block) {
      // No closing tag swallows the rest of the file, as a browser would.
      const close = indexOfAsciiInsensitive(text, `</${block}`, open);
      const end = close < 0 ? -1 : text.indexOf(">", close);
      skip(open, end < 0 ? text.length : end + 1, "");
      continue;
    }
    const tagStart = first === 33 || first === 47 || first === 63 || (lowerFirst >= 97 && lowerFirst <= 122);
    const end = tagStart ? closeFrom(open) : -1;
    if (end < 0) {
      // Not a tag, or no ">" anywhere after it: a literal "<".
      at = open + 1;
      continue;
    }
    skip(open, end + 1, "\n");
  }
  if (pending < text.length) parts.push(text.slice(pending));
  return parts.join("");
}

/**
 * Pages of a text file: one per TEXT_PAGE_LINES lines or per TEXT_PAGE_CHARS characters, whichever is more. East Asian
 * characters count TEXT_PAGE_CJK_WEIGHT each. With `markup` (HTML) the tags, scripts and styles are removed first and
 * only non-blank lines count, so markup and inline code do not bill as pages of reading. The first
 * TEXT_MEASURE_SAMPLE_CHARS are measured and a longer text is scaled by its length, so the cost is bounded.
 */
export function textPageCount(text: string, options: { markup?: boolean } = {}): number {
  if (text.length > TEXT_MEASURE_SAMPLE_CHARS) {
    const sampled = measuredTextPages(text.slice(0, TEXT_MEASURE_SAMPLE_CHARS), options);
    return Math.max(1, Math.ceil(sampled * (text.length / TEXT_MEASURE_SAMPLE_CHARS)));
  }
  return measuredTextPages(text, options);
}

/** Whether `code` is a character String.prototype.trim removes (ECMAScript WhiteSpace and LineTerminator). */
function isTrimSpace(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a)
    || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/**
 * The same text rule as textPageCount over the whole text, never sampled: the worker's measured count of a text file, which
 * billing reads (worker/src/lib/text-page-count.ts). The caller bounds the text's size.
 *
 * Counted by one scan with constant extra memory (no split into lines: a 128 MiB file of newlines would otherwise build an
 * array of about 134 million strings). Lines are the "\n" characters plus one ("\r\n" is one break, a lone "\r" none),
 * as `split(/\r?\n/)` counts them; with `markup`, only lines holding a character `trim` keeps.
 */
export function measuredTextPages(text: string, options: { markup?: boolean } = {}): number {
  const visible = options.markup ? stripHtmlMarkup(text) : text;
  let lines = 0;
  if (options.markup) {
    let content = false;
    for (let at = 0; at < visible.length; at++) {
      const code = visible.charCodeAt(at);
      if (code === 10) {
        if (content) lines++;
        content = false;
      } else if (!content && !isTrimSpace(code)) content = true;
    }
    if (content) lines++;
  } else {
    lines = 1;
    for (let at = visible.indexOf("\n"); at >= 0; at = visible.indexOf("\n", at + 1)) lines++;
  }
  // Characters of the trimmed text, East Asian code points weighted.
  let start = 0, end = visible.length;
  while (start < end && isTrimSpace(visible.charCodeAt(start))) start++;
  while (end > start && isTrimSpace(visible.charCodeAt(end - 1))) end--;
  let chars = end - start;
  for (let at = start; at < end; at++) {
    let code = visible.charCodeAt(at);
    if (code >= 0xd800 && code <= 0xdbff && at + 1 < end) {
      const low = visible.charCodeAt(at + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = (code - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
        at++;
      }
    }
    if (isCjkCodePoint(code)) chars += TEXT_PAGE_CJK_WEIGHT - 1;
  }
  return Math.max(1, Math.ceil(lines / TEXT_PAGE_LINES), Math.ceil(chars / TEXT_PAGE_CHARS));
}

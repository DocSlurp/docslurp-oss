const EXTRA_LIGATURES: Record<string, string> = {
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
  "ﬅ": "st",
  "ﬆ": "st",
};

const EXTRA_LIGATURE_PATTERN = new RegExp(
  `[${Object.keys(EXTRA_LIGATURES).join("")}]`,
  "g",
);

/**
 * Canonical (NFC) composition only. Compatibility forms such as superscripts,
 * fractions, full-width and math letters are content and stay as written;
 * PDF ligatures are expanded explicitly.
 */
export function normalizeExtractedText(value: string): string {
  return value
    .normalize("NFC")
    .replace(EXTRA_LIGATURE_PATTERN, (match) => EXTRA_LIGATURES[match] ?? match)
    .replace(/\u00ad/g, "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\u00a0/g, " ");
}

/**
 * Full-width ASCII (`ｆｏｏ１２`) read as ASCII. For matching and identifiers
 * only; stored and displayed text keeps the characters as written.
 */
export function foldFullWidthAscii(value: string): string {
  return value.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

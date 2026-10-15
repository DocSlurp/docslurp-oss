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

export function normalizeExtractedText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(EXTRA_LIGATURE_PATTERN, (match) => EXTRA_LIGATURES[match] ?? match)
    .replace(/\u00ad/g, "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\u00a0/g, " ");
}

/** Bound the one-time summary generation input independently of document size. */
export const SUMMARY_INPUT_MAX_CHARS = 24_000;

/**
 * Small documents retain their full text. For larger documents, keep a sampled
 * outline and evenly spaced excerpts, including the beginning and end. This
 * deterministic, linear scan avoids another model or embedding call just to
 * choose summary evidence. It is a topic overview, not exhaustive extraction.
 */
export function selectSummaryInput(text: string, sourceSampled = false): { text: string; sampled: boolean } {
  if (text.length <= SUMMARY_INPUT_MAX_CHARS) return { text, sampled: sourceSampled };

  // Collapse exact repeated dense rows/paragraphs, retaining numbers and codes.
  // Near-identical catalog entries with changed prices must remain distinct.
  const seen = new Set<string>();
  text = text.split(/\r?\n/).filter((line) => {
    const key = line.trim().replace(/[\t ]+/g, " ");
    if (key.length < 32) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join("\n");
  if (text.length <= SUMMARY_INPUT_MAX_CHARS) return { text, sampled: sourceSampled };

  const headings = Array.from(text.matchAll(/^#{1,6}[\t ]+\S[^\r\n]*$/gm), (match) => match[0]);
  const outlineCount = Math.min(headings.length, 24);
  const outline = Array.from({ length: outlineCount }, (_, index) => {
    const position = outlineCount === 1 ? 0 : Math.round(index * (headings.length - 1) / (outlineCount - 1));
    return headings[position]!.slice(0, 160);
  }).join("\n");
  const prefix = "Representative excerpts from a longer document; omitted sections are not evidence.\n"
    + (outline ? `Sampled headings:\n${outline}\n\n` : "");
  const excerptCount = 12;
  // Reserve space for position labels and separators as well as the outline.
  const excerptLength = Math.floor((SUMMARY_INPUT_MAX_CHARS - prefix.length - excerptCount * 100) / excerptCount);
  const excerpts = Array.from({ length: excerptCount }, (_, index) => {
    const start = Math.floor(index * (text.length - excerptLength) / (excerptCount - 1));
    return `[Excerpt ${index + 1}/${excerptCount}, character ${start + 1}]\n${text.slice(start, start + excerptLength)}`;
  });
  return { text: prefix + excerpts.join("\n\n"), sampled: true };
}

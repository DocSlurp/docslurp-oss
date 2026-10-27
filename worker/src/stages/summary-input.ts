import { clipUtf8, SUMMARY_INPUT_MAX_BYTES } from "./summary-evidence.js";
export { SUMMARY_INPUT_MAX_BYTES } from "./summary-evidence.js";

/** Legacy artifacts without extraction-time page evidence use bounded, explicitly unpaged excerpts. */
export function selectSummaryInput(text: string, sourceSampled = false): { text: string; sampled: boolean } {
  if (Buffer.byteLength(text) <= SUMMARY_INPUT_MAX_BYTES) return { text, sampled: sourceSampled };
  const seen = new Set<string>();
  text = text.split(/\r?\n/).filter((line) => {
    const key = line.trim().replace(/[\t ]+/g, " ");
    if (key.length < 32) return true;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).join("\n");
  if (Buffer.byteLength(text) <= SUMMARY_INPUT_MAX_BYTES) return { text, sampled: sourceSampled };
  const headings = Array.from(text.matchAll(/^#{1,6}[\t ]+[^\r\n]+/gm), (match) => match[0]);
  const outline = [headings[0], headings.at(-1)].filter(Boolean).map((heading) => clipUtf8(heading!, 160)).join("\n");
  const header = outline + "\nSampled excerpts; page references unavailable. Omitted text is unknown.\n";
  const allowance = Math.floor((SUMMARY_INPUT_MAX_BYTES - Buffer.byteLength(header) - 200) / 4);
  const slices = [0, 1, 2, 3].map((i) => {
    const start = Math.floor(i * Math.max(0, text.length - allowance) / 3);
    const excerpt = i === 3
      ? Buffer.from(text.slice(-allowance)).subarray(-allowance).toString("utf8").replace(/^\uFFFD+/u, "")
      : clipUtf8(text.slice(start, start + allowance), allowance);
    return `[Character ${(i === 3 ? text.length - excerpt.length : start) + 1}]\n${excerpt}`;
  });
  return { text: header + slices.join("\n\n"), sampled: true };
}

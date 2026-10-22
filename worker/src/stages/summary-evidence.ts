import { createHash } from "node:crypto";

export const SUMMARY_INPUT_MAX_BYTES = 10_000;
export const SUMMARY_EVIDENCE_MAX_BYTES = 12_000;
export const SUMMARY_MAX_PAGES = 10;

export interface SummaryEvidence {
  version: 1;
  documentId: string;
  sourceUri: string;
  text: string;
  sourceBytes: number;
  sampled: boolean;
  totalPages: number | null;
  pages: Array<{ pageNumber: number; clipped: boolean }>;
  pageReferences: "verified" | "unavailable";
}

export function clipUtf8(text: string, bytes: number): string {
  // Slice UTF-16 first so callers cannot allocate a buffer for a giant page.
  return Buffer.from(text.slice(0, bytes)).subarray(0, bytes).toString("utf8").replace(/\uFFFD+$/u, "");
}

/** Stable across retries; opening metadata/contents, final page, and one page per remaining stratum. */
export function selectSummaryPages(total: number, seed: string): number[] {
  if (total <= SUMMARY_MAX_PAGES) return Array.from({ length: total }, (_, i) => i);
  const selected = [0, 1, 2, total - 1];
  const slots = SUMMARY_MAX_PAGES - selected.length;
  for (let i = 0; i < slots; i++) {
    const start = 3 + Math.floor(i * (total - 4) / slots);
    const end = 3 + Math.floor((i + 1) * (total - 4) / slots);
    const hash = createHash("sha256").update(`${seed}:${i}`).digest().readUInt32BE();
    selected.push(start + hash % (end - start));
  }
  return selected.sort((a, b) => a - b);
}

/** Extraction already owns the text. Two linear scans, at most ten retained excerpts; no page-sized copies. */
export function buildSummaryEvidence(args: {
  text: string; pageCount: number; documentId: string; sourceUri: string;
}): SummaryEvidence {
  const { text } = args;
  let separators = 0;
  for (let at = text.indexOf("\f"); at >= 0; at = text.indexOf("\f", at + 1)) separators++;
  const trailingSeparator = text.endsWith("\f");
  const actualPages = separators + (trailingSeparator ? 0 : 1);
  const verified = args.pageCount > 0 && actualPages === args.pageCount;
  const sourceBytes = Buffer.byteLength(text);
  const base = { version: 1 as const, documentId: args.documentId, sourceUri: args.sourceUri,
    sourceBytes, totalPages: args.pageCount > 0 ? args.pageCount : null };
  if (!verified) {
    // Never turn proportional character positions into invented page numbers.
    const starts = [0, Math.floor(text.length / 2), Math.max(0, text.length - 2500)];
    const complete = sourceBytes <= 8000;
    const evidenceText = complete ? text : starts.map((start, index) => {
      const excerpt = index === 2
        ? Buffer.from(text.slice(start)).subarray(-2500).toString("utf8").replace(/^\uFFFD+/u, "")
        : clipUtf8(text.slice(start, start + 2500), 2500);
      const offset = index === 2 ? text.length - excerpt.length : start;
      return `[Character offset ${offset}; page unknown]\n${excerpt}`;
    }).join("\n\n");
    return fitEnvelope({ ...base, text: evidenceText, sampled: !complete,
      pages: [], pageReferences: "unavailable" });
  }
  const selected = new Set(selectSummaryPages(actualPages, args.documentId));
  const seenRows = new Set<string>();
  const excerpts: Array<{ pageNumber: number; text: string; clipped: boolean }> = [];
  let start = 0;
  for (let page = 0; page < actualPages; page++) {
    const boundary = text.indexOf("\f", start);
    const end = boundary < 0 ? text.length : boundary;
    if (selected.has(page)) {
      // Only normalize a bounded prefix, including for a pathological enormous single page.
      const prefix = text.slice(start, Math.min(end, start + SUMMARY_INPUT_MAX_BYTES));
      excerpts.push({ pageNumber: page + 1,
        text: clipUtf8(prefix, SUMMARY_INPUT_MAX_BYTES).replace(/[\t ]+/g, " ").replace(/\n{3,}/g, "\n\n")
          .split("\n").filter((row) => {
            const key = row.trim();
            if (key.length < 32) return true;
            if (seenRows.has(key)) return false;
            seenRows.add(key); return true;
          }).join("\n"),
        clipped: end - start > prefix.length || Buffer.byteLength(prefix) > SUMMARY_INPUT_MAX_BYTES });
    }
    start = end + 1;
  }
  const header = `Evidence selected from up to ${excerpts.length} of ${actualPages} PDF/document pages. Page positions are not printed labels. Omitted pages and clipped text are unknown.\n`;
  const labels = excerpts.map((p) => `\n[Page ${p.pageNumber}/${actualPages}]\n`);
  let remaining = SUMMARY_INPUT_MAX_BYTES - Buffer.byteLength(header + labels.join(""));
  const allocations = excerpts.map(() => 0);
  while (remaining > 0) {
    const eligible = excerpts.map((p, i) => ({ p, i })).filter(({ p, i }) => allocations[i]! < Buffer.byteLength(p.text));
    if (!eligible.length) break;
    const share = Math.max(1, Math.floor(remaining / eligible.length));
    for (const { p, i } of eligible) {
      const take = Math.min(remaining, share, Buffer.byteLength(p.text) - allocations[i]!);
      allocations[i]! += take; remaining -= take;
    }
  }
  const clipped = excerpts.map((p, i) => p.clipped || Buffer.byteLength(p.text) > allocations[i]!);
  return fitEnvelope({ ...base, text: header + excerpts.map((p, i) => labels[i] + clipUtf8(p.text, allocations[i]!)).join(""),
    sampled: excerpts.length < actualPages || clipped.some(Boolean), pageReferences: "verified",
    pages: excerpts.map((p, i) => ({ pageNumber: p.pageNumber, clipped: clipped[i]! })) });
}

function fitEnvelope(evidence: SummaryEvidence): SummaryEvidence {
  // JSON escaping has overhead. Preserve honest metadata if exceptional content requires a final trim.
  while (Buffer.byteLength(JSON.stringify(evidence)) > SUMMARY_EVIDENCE_MAX_BYTES) {
    evidence.text = clipUtf8(evidence.text, Math.floor(Buffer.byteLength(evidence.text) * 0.8));
    evidence.sampled = true;
    // After trimming, no longer claim all listed pages are included in the text.
    evidence.pages = [];
    evidence.pageReferences = "unavailable";
    if (!evidence.text) throw new Error("Summary evidence metadata exceeds its byte budget");
  }
  return evidence;
}

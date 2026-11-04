import type { CanonicalBlock } from "@docslurp/shared";

import { normalizeNfc } from "./unicode-text.js";

/** NFC, case-folded, whitespace collapsed: the form a model's quotation and the page text are compared in. */
export function foldEvidenceText(value: string): string {
  return normalizeNfc(value).toLowerCase().replace(/\s+/g, " ").trim();
}

export interface EvidenceIndex {
  /** The blocks that carry text, in reading order. */
  blocks: CanonicalBlock[];
  /** Folded text of every block joined by one space. */
  joined: string;
  /** [start, end) of each block inside `joined`. */
  ranges: Array<[number, number]>;
}

/** Indexes a canonical document once so every quotation of a result is located without re-folding the whole text. */
export function buildEvidenceIndex(blocks: CanonicalBlock[]): EvidenceIndex {
  const carrying: CanonicalBlock[] = [];
  const ranges: Array<[number, number]> = [];
  let joined = "";
  for (const block of blocks) {
    const folded = block.text ? foldEvidenceText(block.text) : "";
    if (!folded) continue;
    if (joined) joined += " ";
    ranges.push([joined.length, joined.length + folded.length]);
    joined += folded;
    carrying.push(block);
  }
  return { blocks: carrying, joined, ranges };
}

const MIN_FRAGMENT = 12;

/**
 * Finds the blocks a quotation came from. Whitespace differences (a line
 * break, a column gap, a table cell boundary) do not matter, the quotation may
 * span several blocks, and a quotation the model elided with "..." matches on
 * its longest verbatim piece. Returns null when nothing matches.
 */
export function locateEvidence(index: EvidenceIndex, snippet: string): CanonicalBlock[] | null {
  const needle = foldEvidenceText(snippet);
  if (!needle) return null;
  const candidates = [needle];
  const pieces = needle.split(/\s*(?:\.{3}|…)\s*/).filter((piece) => piece.length >= MIN_FRAGMENT);
  if (pieces.length > 1 || (pieces.length === 1 && pieces[0] !== needle)) {
    candidates.push(pieces.sort((a, b) => b.length - a.length)[0]!);
  }
  for (const candidate of candidates) {
    const at = index.joined.indexOf(candidate);
    if (at < 0) continue;
    const end = at + candidate.length;
    const hits = index.blocks.filter((_, position) => index.ranges[position]![0] < end && index.ranges[position]![1] > at);
    if (hits.length) return hits;
  }
  return null;
}

import { splitTextIntoPagesStrict } from "@docslurp/shared";

import { atomize, foldKey, normalizeNfc } from "./unicode-text.js";

/** One model read: a run of consecutive pages (or, when pages are unknown, of text). */
export interface ReadWindow {
  text: string;
  /** 1-based pages the window covers; empty when the text has no reliable page breaks. */
  pages: number[];
}

export interface WindowPlan {
  windows: ReadWindow[];
  charsTotal: number;
  charsRead: number;
  pagesTotal: number;
  /** Pages the model read; billed instead of the document's page count. */
  pagesRead: number;
  /** The document is longer than the windows the stage may read. */
  truncated: boolean;
}

/**
 * Splits a document into model-sized reads along page boundaries (or, when the
 * text has no page breaks matching `pageCount`, along sentence boundaries).
 * At most `maxWindows` are read; if the document has more, the plan says so and
 * reports the pages actually read, so the result can carry the warning and the
 * bill can follow it.
 */
export function planStructuredWindows(args: {
  markdown: string;
  pageCount: number;
  windowChars: number;
  maxWindows: number;
}): WindowPlan {
  const markdown = normalizeNfc(args.markdown);
  const pageCount = Math.max(1, Math.trunc(args.pageCount) || 1);
  const pages = splitTextIntoPagesStrict(markdown, pageCount);
  const units: Array<{ text: string; page: number | null }> = [];
  if (pages) {
    pages.forEach((text, index) => {
      if (!text.trim()) return;
      for (const piece of atomize(text, { maxChars: args.windowChars })) if (piece.trim()) units.push({ text: piece, page: index + 1 });
    });
  } else {
    for (const piece of atomize(markdown.replace(/\f/g, "\n"), { maxChars: args.windowChars })) if (piece.trim()) units.push({ text: piece, page: null });
  }

  const all: Array<ReadWindow & { chars: number }> = [];
  let current: { parts: string[]; pages: Set<number>; chars: number } = { parts: [], pages: new Set(), chars: 0 };
  const flush = () => {
    if (!current.parts.length) return;
    all.push({ text: current.parts.join(pages ? "\n\n" : "").trim(), pages: [...current.pages].sort((a, b) => a - b), chars: current.chars });
    current = { parts: [], pages: new Set(), chars: 0 };
  };
  for (const unit of units) {
    // Pieces of one oversized page are joined without a separator; separate pages with a blank line.
    if (current.chars && current.chars + unit.text.length > args.windowChars) flush();
    current.parts.push(unit.text);
    current.chars += unit.text.length;
    if (unit.page !== null) current.pages.add(unit.page);
  }
  flush();

  const read = all.slice(0, Math.max(1, args.maxWindows));
  const charsTotal = all.reduce((sum, window) => sum + window.chars, 0);
  const charsRead = read.reduce((sum, window) => sum + window.chars, 0);
  const truncated = read.length < all.length;
  const pagesRead = !truncated
    ? pageCount
    : pages
      ? new Set(read.flatMap((window) => window.pages)).size
      : Math.max(1, Math.ceil(pageCount * (charsRead / Math.max(1, charsTotal))));
  return {
    windows: read.map(({ text, pages: windowPages }) => ({ text, pages: windowPages })),
    charsTotal,
    charsRead,
    pagesTotal: pageCount,
    pagesRead,
    truncated,
  };
}

export type RawField = { value: unknown; confidence?: number; evidence?: Array<{ text: string }> };

function present(value: unknown): boolean {
  return value !== null && value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);
}

/**
 * Combines one field's answers from several windows. A scalar keeps the most
 * confident non-null answer (the earliest on a tie); a list is the union of the
 * windows' lists, each item once. A window that found nothing never overrides
 * one that did.
 */
export function mergeFieldAnswers(answers: RawField[]): RawField {
  const found = answers.filter((answer) => present(answer.value));
  if (!found.length) return answers[0] ?? { value: null };
  if (found.every((answer) => Array.isArray(answer.value))) {
    const items = new Map<string, unknown>();
    for (const answer of found) for (const item of answer.value as unknown[]) items.set(JSON.stringify(item), item);
    return {
      value: [...items.values()],
      confidence: Math.min(...found.map((answer) => answer.confidence ?? 0.5)),
      evidence: found.flatMap((answer) => answer.evidence ?? []).slice(0, 4),
    };
  }
  let best = found[0]!;
  for (const answer of found.slice(1)) if ((answer.confidence ?? 0.5) > (best.confidence ?? 0.5)) best = answer;
  return best;
}

/**
 * A field of the model's answer for a schema key. Keys match exactly (after
 * NFC); only when the model returned a human-readable label for the key is its
 * letters-and-numbers form compared, and only when exactly one answer and one
 * schema key share that form, so two different keys never receive one answer.
 */
export function pickField<T>(fields: Record<string, T>, schemaKey: string, schemaKeys: readonly string[] = [schemaKey]): T | undefined {
  if (Object.hasOwn(fields, schemaKey)) return fields[schemaKey];
  const nfc = normalizeNfc(schemaKey);
  const exact = Object.keys(fields).filter((label) => normalizeNfc(label) === nfc);
  if (exact.length === 1) return fields[exact[0]!];
  const folded = foldKey(schemaKey);
  if (!folded) return undefined;
  if (schemaKeys.filter((key) => foldKey(key) === folded).length > 1) return undefined;
  const matches = Object.keys(fields).filter((label) => foldKey(label) === folded);
  return matches.length === 1 ? fields[matches[0]!] : undefined;
}


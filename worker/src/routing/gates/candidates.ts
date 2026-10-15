import type { Bbox, NativePdfSpan, NativePdfTable } from "../../native-pdf/types.js";
import { normalizeText, tokenize } from "./tokens.js";
import type { TableCandidate, TableCandidateSource, TableRegion } from "./types.js";

export interface RawTableCandidates {
  lines?: readonly NativePdfTable[];
  text?: readonly NativePdfTable[];
  /** Tables already produced by a cheap VLM pass (not generated here). */
  vlm?: readonly NativePdfTable[];
}

export interface RegionOptions {
  /** Boxes are one region when IoU >= this or the smaller is mostly inside the larger. */
  mergeIou: number;
  mergeContainment: number;
  /** Fraction of a span's area that must fall inside the region for its words to count as region words. */
  spanOverlap: number;
}

export const DEFAULT_REGION_OPTIONS: RegionOptions = { mergeIou: 0.5, mergeContainment: 0.8, spanOverlap: 0.5 };

const area = (b: Bbox): number => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

export function intersection(a: Bbox, b: Bbox): number {
  return area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
}

export function unionBbox(a: Bbox, b: Bbox): Bbox {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

function sameRegion(a: Bbox, b: Bbox, o: RegionOptions): boolean {
  const inter = intersection(a, b);
  if (inter <= 0) return false;
  const smaller = Math.min(area(a), area(b));
  const iou = inter / (area(a) + area(b) - inter);
  return iou >= o.mergeIou || (smaller > 0 && inter / smaller >= o.mergeContainment);
}

const rowsKey = (rows: string[][]): string => JSON.stringify(rows.map((r) => r.map(normalizeText)));

/** Visible words of the spans that sit inside `bbox`. */
export function regionTokens(spans: readonly NativePdfSpan[], bbox: Bbox, minOverlap = DEFAULT_REGION_OPTIONS.spanOverlap): string[] {
  const out: string[] = [];
  for (const s of spans) {
    if (s.invisible || s.renderMode === 3 || !s.text.trim()) continue;
    const a = area(s.bbox);
    if (a <= 0) continue;
    if (intersection(s.bbox, bbox) / a >= minOverlap) out.push(...tokenize(s.text));
  }
  return out;
}

/**
 * Groups candidate tables from every source into regions and merges identical readings. Candidate ids are
 * letters (A, B, C ...) in source order: lines, text, vlm.
 */
export function buildRegions(
  raw: RawTableCandidates,
  spans: readonly NativePdfSpan[],
  options: Partial<RegionOptions> = {},
): TableRegion[] {
  const o = { ...DEFAULT_REGION_OPTIONS, ...options };
  const items: Array<{ source: TableCandidateSource; table: NativePdfTable }> = [
    ...(raw.lines ?? []).map((table) => ({ source: "native-lines" as const, table })),
    ...(raw.text ?? []).map((table) => ({ source: "native-text" as const, table })),
    ...(raw.vlm ?? []).map((table) => ({ source: "vlm" as const, table })),
  ].filter((i) => i.table.rows.length > 0);

  const groups: Array<{ bbox: Bbox; items: typeof items }> = [];
  for (const item of items) {
    const g = groups.find((x) => sameRegion(x.bbox, item.table.bbox, o));
    if (g) {
      g.items.push(item);
      g.bbox = unionBbox(g.bbox, item.table.bbox);
    } else {
      groups.push({ bbox: item.table.bbox, items: [item] });
    }
  }
  // Boxes grew while merging: fold groups that now coincide.
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = groups.length - 1; j > i; j -= 1) {
      if (sameRegion(groups[i]!.bbox, groups[j]!.bbox, o)) {
        groups[i]!.items.push(...groups[j]!.items);
        groups[i]!.bbox = unionBbox(groups[i]!.bbox, groups[j]!.bbox);
        groups.splice(j, 1);
      }
    }
  }
  groups.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);

  return groups.map((g, ri) => {
    const candidates: TableCandidate[] = [];
    const byKey = new Map<string, TableCandidate>();
    for (const { source, table } of g.items) {
      const key = rowsKey(table.rows);
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        continue;
      }
      const c: TableCandidate = {
        id: String.fromCharCode(65 + candidates.length),
        sources: [source],
        bbox: table.bbox,
        rows: table.rows.map((r) => [...r]),
      };
      byKey.set(key, c);
      candidates.push(c);
    }
    return { id: `R${ri + 1}`, bbox: g.bbox, candidates, sourceTokens: regionTokens(spans, g.bbox, o.spanOverlap) };
  });
}

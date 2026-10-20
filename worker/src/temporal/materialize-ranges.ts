/**
 * Sandbox-safe (pure) helpers for the materializePages workflow.
 */

/** Longest range one activity handles; keeps an attempt well inside its 5 minute timeout. */
export const MATERIALIZE_MAX_RANGE_PAGES = 40;

export interface MaterializeResult {
  indexed: number[];
  blocked: number[];
  failed: Array<{ page: number; reason: string }>;
  costCredits: number;
}

/** Sorted, de-duplicated pages split into contiguous runs, each at most `maxPages` long. */
export function splitMaterializeRanges(pages: number[], maxPages = MATERIALIZE_MAX_RANGE_PAGES): number[][] {
  const sorted = [...new Set(pages.filter((p) => Number.isInteger(p) && p >= 1))].sort((a, b) => a - b);
  const ranges: number[][] = [];
  for (const page of sorted) {
    const current = ranges[ranges.length - 1];
    if (current && current[current.length - 1] === page - 1 && current.length < maxPages) current.push(page);
    else ranges.push([page]);
  }
  return ranges;
}

export function mergeMaterializeResults(results: MaterializeResult[]): MaterializeResult {
  const merged: MaterializeResult = { indexed: [], blocked: [], failed: [], costCredits: 0 };
  for (const r of results) {
    merged.indexed.push(...r.indexed);
    merged.blocked.push(...r.blocked);
    merged.failed.push(...r.failed);
    merged.costCredits += r.costCredits;
  }
  merged.indexed.sort((a, b) => a - b);
  merged.blocked.sort((a, b) => a - b);
  merged.failed.sort((a, b) => a.page - b.page);
  return merged;
}

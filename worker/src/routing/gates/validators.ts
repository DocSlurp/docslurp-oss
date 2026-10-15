import { intersection } from "./candidates.js";
import { countChars, countTokens, normalizeText, numericTokens, parseNumber } from "./tokens.js";
import type { CandidateReport, OverlapIssue, RegionReport, TableCandidate, TableRegion, ValidationIssue } from "./types.js";

export interface ValidatorOptions {
  /** Source words a candidate may drop before it is rejected. 0 = strict conservation. */
  maxDroppedWords: number;
  /** Repeated tokens beyond the native multiset a candidate may carry (merged-cell fill). */
  maxDuplicatedValues: number;
  /** Tokens absent from the native words a candidate may carry (OCR-style drift in VLM candidates). */
  maxForeignValues: number;
  /** Relative tolerance when checking a numeric total row. */
  totalTolerance: number;
  /** Regions overlapping by more than this fraction of the smaller one refuse the page. */
  overlapFraction: number;
}

export const DEFAULT_VALIDATOR_OPTIONS: ValidatorOptions = {
  maxDroppedWords: 0,
  maxDuplicatedValues: 0,
  maxForeignValues: 0,
  totalTolerance: 0.005,
  overlapFraction: 0.05,
};

const TOTAL_LABEL = /^(?:grand\s+)?(?:sub)?total|^sum\b|^totals\b/i;

/** Verifies numeric total rows (column sum of the numeric rows above, since the last total). */
export function checkTotals(rows: readonly string[][], tolerance: number): { checked: number; mismatched: number } {
  let checked = 0;
  let mismatched = 0;
  const width = Math.max(0, ...rows.map((r) => r.length));
  for (let c = 1; c < width; c += 1) {
    let sum = 0;
    let n = 0;
    for (const row of rows) {
      const label = normalizeText(row[0] ?? "");
      const value = parseNumber(row[c] ?? "");
      if (TOTAL_LABEL.test(label) && value !== null) {
        if (n >= 2) {
          checked += 1;
          if (Math.abs(sum - value) > Math.max(tolerance * Math.abs(value), 0.0051)) mismatched += 1;
        }
        sum = 0;
        n = 0;
      } else if (value !== null && !TOTAL_LABEL.test(label)) {
        sum += value;
        n += 1;
      }
    }
  }
  return { checked, mismatched };
}

export function validateCandidate(
  candidate: TableCandidate,
  sourceTokens: readonly string[],
  options: Partial<ValidatorOptions> = {},
): CandidateReport {
  const o = { ...DEFAULT_VALIDATOR_OPTIONS, ...options };
  const issues: ValidationIssue[] = [];
  const { rows } = candidate;
  const widths = new Set(rows.map((r) => r.length));
  const nonEmptyCols = new Set<number>();
  rows.forEach((r) => r.forEach((cell, i) => normalizeText(cell) && nonEmptyCols.add(i)));
  if (rows.length < 2 || nonEmptyCols.size < 2) {
    issues.push({ kind: "degenerate", detail: `${rows.length} rows x ${nonEmptyCols.size} non-empty columns`, count: 1 });
  }
  if (widths.size > 1) {
    const modal = [...widths].sort((a, b) => rows.filter((r) => r.length === b).length - rows.filter((r) => r.length === a).length)[0]!;
    issues.push({ kind: "ragged-rows", detail: `row widths ${[...widths].sort((a, b) => a - b).join("/")}`, count: rows.filter((r) => r.length !== modal).length });
  }

  if (sourceTokens.length > 0) {
    // Conservation is checked on characters (robust to how spans were split or joined into cells) and, separately,
    // on number-like tokens (a digit changed or moved between cells cannot hide in the character totals).
    const source = countChars(sourceTokens);
    const cells = rows.flat();
    const got = countChars(cells);
    let dropped = 0;
    let duplicated = 0;
    let foreign = 0;
    for (const [ch, n] of source) dropped += Math.max(0, n - (got.get(ch) ?? 0));
    for (const [ch, n] of got) {
      const s = source.get(ch) ?? 0;
      if (s === 0) foreign += n;
      else duplicated += Math.max(0, n - s);
    }
    if (dropped > o.maxDroppedWords) issues.push({ kind: "dropped-words", detail: `${dropped} native characters missing`, count: dropped });
    if (duplicated > o.maxDuplicatedValues) issues.push({ kind: "duplicated-values", detail: `${duplicated} characters repeated beyond the native count`, count: duplicated });
    if (foreign > o.maxForeignValues) issues.push({ kind: "foreign-values", detail: `${foreign} characters not present in the native text`, count: foreign });
    const srcNums = countTokens(numericTokens(sourceTokens));
    const gotNums = countTokens(numericTokens(cells));
    let numericDiff = 0;
    for (const [tok, n] of srcNums) numericDiff += Math.abs(n - (gotNums.get(tok) ?? 0));
    for (const [tok, n] of gotNums) if (!srcNums.has(tok)) numericDiff += n;
    if (numericDiff > 0) issues.push({ kind: "numeric-mismatch", detail: `${numericDiff} numeric tokens differ from the native multiset`, count: numericDiff });
  }

  return { candidateId: candidate.id, valid: issues.length === 0, issues, totals: checkTotals(rows, o.totalTolerance) };
}

/**
 * Validates every candidate of a region. A candidate whose numeric totals contradict is rejected only when a
 * sibling's totals verify (the totals alone are weak evidence: a source can contain a wrong total).
 */
export function validateRegion(region: TableRegion, options: Partial<ValidatorOptions> = {}): RegionReport {
  const reports = region.candidates.map((c) => validateCandidate(c, region.sourceTokens, options));
  const someVerified = reports.some((r) => r.totals.checked > 0 && r.totals.mismatched === 0);
  for (const r of reports) {
    if (someVerified && r.totals.mismatched > 0) {
      r.issues.push({ kind: "total-mismatch", detail: `${r.totals.mismatched}/${r.totals.checked} total rows do not add up while a sibling candidate's do`, count: r.totals.mismatched });
      r.valid = false;
    }
  }
  return { regionId: region.id, candidates: reports, survivors: reports.filter((r) => r.valid).map((r) => r.candidateId) };
}

/** Region pairs that overlap enough that composing them would supersede the same words twice. */
export function findOverlaps(regions: readonly TableRegion[], options: Partial<ValidatorOptions> = {}): OverlapIssue[] {
  const o = { ...DEFAULT_VALIDATOR_OPTIONS, ...options };
  const out: OverlapIssue[] = [];
  const areaOf = (b: [number, number, number, number]) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  for (let i = 0; i < regions.length; i += 1) {
    for (let j = i + 1; j < regions.length; j += 1) {
      const smaller = Math.min(areaOf(regions[i]!.bbox), areaOf(regions[j]!.bbox));
      if (smaller <= 0) continue;
      const fraction = intersection(regions[i]!.bbox, regions[j]!.bbox) / smaller;
      if (fraction > o.overlapFraction) out.push({ a: regions[i]!.id, b: regions[j]!.id, fraction });
    }
  }
  return out;
}

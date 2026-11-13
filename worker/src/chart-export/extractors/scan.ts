/**
 * Work accounting for the linear raw-text scanners (embedded-spec blocks, inline SVGs, the HTML strip): `steps` counts
 * the characters every `indexOf` search covered, so tests can assert O(n) on hostile input by count, not wall time.
 */
export interface ScanWork { steps: number }

/** `hay.indexOf(needle, from)`, adding the distance it searched to `work`. */
export function indexFrom(work: ScanWork | undefined, hay: string, needle: string, from: number): number {
  const at = hay.indexOf(needle, from);
  if (work) work.steps += (at < 0 ? hay.length : at) - from + 1;
  return at;
}

/**
 * Lowercase ASCII letters only. Length-preserving, so indices found in the result slice the original correctly
 * (`"İ".toLowerCase()` is two code units; council r8 M1). It is also exactly how a non-`u` `/i` regex compares ASCII
 * needles: no non-ASCII character folds onto an ASCII one there.
 */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (run) => run.toLowerCase());
}

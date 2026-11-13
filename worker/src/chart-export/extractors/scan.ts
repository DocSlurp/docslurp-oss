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

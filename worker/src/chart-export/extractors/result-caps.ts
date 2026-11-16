// Field caps every result path applies: the extractor's own result, each unit's delta before it leaves the worker, and
// the reassembly after a unit failure (council r10 M1). One copy, so a resumed or reassembled result is held to exactly
// the limits the host validates (`validateDeterministicResult`), and none can be rejected for a field the normal path
// would have cut.
import { CHART_EXTRACT_LIMITS } from "./limits.js";
import type { DeterministicRefusal, DeterministicVisual } from "./types.js";

const cap = (s: string | null, n: number) => (s === null ? null : s.slice(0, n));

export function capVisual(v: DeterministicVisual): DeterministicVisual {
  return { ...v, locator: v.locator.slice(0, 512), sheet: cap(v.sheet, 200), generator: cap(v.generator, 40), reason: cap(v.reason, 120), digest: cap(v.digest, CHART_EXTRACT_LIMITS.maxDigestChars) };
}

export function capRefusal(r: DeterministicRefusal): DeterministicRefusal {
  return { locator: r.locator.slice(0, 512), reason: r.reason.slice(0, 120) };
}

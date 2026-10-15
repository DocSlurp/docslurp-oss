/**
 * Hung work: a parser command past its wall-clock budget, or a stage whose
 * progress stopped. Retrying the same document would hang the same way and
 * hold a slot (and billed compute) for hours, so these fail the stage
 * non-retryably and the run goes straight to dead-letter
 * (temporal/failure-classification.ts, @docslurp/shared HUNG_WORK_MARKER).
 */

import { HUNG_WORK_MARKER } from "@docslurp/shared";

export class HungWorkError extends Error {
  readonly kind: "command-timeout" | "stage-stalled";

  constructor(kind: HungWorkError["kind"], message: string, options?: { cause?: unknown }) {
    // The marker survives Temporal's rootCause() so the run failure path can see it.
    super(`${HUNG_WORK_MARKER} ${message}`, options);
    this.name = "HungWorkError";
    this.kind = kind;
  }
}

/** The hung-work error in `error`'s cause chain, matched by class or by marker (errors re-wrapped by stages keep the message). */
export function findHungWorkError(error: unknown): Error | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 8; depth++) {
    if (current instanceof HungWorkError) return current;
    if (current instanceof Error && current.message.includes(HUNG_WORK_MARKER)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

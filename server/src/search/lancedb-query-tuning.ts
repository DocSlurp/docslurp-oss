/** Opt-in SQ candidate refinement; invalid configuration must not silently empty search. */
export function lanceDbQueryTuning(limit: number, documentCount: number, rawRefineFactor?: string): {
  ef?: number;
  refineFactor?: number;
} {
  const raw = rawRefineFactor?.trim();
  const refineFactor = raw ? Number(raw) : undefined;
  if (refineFactor !== undefined && (!Number.isSafeInteger(refineFactor) || refineFactor < 1 || refineFactor > 16)) {
    throw new Error("LANCEDB_REFINE_FACTOR must be an integer between 1 and 16");
  }
  const scopedEf = documentCount > 0
    ? Math.ceil(Math.min(Math.max(limit * 10, documentCount * limit), 1_000) * 1.5)
    : undefined;
  if (refineFactor === undefined) return { ef: scopedEf };
  // Lance requires ef >= the number of refined candidates, including unscoped queries.
  return { ef: Math.max(scopedEf ?? Math.ceil(limit * 1.5), limit * refineFactor), refineFactor };
}

import { searchCandidateDepthSchema, searchResultOrderSchema } from "@docslurp/shared";
import type { SearchOptions } from "../services/search.js";

type Controls = Pick<SearchOptions, "candidateDepth" | "resultOrder" | "useRerank" | "useMmr">;

/** Validate direct service callers as well as the public request schemas. */
export function validateRetrievalControls(options: Controls): void {
  if (options.candidateDepth !== undefined) searchCandidateDepthSchema.parse(options.candidateDepth);
  if (options.resultOrder !== undefined) searchResultOrderSchema.parse(options.resultOrder);
}

/** Omitted controls retain historical acquisition and postprocessing windows. */
export function acquisitionDepth(options: Controls, limit: number): number {
  // MMR needs alternatives to choose from, not just the top `limit`.
  return options.candidateDepth ?? (options.useRerank ? 200 : options.useMmr ? limit * 2 : limit);
}

export function rankingDepth(options: Controls, limit: number): number {
  return options.candidateDepth ?? (options.useRerank ? 200 : limit * 2);
}

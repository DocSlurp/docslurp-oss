/**
 * Models the system never selects on its own.
 *
 * A model on this list is never a fallback, failover, escalation, retry target, Speed boost swap, route-tier pool
 * option, page-router target or chart generator candidate. A caller or operator may still name one explicitly where a
 * catalog offers it (for example as a project's configured model); that explicit choice is not affected.
 *
 * Entries are model families: the last path segment of a model id, matched with every build (`-1017`), variant
 * (`:nitro`) and provider route (`llm://openrouter/...?_provider=...`, `vlm:openrouter/...`). Every builder of an
 * automatic list filters through `isAutomaticSelectionDenied`, and automatic-model-selection.test.ts (shared) plus the
 * worker and server lists' own tests fail if a denied family appears in one.
 */
export const NO_AUTOMATIC_SELECTION_MODEL_FAMILIES: readonly string[] = [
  // Owner decision 2026-11-13: never auto-escalate or fall back to DeepSeek V4.1 Flash, any build or route.
  "deepseek-v4.1-flash",
];

/** The model family of an id, URI or routing-target id: its last path segment, lower-cased, without query, fragment or variant. */
export function modelFamilySegment(modelOrUri: string): string {
  const withoutQuery = modelOrUri.trim().split(/[?#]/, 1)[0] ?? "";
  const segment = withoutQuery.split("/").filter(Boolean).at(-1) ?? "";
  return segment.toLowerCase().replace(/:[a-z0-9._-]+$/, "");
}

/** Whether automatic selection must never pick this model (any build, variant or route of a denied family). */
export function isAutomaticSelectionDenied(modelOrUri: string | null | undefined): boolean {
  if (!modelOrUri) return false;
  const segment = modelFamilySegment(modelOrUri);
  return NO_AUTOMATIC_SELECTION_MODEL_FAMILIES.some((family) => segment === family || segment.startsWith(`${family}-`));
}

/** `models` without the denied ones, in order. */
export function withoutAutomaticSelectionDenied<T extends string>(models: readonly T[]): T[] {
  return models.filter((model) => !isAutomaticSelectionDenied(model));
}

/** Throws when an automatic selection list names a denied model; call where such a list is defined. */
export function assertNoAutomaticSelectionDenied(label: string, models: Iterable<string | null | undefined>): void {
  const denied = [...models].filter((model): model is string => isAutomaticSelectionDenied(model));
  if (denied.length) throw new Error(`${label} names models that are never selected automatically: ${denied.join(", ")}`);
}

/**
 * Models the system never selects on its own.
 *
 * A model on this list is never a fallback, failover, escalation, retry target, Speed boost swap, route-tier pool
 * option, page-router target or chart generator candidate. A caller or operator may still name one explicitly where a
 * catalog offers it (for example as a project's configured model); that explicit choice is not affected.
 *
 * Entries are model families: the last path segment of a model id, matched with every build (`-1017`), variant
 * (`:nitro`, stacked `:extended:nitro`), provider suffix (`@fireworks`), percent-encoding (`deepseek%2Fdeepseek-...`),
 * vendor prefix (Bedrock's `deepseek.deepseek-...-v1:0`), version spelling (`v4-1`, `v4_1`, `v4p1` for `v4.1`) and
 * provider route (`llm://openrouter/...?_provider=...`, `vlm:openrouter/...`). Not caught: provider aliases that do not
 * name the family at all (`deepseek/deepseek-chat`, `~deepseek/...-latest`); a list naming one fails review, not this
 * check. Every builder of an
 * automatic list filters through `isAutomaticSelectionDenied`, and automatic-model-selection.test.ts (shared) plus the
 * worker and server lists' own tests fail if a denied family appears in one.
 */
export const NO_AUTOMATIC_SELECTION_MODEL_FAMILIES: readonly string[] = [
  // Owner decision 2026-11-13: never auto-escalate or fall back to DeepSeek V4.1 Flash, any build or route.
  "deepseek-v4.1-flash",
  "deepseek-v4p1-flash",
];

/** Percent-decoding passes before matching (`%252F` is `/` encoded twice). */
const MAX_DECODE_PASSES = 3;

function percentDecoded(value: string): string {
  let current = value;
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      // A malformed escape: decode each well-formed escape alone, so an encoded `/` still splits.
      next = current.replace(/%[0-9a-f]{2}/gi, (escape) => String.fromCharCode(Number.parseInt(escape.slice(1), 16)));
    }
    if (next === current) break;
    current = next;
  }
  return current;
}

/**
 * The model family of an id, URI or routing-target id: percent-decoded, its last path segment (`/` or `\\`),
 * lower-cased, `_` read as `-`, without query, fragment, any `:variant` (stacked ones too) or `@provider` suffix, with a one-digit minor
 * version written `v4.1` whatever the spelling (`v4-1`, `v4_1`, `v4p1`).
 */
export function modelFamilySegment(modelOrUri: string): string {
  const withoutQuery = percentDecoded(modelOrUri.trim()).split(/[?#]/, 1)[0] ?? "";
  const segment = withoutQuery.split(/[\\/]/).filter(Boolean).at(-1) ?? "";
  const bare = (segment.toLowerCase().split(/[:@]/, 1)[0] ?? "").trim().replace(/_/g, "-");
  return bare.replace(/v(\d+)[-_p](\d)(?=[-_.][a-z])/g, "v$1.$2");
}

const familyPatterns = new Map<string, RegExp>();
/** The family anywhere in the segment, between non-alphanumeric boundaries (a vendor prefix, a build, a label). */
function familyPattern(family: string): RegExp {
  let pattern = familyPatterns.get(family);
  if (!pattern) {
    const normalized = modelFamilySegment(family).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    pattern = new RegExp(`(^|[^a-z0-9])${normalized}(?![a-z0-9])`);
    familyPatterns.set(family, pattern);
  }
  return pattern;
}

/** Whether automatic selection must never pick this model (any build, variant or route of a denied family). */
export function isAutomaticSelectionDenied(modelOrUri: string | null | undefined): boolean {
  if (!modelOrUri) return false;
  const segment = modelFamilySegment(modelOrUri);
  // The family between separators: `-1017` or `.1017` builds, a vendor prefix, a label; never a longer name (`-flashy`).
  return NO_AUTOMATIC_SELECTION_MODEL_FAMILIES.some((family) => familyPattern(family).test(segment));
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

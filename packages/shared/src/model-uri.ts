// Model references: `llm://<provider>/<model>` is the canonical form for every
// model input (chat, text generation, vision, embeddings, page routing). Hosted
// OpenRouter models may also be named by their bare id (`vendor/model`), which is
// shorthand for `llm://openrouter/vendor/model`. No dependencies, so browser
// bundles can import it.

export const LLM_URI_SCHEME = "llm://";
export const OPENROUTER_MODEL_URI_PREFIX = "llm://openrouter/";

const OPENROUTER_PREFIX = /^llm:\/\/openrouter\//i;

/**
 * The OpenRouter model id inside `llm://openrouter/<id>` (variant suffixes such
 * as `:nitro` and `:free` kept). Null for any other value, including a URI with
 * a query, fragment or empty model.
 */
export function openRouterModelIdFromUri(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!OPENROUTER_PREFIX.test(trimmed)) return null;
  const id = trimmed.slice(OPENROUTER_MODEL_URI_PREFIX.length);
  if (!id || /[?#\s]/.test(id) || id.startsWith("/")) return null;
  return id;
}

/**
 * Hosted model inputs accept `llm://openrouter/<id>` and the bare `<id>`; both
 * resolve to the bare id that catalogs, prices and the provider call use. Every
 * other value (bare ids, `llm://private/...`, other providers) is returned trimmed
 * and otherwise unchanged, so the caller's own validation still decides.
 */
export function normalizeHostedModelRef(value: string): string {
  return openRouterModelIdFromUri(value) ?? value.trim();
}

/** The canonical `llm://` form of a model reference: bare OpenRouter ids gain the prefix. */
export function toModelUri(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase().startsWith(LLM_URI_SCHEME) ? trimmed : `${OPENROUTER_MODEL_URI_PREFIX}${trimmed}`;
}

/**
 * `llm://<provider>/<model>` split into its provider and model id (null for
 * anything else, including a query, fragment or missing model). Used by
 * env settings that name a model for one fixed provider family.
 */
export function parseProviderModelUri(value: string | null | undefined): { provider: string; model: string } | null {
  if (typeof value !== "string") return null;
  const match = /^llm:\/\/([a-z0-9][a-z0-9.-]*)\/([^?#\s]+)$/i.exec(value.trim());
  if (!match || match[2]!.startsWith("/")) return null;
  return { provider: match[1]!.toLowerCase(), model: match[2]! };
}

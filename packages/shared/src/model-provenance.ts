// What ran: every record of a model call names the model as one `llm://` URI, with the level that selected it and
// the request settings it ran with. Projects hold a level (a profile, a quality, a tier), never a model, so history is
// the only place that says which model a level meant at the time. No dependencies, so any package can import it.

/** Settings a call ran with: flat, small values only (reasoning effort, token cap, temperature, prompt key, role). */
export type ModelCallConfig = Record<string, string | number | boolean | null | undefined>;

/** The level that selected the model, by the names the caller knows it by (quality, tier, profiles, role). */
export type ModelCallClass = Record<string, string | number | boolean | null | undefined>;

const MAX_URI_LENGTH = 400;
const MAX_VALUE_LENGTH = 80;
/**
 * Setting names that could carry an address or a credential, wherever the word sits in the name. A private route is
 * named by its alias only; nothing about where it lives is recorded.
 */
const WITHHELD_KEYS = /url|uri|endpoint|host|addr|base|key|secret|auth|passw|bearer|header|cookie|credential|token(?!s)/i;
/** Values are plain labels: letters, digits and a little punctuation. Anything else (an address, userinfo, free text) is dropped. */
const SAFE_VALUE = /^[A-Za-z0-9][A-Za-z0-9 _.:+/-]*$/;
/** Rows that record compute, a fee or a reuse, not a call to a model: nothing ran, so nothing is named. */
const NON_MODEL_PROVIDERS = new Set(["docslurp", "local-compute", "modal", "heuristic", "reused"]);
const NON_MODEL_MODELS = new Set(["price-card", "gpu-capacity", "none"]);

function looksLikeAddress(value: string): boolean {
  return value.includes("://") || value.includes("@") || /\s/.test(value) || value.includes("\\");
}

function providerSegment(provider: string): string | null {
  // Provider labels in records are not all URI hosts (`page-reader:<id>`, `ocr-vm:<engine>`): keep them readable.
  if (looksLikeAddress(provider) || provider.includes("/")) return null;
  const cleaned = provider.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return cleaned || null;
}

function modelSegment(model: string): string | null {
  // The model id keeps its slashes and variant suffix (`vendor/model:nitro`); an address, a path with userinfo or
  // anything outside plain id characters is not a model id.
  if (looksLikeAddress(model) || !/^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/.test(model)) return null;
  return model;
}

/** The recordable settings of a record: plain names, small plain values, sorted by name; values keep their type. */
function clean(record: Record<string, unknown> | null | undefined): Array<[string, string | number | boolean]> {
  const out: Array<[string, string | number | boolean]> = [];
  for (const [key, value] of Object.entries(record ?? {})) {
    if (value === undefined || value === null || value === "" || WITHHELD_KEYS.test(key) || !/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(key)) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    // ASCII only after this check, so truncating cannot split a character.
    if (typeof value === "string" && (!SAFE_VALUE.test(value) || value.includes("://"))) continue;
    out.push([key, typeof value === "string" ? value.slice(0, MAX_VALUE_LENGTH) : value]);
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

const flat = (record: Record<string, unknown> | null | undefined): Array<[string, string]> => clean(record).map(([key, value]) => [key, String(value)]);

/**
 * The canonical record form of a model call: `llm://<provider>/<model>?<setting>=<value>&…`, settings sorted by name.
 * Null when there is no model to name, or when the provider or model is not a plain id (an address, userinfo, free
 * text). A `model` that is already an `llm://` URI keeps its provider and loses any query. Never throws.
 */
export function modelRecordUri(input: { provider?: string | null; model?: string | null; config?: ModelCallConfig | null }): string | null {
  try {
    const raw = typeof input.model === "string" ? input.model.trim() : "";
    if (!raw) return null;
    const own = /^llm:\/\/([^/?#\s]+)\/([^?#\s]+)/i.exec(raw);
    const provider = providerSegment(own ? own[1]! : typeof input.provider === "string" ? input.provider : "");
    const model = modelSegment(own ? own[2]! : raw);
    if (!provider || !model) return null;
    const base = `llm://${provider}/${model}`;
    if (base.length > MAX_URI_LENGTH) return null;
    let uri = base;
    for (const [key, value] of flat(input.config)) {
      const next = `${uri}${uri === base ? "?" : "&"}${key}=${encodeURIComponent(value)}`;
      if (next.length > MAX_URI_LENGTH) break;
      uri = next;
    }
    return uri;
  } catch {
    return null;
  }
}

/** A level as one sorted `name=value;…` string, for a text column. Null when nothing is known. */
export function modelClassLabel(modelClass: ModelCallClass | null | undefined): string | null {
  const parts = flat(modelClass).map(([key, value]) => `${key}=${value}`);
  return parts.length ? parts.join(";").slice(0, 200) : null;
}

function isModelCall(event: { provider?: string | null; model?: string | null; metadata?: Record<string, unknown> | null }): boolean {
  const provider = typeof event.provider === "string" ? event.provider.trim().toLowerCase() : "";
  const model = typeof event.model === "string" ? event.model.trim().toLowerCase() : "";
  if (!provider || !model || event.metadata?.unitCharge === true) return false;
  return !NON_MODEL_PROVIDERS.has(provider.split(/[:/]/)[0]!) && !NON_MODEL_MODELS.has(model);
}

/**
 * Stamps a usage event's metadata with what ran: `modelUri` (the model on the row, with `modelConfig` as its settings),
 * `modelConfig` reduced to its recordable settings, and `modelClass` (the caller's, over the given defaults).
 * Idempotent; an event that is not a model call is returned unchanged. Never throws: a label must not fail a ledger
 * write. Applied where events are buffered or inserted, so every recorder gets it without a change at each call site.
 */
export function withModelProvenance<Event extends { provider?: string | null; model?: string | null; metadata?: Record<string, unknown> | null }>(
  event: Event,
  defaults: { modelClass?: ModelCallClass | null } = {},
): Event {
  try {
    if (!isModelCall(event)) return event;
    const metadata = { ...(event.metadata ?? {}) };
    const record = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
    const config = Object.fromEntries(clean(record(metadata.modelConfig)));
    if (Object.keys(config).length > 0) metadata.modelConfig = config;
    else delete metadata.modelConfig;
    // Always derived from the row: a URI handed in by a caller is not trusted to be canonical or free of an address.
    const uri = modelRecordUri({ provider: event.provider, model: event.model, config });
    if (uri) metadata.modelUri = uri;
    else delete metadata.modelUri;
    const known = Object.fromEntries(clean({ ...(defaults.modelClass ?? {}), ...(record(metadata.modelClass) ?? {}) }));
    if (Object.keys(known).length > 0) metadata.modelClass = known;
    else delete metadata.modelClass;
    return { ...event, metadata };
  } catch {
    return event;
  }
}

/** What makes two vectors comparable: the model that made them, and the settings that change the space it maps into. */
export interface EmbeddingSpaceInput {
  provider?: string | null;
  model?: string | null;
  dimensions?: number | null;
  /** `cls` or `mean`; only a non-default (`cls`) pooling changes the space, so `mean` and unset name the same one. */
  pooling?: string | null;
}

/**
 * The record of an embedding space as one `llm://` URI: `llm://<provider>/<model>?dimensions=<n>[&pooling=cls]`.
 * Vector tables store it next to the bare model id: two models that share a bare id (another provider, other
 * dimensions or pooling) get different URIs, while rows written before the URI existed still match on the bare id.
 * Null when there is no plain provider and model to name. Never throws.
 */
export function embeddingSpaceUri(input: EmbeddingSpaceInput): string | null {
  const dimensions = typeof input.dimensions === "number" && Number.isInteger(input.dimensions) && input.dimensions > 0 ? input.dimensions : undefined;
  return modelRecordUri({
    provider: input.provider ?? null,
    model: input.model ?? null,
    config: { dimensions, pooling: input.pooling === "cls" ? "cls" : undefined },
  });
}

/**
 * True when a stored vector row can serve a query in `expected`'s space. A row (or a caller) without a URI falls
 * back to the bare-id match the caller already made; when both carry one, they must be equal.
 */
export function embeddingSpaceMatches(storedUri: string | null | undefined, expectedUri: string | null | undefined): boolean {
  return !storedUri || !expectedUri || storedUri === expectedUri;
}

/** The run-level settings `runModelClass` reads: structural, so this module keeps no dependency on the pipeline schema. */
export interface RunModelClassPipeline {
  quality?: string | null;
  vision?: { profile?: string | null } | null;
  embedding?: { profile?: string | null } | null;
  pageRouter?: { router?: string | null } | null;
  inferenceLane?: string | null;
  speedBoost?: boolean | null;
}

/**
 * The levels a run was configured with, as recorded next to every model it calls (the worker usage ledger's
 * `modelClass`, and `document_page_extracts.model_class` through it). Null when the run names none.
 */
export function runModelClass(pipeline: RunModelClassPipeline | null | undefined): Record<string, string> | null {
  if (!pipeline) return null;
  const levels: Record<string, string | null | undefined> = {
    quality: pipeline.quality,
    visionProfile: pipeline.vision?.profile,
    embeddingProfile: pipeline.embedding?.profile,
    pageRouter: pipeline.pageRouter?.router,
    inferenceLane: pipeline.inferenceLane,
    // Speed boost swaps hosted models for their fast hosts: part of what selected the model.
    speedBoost: pipeline.speedBoost === true ? "on" : undefined,
  };
  const known = Object.fromEntries(Object.entries(levels).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
  return Object.keys(known).length ? known : null;
}

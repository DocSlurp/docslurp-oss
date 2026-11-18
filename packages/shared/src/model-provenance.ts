// What ran: every record of a model call names the model as one `llm://` URI, with the level that selected it and
// the request settings it ran with. Projects hold a level (a profile, a quality, a tier), never a model, so history is
// the only place that says which model a level meant at the time. No dependencies, so any package can import it.

/** Settings a call ran with: flat, small values only (reasoning effort, token cap, temperature, prompt key, role). */
export type ModelCallConfig = Record<string, string | number | boolean | null | undefined>;

/** The level that selected the model, by the names the caller knows it by (quality, tier, profiles, role). */
export type ModelCallClass = Record<string, string | number | boolean | null | undefined>;

const MAX_URI_LENGTH = 400;
const MAX_VALUE_LENGTH = 80;
/** Keys that would put an address or a credential into a record. A private route is named by its alias only. */
const WITHHELD_CONFIG_KEYS = /^(?:base_?url|url|endpoint|host|api_?key|token|authorization|secret|password)$/i;

function providerSegment(provider: string): string {
  // Provider labels in records are not all URI hosts (`page-reader:<id>`, `ocr-vm:<engine>`): keep them readable.
  const cleaned = provider.trim().toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}

function modelSegment(model: string): string {
  // The model id keeps its slashes and variant suffix (`vendor/model:nitro`); anything that would start a query does not.
  return model.trim().replace(/^llm:\/\/[^/]+\//i, "").split("/").map((part) => encodeURIComponent(part).replace(/%3A/gi, ":").replace(/%40/g, "@")).join("/");
}

function flat(record: Record<string, unknown> | null | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(record ?? {})) {
    if (value === undefined || value === null || value === "" || WITHHELD_CONFIG_KEYS.test(key)) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") continue;
    if (typeof value === "number" && !Number.isFinite(value)) continue;
    out.push([key, String(value).slice(0, MAX_VALUE_LENGTH)]);
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The canonical record form of a model call: `llm://<provider>/<model>?<setting>=<value>&…`, settings sorted by name.
 * Null when there is no model to name. A `model` that is already an `llm://` URI keeps its provider.
 */
export function modelRecordUri(input: { provider?: string | null; model?: string | null; config?: ModelCallConfig | null }): string | null {
  const model = input.model?.trim();
  if (!model) return null;
  const own = /^llm:\/\/([^/?#\s]+)\/([^?#\s]+)/i.exec(model);
  const provider = own ? own[1]! : input.provider?.trim();
  if (!provider) return null;
  const base = `llm://${providerSegment(provider)}/${modelSegment(own ? own[2]! : model)}`;
  const query = flat(input.config).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
  const uri = query ? `${base}?${query}` : base;
  return uri.length <= MAX_URI_LENGTH ? uri : base.slice(0, MAX_URI_LENGTH);
}

/** A level as one sorted `name=value;…` string, for a text column. Null when nothing is known. */
export function modelClassLabel(modelClass: ModelCallClass | null | undefined): string | null {
  const parts = flat(modelClass).map(([key, value]) => `${key}=${value}`);
  return parts.length ? parts.join(";").slice(0, 200) : null;
}

/** Usage rows that are a charge or a fee, not a model call: nothing ran, so nothing is named. */
function isModelCall(event: { provider?: string | null; model?: string | null }): boolean {
  const model = event.model?.trim().toLowerCase();
  return Boolean(model) && model !== "price-card" && Boolean(event.provider?.trim());
}

/**
 * Stamps a usage event's metadata with what ran: `modelUri` (the model the provider served when the event says so,
 * with `modelConfig` as its settings) and `modelClass` (the caller's, over the given defaults). Idempotent; an event
 * that is not a model call is returned unchanged. Applied where events are buffered or inserted, so every recorder
 * gets it without a change at each call site.
 */
export function withModelProvenance<Event extends { provider?: string | null; model?: string | null; metadata?: Record<string, unknown> | null }>(
  event: Event,
  defaults: { modelClass?: ModelCallClass | null } = {},
): Event {
  if (!isModelCall(event)) return event;
  const metadata = { ...(event.metadata ?? {}) };
  const record = (value: unknown) => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const config = record(metadata.modelConfig) as ModelCallConfig | null;
  if (typeof metadata.modelUri !== "string" || !metadata.modelUri.startsWith("llm://")) {
    const uri = modelRecordUri({ provider: event.provider, model: event.model, config });
    if (uri) metadata.modelUri = uri;
  }
  const modelClass = { ...(defaults.modelClass ?? {}), ...(record(metadata.modelClass) ?? {}) };
  const known = Object.fromEntries(flat(modelClass));
  if (Object.keys(known).length > 0) metadata.modelClass = known;
  else delete metadata.modelClass;
  return { ...event, metadata };
}

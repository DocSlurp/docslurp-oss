/**
 * Per-endpoint OpenRouter prices for the automatic-call margin gate (automatic-call-margin.ts): each host's own list
 * price and its listed time-of-day overrides, read from OpenRouter's public `/models/{id}/endpoints` listing (no key is
 * sent). A model's catalog price is its cheapest endpoint, so the gate prices a route by the endpoints it may reach.
 *
 * Models are fetched on demand (`ensureEndpointPrices`) and every model looked up is refreshed in the background
 * (`startEndpointPriceRefresh`). A listing older than the gate's maximum age is not used. Lookups never fetch and never
 * throw; a missing or stale listing is reported as such and the gate fails closed.
 */
import { overrideApplies, parseOverride, type LivePriceOverride } from "./live-model-prices.js";

const OPENROUTER = "https://openrouter.ai/api/v1";
/** How often tracked models are re-read. */
export const ENDPOINT_PRICES_REFRESH_MS = 15 * 60_000;
/** A failed read of one model is retried no sooner than this. */
export const ENDPOINT_PRICES_RETRY_MS = 60_000;
const MAX_LISTING_BYTES = 1024 * 1024;
const MAX_TRACKED_MODELS = 64;

/**
 * One endpoint's listed price, USD per million tokens. Input is the higher of the prompt and the prompt-cache write
 * rate (a route may write the cache on every request); output the higher of completion and reasoning. `priced: false`
 * when any listed price, fee or override could not be read or is of a kind not modelled here.
 */
export interface EndpointPrice {
  readonly endpoint: string;
  readonly priced: boolean;
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  /** The listed `prompt` and `completion` rates alone: what OpenRouter compares with a request's `max_price`. */
  readonly listedPromptUsdPerMTok?: number;
  readonly listedCompletionUsdPerMTok?: number;
  /** USD per request and per input image (OpenRouter `request`, `image`); 0 when not listed. */
  readonly requestUsd?: number;
  readonly imageUsd?: number;
  /** Listed overrides, USD per token (the listing's unit). */
  readonly overrides: readonly LivePriceOverride[];
}

export interface EndpointPriceListing {
  readonly model: string;
  readonly fetchedAt: number;
  readonly endpoints: readonly EndpointPrice[];
}

const listings = new Map<string, EndpointPriceListing>();
const lastAttempt = new Map<string, number>();
const inFlight = new Map<string, Promise<boolean>>();
const tracked = new Set<string>();
/** Only a process that started the refresher (startEndpointPriceRefresh) fetches; tests and scripts never do. */
let fetchEnabled = false;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const MAX_ENDPOINTS = 200;

/** A finite, non-negative price; no upper bound (an expensive endpoint must raise the worst case, not vanish). */
function perToken(value: unknown): number | null {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Pricing keys that never bill the calls this gate prices (cache reads only lower a bill; web search is not used). */
const IGNORED_PRICE_KEYS = new Set(["discount", "input_cache_read", "input_cache_write_1h", "web_search", "overrides"]);
const MODELLED_PRICE_KEYS = new Set(["prompt", "completion", "input_cache_write", "internal_reasoning", "image", "request"]);
const DAYS = new Set(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);
const OVERRIDE_KEYS = new Set(["prompt", "completion", "input_cache_read", "input_cache_write", "input_cache_write_1h", "utc_days", "utc_start", "utc_end", "min_prompt_tokens"]);

/** One override, strictly: every key known, every day a full day name, every rate readable; else null. */
function strictOverride(raw: unknown): LivePriceOverride | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !OVERRIDE_KEYS.has(key))) return null;
  if (value.utc_days !== undefined) {
    if (!Array.isArray(value.utc_days) || value.utc_days.length === 0) return null;
    if (value.utc_days.some((day) => typeof day !== "string" || !DAYS.has(day.toLowerCase()))) return null;
  }
  for (const key of ["utc_start", "utc_end"] as const) {
    if (value[key] === undefined) continue;
    const hhmm = perToken(value[key]);
    if (hhmm === null || hhmm > 2400 || hhmm % 100 >= 60) return null;
  }
  const prompt = perToken(value.prompt), completion = perToken(value.completion);
  const write = value.input_cache_write === undefined ? 0 : perToken(value.input_cache_write);
  if (prompt === null || completion === null || write === null) return null;
  const parsed = parseOverride({ ...value, prompt: Math.max(prompt, write), completion });
  // parseOverride refuses a rate at or above $50/M: null here, so the endpoint is unpriced (fail closed).
  return parsed;
}

function parseEndpoint(raw: unknown): EndpointPrice | null {
  if (!raw || typeof raw !== "object") return null;
  const entry = raw as Record<string, unknown>;
  const tag = typeof entry.tag === "string" && entry.tag ? entry.tag : typeof entry.provider_name === "string" ? entry.provider_name : "";
  if (!tag || tag.length > 120) return null;
  const pricing = (entry.pricing && typeof entry.pricing === "object" ? entry.pricing : null) as Record<string, unknown> | null;
  const unpriced: EndpointPrice = { endpoint: tag.toLowerCase(), priced: false, inputUsdPerMTok: 0, outputUsdPerMTok: 0, overrides: [] };
  if (!pricing) return unpriced;
  for (const [key, value] of Object.entries(pricing)) {
    if (IGNORED_PRICE_KEYS.has(key) || MODELLED_PRICE_KEYS.has(key)) continue;
    // A fee of a kind not modelled here: unpriced unless it is listed as zero.
    if (perToken(value) !== 0) return unpriced;
  }
  const read = (key: string) => (pricing[key] === undefined ? 0 : perToken(pricing[key]));
  const prompt = perToken(pricing.prompt), completion = perToken(pricing.completion);
  const write = read("input_cache_write"), reasoning = read("internal_reasoning"), image = read("image"), request = read("request");
  if (prompt === null || completion === null || write === null || reasoning === null || image === null || request === null) return unpriced;
  const rawOverrides = pricing.overrides === undefined ? [] : pricing.overrides;
  if (!Array.isArray(rawOverrides)) return unpriced;
  const overrides = rawOverrides.map(strictOverride);
  if (overrides.some((override) => override === null)) return unpriced;
  return {
    endpoint: tag.toLowerCase(), priced: true,
    inputUsdPerMTok: Math.max(prompt, write) * 1e6, outputUsdPerMTok: Math.max(completion, reasoning) * 1e6,
    listedPromptUsdPerMTok: prompt * 1e6, listedCompletionUsdPerMTok: completion * 1e6,
    requestUsd: request, imageUsd: image,
    overrides: overrides as LivePriceOverride[],
  };
}

/**
 * A `/models/{id}/endpoints` payload, and whether it was read completely: an entry that could not be read (no tag, a
 * malformed object) or a listing longer than MAX_ENDPOINTS makes it incomplete, and an incomplete listing is never used.
 * An endpoint whose price, fee or override cannot be read is kept with `priced: false`.
 */
export function parseEndpointListing(payload: unknown): { endpoints: EndpointPrice[]; complete: boolean } {
  const endpoints = (payload as { data?: { endpoints?: unknown } } | null)?.data?.endpoints;
  if (!Array.isArray(endpoints) || endpoints.length === 0 || endpoints.length > MAX_ENDPOINTS) return { endpoints: [], complete: false };
  const parsed = endpoints.map(parseEndpoint);
  const complete = parsed.every((entry) => entry !== null);
  return { endpoints: parsed.filter((entry): entry is EndpointPrice => entry !== null), complete };
}

/** The endpoints of a payload (`parseEndpointListing`), complete or not. */
export function parseEndpointPrices(payload: unknown): EndpointPrice[] {
  return parseEndpointListing(payload).endpoints;
}

/** The endpoint's price at `at`, USD per million tokens: a matching listed override, else its base price. */
export function endpointPriceAt(endpoint: EndpointPrice, at: Date, promptTokens?: number): { inputUsdPerMTok: number; outputUsdPerMTok: number } {
  const override = endpoint.overrides.find((candidate) => overrideApplies(candidate, promptTokens, at));
  return override
    ? { inputUsdPerMTok: override.input * 1e6, outputUsdPerMTok: override.output * 1e6 }
    : { inputUsdPerMTok: endpoint.inputUsdPerMTok, outputUsdPerMTok: endpoint.outputUsdPerMTok };
}

function track(model: string): void {
  if (tracked.has(model) || tracked.size >= MAX_TRACKED_MODELS || !MODEL_ID.test(model)) return;
  tracked.add(model);
}

/** The listing of `model` if one was read no longer than `maxAgeMs` ago, else null. Tracks the model for refresh. */
export function endpointPriceListing(model: string, maxAgeMs: number, now: number = Date.now()): EndpointPriceListing | null {
  const key = model.trim().toLowerCase();
  track(key);
  const listing = listings.get(key);
  if (!listing || now - listing.fetchedAt > maxAgeMs || listing.fetchedAt > now + 60_000) return null;
  return listing;
}

async function fetchListing(model: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(`${OPENROUTER}/models/${model.split("/").map(encodeURIComponent).join("/")}/endpoints`, {
    headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_LISTING_BYTES) throw new Error("listing too large");
  const body = await response.text();
  if (body.length > MAX_LISTING_BYTES) throw new Error("listing too large");
  return JSON.parse(body);
}

/** Read one model's listing now. Keeps the previous listing on failure. Concurrent callers share one fetch. */
export async function refreshEndpointPrices(model: string, options: { fetch?: typeof fetch; now?: () => number; force?: boolean } = {}): Promise<boolean> {
  const key = model.trim().toLowerCase();
  if (!MODEL_ID.test(key)) return false;
  track(key);
  const now = options.now ?? Date.now;
  const last = lastAttempt.get(key);
  if (!options.force && last !== undefined && now() - last < ENDPOINT_PRICES_RETRY_MS) return listings.has(key);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = (async () => {
      if (lastAttempt.size > 4 * MAX_TRACKED_MODELS) lastAttempt.clear();
      lastAttempt.set(key, now());
      try {
        const { endpoints, complete } = parseEndpointListing(await fetchListing(key, options.fetch ?? fetch));
        // A partial listing could leave out the dearest host: never used (the previous listing ages out).
        if (!complete || endpoints.length === 0) throw new Error("incomplete or empty endpoint listing");
        listings.set(key, { model: key, fetchedAt: now(), endpoints });
        return true;
      } catch (error) {
        console.warn(`[automatic-margin] endpoint_prices_refresh=failed model=${key} kept=${listings.has(key)} error=${(error instanceof Error ? error.message : String(error)).slice(0, 160)}`);
        return false;
      }
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return await pending;
}

/** Fetch every model whose listing is missing or older than `maxAgeMs`. Never throws. */
export async function ensureEndpointPrices(models: Iterable<string>, maxAgeMs: number, options: { fetch?: typeof fetch; now?: () => number } = {}): Promise<void> {
  if (!fetchEnabled && !options.fetch) return;
  const now = options.now ?? Date.now;
  const stale = [...new Set([...models].map((model) => model.trim().toLowerCase()).filter(Boolean))]
    .filter((model) => !endpointPriceListing(model, maxAgeMs, now()));
  await Promise.all(stale.map((model) => refreshEndpointPrices(model, options).catch(() => false)));
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start a background read of `model` when the refresher runs and its listing is missing or stale. Never throws. */
export function requestEndpointPrices(model: string, maxAgeMs: number, now: number = Date.now()): void {
  if (!fetchEnabled || endpointPriceListing(model, maxAgeMs, now)) return;
  void refreshEndpointPrices(model).catch(() => false);
}

/** Refresh `models` now and every tracked model every ENDPOINT_PRICES_REFRESH_MS. Never throws; does not hold the process. */
export function startEndpointPriceRefresh(models: Iterable<string> = []): void {
  for (const model of models) if (model.trim()) track(model.trim().toLowerCase());
  fetchEnabled = true;
  if (timer) return;
  const all = () => { for (const model of tracked) void refreshEndpointPrices(model, { force: true }).catch(() => false); };
  all();
  timer = setInterval(all, ENDPOINT_PRICES_REFRESH_MS);
  timer.unref?.();
}

/** Tests: install listings (USD per million tokens for base prices; overrides in USD per token), or clear all with null. */
export function setEndpointPricesForTests(
  next: Record<string, { fetchedAt?: number; endpoints: Array<Partial<EndpointPrice> & { endpoint: string; inputUsdPerMTok: number; outputUsdPerMTok: number }> }> | null,
): void {
  listings.clear();
  lastAttempt.clear();
  inFlight.clear();
  tracked.clear();
  fetchEnabled = false;
  for (const [model, listing] of Object.entries(next ?? {})) {
    listings.set(model.toLowerCase(), {
      model: model.toLowerCase(),
      fetchedAt: listing.fetchedAt ?? Date.now(),
      endpoints: listing.endpoints.map((endpoint) => ({ priced: true, overrides: [], ...endpoint })),
    });
  }
}

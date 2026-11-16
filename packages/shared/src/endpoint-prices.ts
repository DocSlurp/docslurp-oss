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

/** One endpoint's listed price, USD per million tokens. `priced: false` when a listed price could not be read. */
export interface EndpointPrice {
  readonly endpoint: string;
  readonly priced: boolean;
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
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

/** A finite, non-negative price per token; no upper bound (an expensive endpoint must raise the worst case, not vanish). */
function perToken(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Endpoints of one `/models/{id}/endpoints` payload. An endpoint whose base price, or any listed override, cannot be read
 * is kept with `priced: false`, so a route that can reach it is never priced as if it were cheap.
 */
export function parseEndpointPrices(payload: unknown): EndpointPrice[] {
  const endpoints = (payload as { data?: { endpoints?: unknown } } | null)?.data?.endpoints;
  if (!Array.isArray(endpoints)) return [];
  const out: EndpointPrice[] = [];
  for (const raw of endpoints.slice(0, 200)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    const tag = typeof entry.tag === "string" && entry.tag ? entry.tag : typeof entry.provider_name === "string" ? entry.provider_name : "";
    if (!tag || tag.length > 120) continue;
    const pricing = (entry.pricing && typeof entry.pricing === "object" ? entry.pricing : {}) as Record<string, unknown>;
    const input = perToken(pricing.prompt), output = perToken(pricing.completion ?? 0);
    const rawOverrides = Array.isArray(pricing.overrides) ? pricing.overrides : [];
    const overrides = rawOverrides.map(parseOverride).filter((override): override is LivePriceOverride => override !== null);
    // parseOverride drops a malformed or out-of-range override; dropping it here could under-price that window.
    const priced = input !== null && output !== null && overrides.length === rawOverrides.length;
    out.push({ endpoint: tag.toLowerCase(), priced, inputUsdPerMTok: (input ?? 0) * 1e6, outputUsdPerMTok: (output ?? 0) * 1e6, overrides });
  }
  return out;
}

/** The endpoint's price at `at`, USD per million tokens: a matching listed override, else its base price. */
export function endpointPriceAt(endpoint: EndpointPrice, at: Date, promptTokens?: number): { inputUsdPerMTok: number; outputUsdPerMTok: number } {
  const override = endpoint.overrides.find((candidate) => overrideApplies(candidate, promptTokens, at));
  return override
    ? { inputUsdPerMTok: override.input * 1e6, outputUsdPerMTok: override.output * 1e6 }
    : { inputUsdPerMTok: endpoint.inputUsdPerMTok, outputUsdPerMTok: endpoint.outputUsdPerMTok };
}

function track(model: string): void {
  if (tracked.has(model) || tracked.size >= MAX_TRACKED_MODELS) return;
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
  const body = await response.text();
  if (body.length > MAX_LISTING_BYTES) throw new Error("listing too large");
  return JSON.parse(body);
}

/** Read one model's listing now. Keeps the previous listing on failure. Concurrent callers share one fetch. */
export async function refreshEndpointPrices(model: string, options: { fetch?: typeof fetch; now?: () => number; force?: boolean } = {}): Promise<boolean> {
  const key = model.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/.test(key)) return false;
  track(key);
  const now = options.now ?? Date.now;
  const last = lastAttempt.get(key);
  if (!options.force && last !== undefined && now() - last < ENDPOINT_PRICES_RETRY_MS) return listings.has(key);
  let pending = inFlight.get(key);
  if (!pending) {
    pending = (async () => {
      lastAttempt.set(key, now());
      try {
        const endpoints = parseEndpointPrices(await fetchListing(key, options.fetch ?? fetch));
        if (endpoints.length === 0) throw new Error("no endpoints listed");
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

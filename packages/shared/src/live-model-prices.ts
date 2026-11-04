// Live model list prices from OpenRouter's public catalogs (chat and
// embeddings), refreshed in the background and read synchronously. They price
// a call only when its provider receipt is missing: the provider-reported
// charge always wins, and the hardcoded tables (chat-model-prices.ts,
// usage.ts) remain the fallback when no live price is loaded or the snapshot
// is too old. Prohibited-model and eval-model gates keep using the verified
// hardcoded prices; a live price never admits a model.

const CATALOG_URLS = [
  "https://openrouter.ai/api/v1/models",
  "https://openrouter.ai/api/v1/embeddings/models",
] as const;

export const LIVE_MODEL_PRICES_REFRESH_MS = 60 * 60_000;
/** A failed refresh is retried after this long, not on every lookup. */
export const LIVE_MODEL_PRICES_RETRY_MS = 5 * 60_000;
/** A snapshot older than this is ignored and the hardcoded tables apply. */
export const LIVE_MODEL_PRICES_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

/** USD per token, the unit OpenRouter lists. */
export interface LiveTokenRates {
  input: number;
  output: number;
}

interface LivePriceOverride extends LiveTokenRates {
  minPromptTokens?: number;
  utcDays?: readonly string[];
  /** HHMM, inclusive. */
  utcStart?: number;
  /** HHMM, exclusive; 0 means the end of the day. */
  utcEnd?: number;
}

export interface LiveModelPriceEntry extends LiveTokenRates {
  overrides: readonly LivePriceOverride[];
}

export interface LiveModelPriceSnapshot {
  fetchedAt: number;
  models: ReadonlyMap<string, LiveModelPriceEntry>;
}

export interface LiveModelPrice extends LiveTokenRates {
  pricingSource: "openrouter-live";
  fetchedAt: string;
  /** Which listed override applied (long prompt or time of day), if any. */
  override?: "min-prompt-tokens" | "utc-window";
}

let snapshot: LiveModelPriceSnapshot | null = null;
let lastAttemptAt = 0;
let lastError: string | null = null;
let inFlight: Promise<boolean> | null = null;

function rate(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function parseOverride(raw: unknown): LivePriceOverride | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const input = rate(value.prompt), output = rate(value.completion);
  if (input === null || output === null) return null;
  const override: LivePriceOverride = { input, output };
  const min = rate(value.min_prompt_tokens);
  if (min !== null) override.minPromptTokens = min;
  if (Array.isArray(value.utc_days)) override.utcDays = value.utc_days.filter((day): day is string => typeof day === "string").map((day) => day.toLowerCase());
  const start = rate(value.utc_start), end = rate(value.utc_end);
  if (start !== null) override.utcStart = start;
  if (end !== null) override.utcEnd = end;
  // An override with no condition we understand is ignored rather than applied to every call.
  return override.minPromptTokens !== undefined || override.utcDays || override.utcStart !== undefined ? override : null;
}

/** Parse one OpenRouter catalog payload (`{ data: [{ id, pricing }] }`) into price entries. */
export function parseOpenRouterCatalog(payload: unknown): Map<string, LiveModelPriceEntry> {
  const models = new Map<string, LiveModelPriceEntry>();
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return models;
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const { id, pricing } = item as { id?: unknown; pricing?: Record<string, unknown> };
    if (typeof id !== "string" || !pricing) continue;
    const input = rate(pricing.prompt), output = rate(pricing.completion ?? 0);
    if (input === null || output === null) continue;
    const overrides = Array.isArray(pricing.overrides)
      ? pricing.overrides.map(parseOverride).filter((entry): entry is LivePriceOverride => entry !== null)
      : [];
    models.set(id, { input, output, overrides });
  }
  return models;
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function overrideApplies(override: LivePriceOverride, promptTokens: number | undefined, at: Date): boolean {
  if (override.minPromptTokens !== undefined) {
    if (promptTokens === undefined || promptTokens <= override.minPromptTokens) return false;
  }
  if (override.utcDays && !override.utcDays.includes(DAYS[at.getUTCDay()]!)) return false;
  if (override.utcStart !== undefined || override.utcEnd !== undefined) {
    const hhmm = at.getUTCHours() * 100 + at.getUTCMinutes();
    const start = override.utcStart ?? 0;
    const end = !override.utcEnd ? 2400 : override.utcEnd;
    if (hhmm < start || hhmm >= end) return false;
  }
  return true;
}

/**
 * The live list price of an OpenRouter model id, applying a listed override
 * (long-prompt tier or time-of-day window) when the call matches it. Returns
 * undefined when no fresh snapshot lists the model, so callers fall back to
 * their hardcoded tables. Variant suffixes (`:nitro`) are not listed and never
 * match: their endpoints can cost more than the base listing.
 */
export function liveModelPrice(
  model: string | null | undefined,
  options: { promptTokens?: number; at?: Date; now?: number } = {},
): LiveModelPrice | undefined {
  if (!model || !snapshot) return undefined;
  const now = options.now ?? Date.now();
  if (now - snapshot.fetchedAt > LIVE_MODEL_PRICES_MAX_AGE_MS) return undefined;
  const entry = snapshot.models.get(model.trim());
  if (!entry) return undefined;
  const at = options.at ?? new Date(now);
  const override = entry.overrides.find((candidate) => overrideApplies(candidate, options.promptTokens, at));
  return {
    input: override?.input ?? entry.input,
    output: override?.output ?? entry.output,
    pricingSource: "openrouter-live",
    fetchedAt: new Date(snapshot.fetchedAt).toISOString(),
    ...(override ? { override: override.minPromptTokens !== undefined ? "min-prompt-tokens" as const : "utc-window" as const } : {}),
  };
}

/**
 * Fetch both catalogs and replace the snapshot when at least one parsed. A
 * failure keeps the previous snapshot (until it ages out) and is retried no
 * sooner than LIVE_MODEL_PRICES_RETRY_MS. Concurrent callers share one fetch.
 */
export async function refreshLiveModelPrices(options: { fetch?: typeof fetch; now?: () => number; force?: boolean } = {}): Promise<boolean> {
  const now = options.now ?? Date.now;
  if (!options.force && lastAttemptAt !== 0 && now() - lastAttemptAt < LIVE_MODEL_PRICES_RETRY_MS) return snapshot !== null;
  inFlight ??= (async () => {
    lastAttemptAt = now();
    const doFetch = options.fetch ?? fetch;
    const merged = new Map<string, LiveModelPriceEntry>();
    const errors: string[] = [];
    for (const url of CATALOG_URLS) {
      try {
        const response = await doFetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) { errors.push(`${url} http ${response.status}`); continue; }
        for (const [id, entry] of parseOpenRouterCatalog(await response.json())) merged.set(id, entry);
      } catch (error) {
        errors.push(`${url} ${error instanceof Error ? error.message : String(error)}`.slice(0, 200));
      }
    }
    if (merged.size === 0) {
      lastError = errors.join("; ") || "empty catalog";
      console.warn(`[model-prices] live_refresh=failed kept_snapshot=${snapshot !== null} error=${lastError}`);
      return false;
    }
    snapshot = { fetchedAt: now(), models: merged };
    lastError = errors.length ? errors.join("; ") : null;
    console.log(`[model-prices] live_refresh=ok models=${merged.size}${errors.length ? ` partial_errors=${errors.length}` : ""}`);
    return true;
  })().finally(() => { inFlight = null; });
  return await inFlight;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** LIVE_MODEL_PRICES=off: price receipt-less usage from the hardcoded tables only. */
export function liveModelPricesDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return ["0", "false", "off", "no"].includes(env.LIVE_MODEL_PRICES?.trim().toLowerCase() ?? "");
}

/**
 * Load live prices now and every LIVE_MODEL_PRICES_REFRESH_MS. A process that
 * never starts this (tests, scripts, LIVE_MODEL_PRICES=off, no OPENROUTER_API_KEY) prices from the
 * hardcoded tables only. Never throws; the timer does not keep the process alive.
 */
export function startLiveModelPriceRefresh(env: Record<string, string | undefined> = process.env): void {
  if (timer) return;
  if (liveModelPricesDisabled(env)) return;
  // Deployments that never call OpenRouter (self-hosted, local models) have nothing to price.
  if (!env.OPENROUTER_API_KEY?.trim()) return;
  void refreshLiveModelPrices({ force: true }).catch(() => undefined);
  timer = setInterval(() => { void refreshLiveModelPrices({ force: true }).catch(() => undefined); }, LIVE_MODEL_PRICES_REFRESH_MS);
  timer.unref?.();
}

export function liveModelPriceStatus(): { loaded: boolean; fetchedAt: string | null; models: number; lastError: string | null } {
  return {
    loaded: snapshot !== null,
    fetchedAt: snapshot ? new Date(snapshot.fetchedAt).toISOString() : null,
    models: snapshot?.models.size ?? 0,
    lastError,
  };
}

/** Tests: install a snapshot (or clear it with null). */
export function setLiveModelPricesForTests(next: { fetchedAt?: number; models: Record<string, LiveModelPriceEntry | LiveTokenRates> } | null): void {
  snapshot = next ? {
    fetchedAt: next.fetchedAt ?? Date.now(),
    models: new Map(Object.entries(next.models).map(([id, entry]) => [id, { overrides: [], ...entry }])),
  } : null;
  lastAttemptAt = 0;
  lastError = null;
}

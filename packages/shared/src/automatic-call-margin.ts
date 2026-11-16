/**
 * Call-time margin gate for automatic model calls: a fallback, an escalation, a chat failover, a chart generator, a
 * tier pool or router pick. Before such a call is made, its worst-case provider cost is estimated as
 *
 *   planning tokens of the call kind x the highest price the route can reach now
 *
 * and the call is allowed only when the value it bills covers that cost by the minimum margin:
 * billed value / worst-case cost >= DOCSLURP_AUTOMATIC_MIN_MARGIN (default 1.3). A refused candidate is skipped with a
 * logged reason and the caller tries its next one; nothing here fails a request another candidate can serve.
 *
 * - Billed value comes from the pricing provider (`automaticCallValueUsd`, pricing-provider.ts). A provider that returns
 *   null bills nothing for the call: no check (the open default). Where pricing is required, a provider without the
 *   hook, or with an invalid answer, refuses every checked call (fail closed).
 * - Price: the route's OpenRouter endpoints (`endpoint-prices.ts`), each at its price at the call's time (listed
 *   time-of-day overrides, plus the verified schedules below as a floor), the highest of the hosts the route allows. A
 *   `max_price` the request sends bounds it: OpenRouter never routes above it, so that cap alone is a valid worst case
 *   when no fresh listing is loaded. A direct provider route (DeepInfra, OpenAI) is priced at its verified list price.
 *   No fresh listing and no cap: the price is unknown and the call is refused (fail closed); never priced from a stale
 *   or partial listing.
 * - Operator private routes (`llm://private/...`) are the operator's own cost: not checked.
 *
 * Only automatic calls go through here. A model a caller or project names explicitly keeps the plain call-time policy
 * (model-call-policy.ts).
 */
import { isModelInFamily } from "./automatic-model-selection.js";
import { visionImageTokens, visionInputUsdPerMillion, visionModelTokenPricing } from "./embedding.js";
import { endpointPriceAt, endpointPriceListing, ensureEndpointPrices, requestEndpointPrices, startEndpointPriceRefresh } from "./endpoint-prices.js";
import { liveModelPricesDisabled } from "./live-model-prices.js";
import { policyModelId } from "./model-call-policy.js";
import {
  AUTOMATIC_CALL_KINDS,
  pricing,
  pricingRequired,
  type AutomaticCallKind,
  type AutomaticCallValueInput,
} from "./pricing-provider.js";
import { hostMatchesEndpoint } from "./provider-pools.js";


/**
 * Planning tokens of one call of each kind: what a call is expected to send and receive, not its caps.
 * - page-transcription: a page image plus instructions in, a page of Markdown out (1,500 / 800).
 * - chart-read: one chart or diagram read on real documents, at the measured 90th percentile (3,300 / 1,400).
 * - chat-answer: retrieved evidence plus the question in, an answer out (8,000 / 600).
 */
export const AUTOMATIC_CALL_PLANNING_TOKENS: Readonly<Record<AutomaticCallKind, { inputTokens: number; outputTokens: number }>> = Object.freeze({
  "page-transcription": { inputTokens: 1_500, outputTokens: 800 },
  "chart-read": { inputTokens: 3_300, outputTokens: 1_400 },
  "chat-answer": { inputTokens: 8_000, outputTokens: 600 },
});

/** Billed value / worst-case cost an automatic call must reach. */
export const DEFAULT_AUTOMATIC_MIN_MARGIN = 1.3;
/** A price listing older than this is not used (minutes). */
export const DEFAULT_AUTOMATIC_PRICE_MAX_AGE_MINUTES = 60;

type Env = Record<string, string | undefined>;
function processEnv(): Env {
  return typeof process !== "undefined" && process?.env ? process.env : {};
}

const warnedEnv = new Set<string>();
function warnEnvOnce(name: string, value: string, using: number): void {
  if (warnedEnv.has(name)) return;
  warnedEnv.add(name);
  console.warn(`[automatic-margin] invalid ${name}=${JSON.stringify(value.slice(0, 40))}; using ${using}`);
}

/** DOCSLURP_AUTOMATIC_MIN_MARGIN: a ratio of at least 1 (1 = break even). Anything else keeps the default. */
export function automaticMinMargin(env: Env = processEnv()): number {
  const raw = env.DOCSLURP_AUTOMATIC_MIN_MARGIN?.trim();
  if (!raw) return DEFAULT_AUTOMATIC_MIN_MARGIN;
  const value = Number(raw);
  if (Number.isFinite(value) && value >= 1 && value <= 100) return value;
  warnEnvOnce("DOCSLURP_AUTOMATIC_MIN_MARGIN", raw, DEFAULT_AUTOMATIC_MIN_MARGIN);
  return DEFAULT_AUTOMATIC_MIN_MARGIN;
}

/** DOCSLURP_AUTOMATIC_PRICE_MAX_AGE_MINUTES, 1 to 1,440, in milliseconds. */
export function automaticPriceMaxAgeMs(env: Env = processEnv()): number {
  const raw = env.DOCSLURP_AUTOMATIC_PRICE_MAX_AGE_MINUTES?.trim();
  let minutes = DEFAULT_AUTOMATIC_PRICE_MAX_AGE_MINUTES;
  if (raw) {
    const value = Number(raw);
    if (Number.isFinite(value) && value >= 1 && value <= 1_440) minutes = value;
    else warnEnvOnce("DOCSLURP_AUTOMATIC_PRICE_MAX_AGE_MINUTES", raw, minutes);
  }
  return minutes * 60_000;
}

/**
 * A host's verified time-of-day price schedule (USD per million tokens), from the host's own pricing page: a floor
 * under its listed price, so a listing that drops its overrides never prices a peak hour at the off-peak rate. Days
 * and hours are UTC. Holidays a host prices off-peak are treated as ordinary days (the higher rate).
 */
export interface ModelPriceSchedule {
  /** Model family (automatic-model-selection.ts `isModelInFamily`). */
  readonly family: string;
  /** OpenRouter endpoint tag of the host the schedule is for. */
  readonly host: string;
  readonly source: string;
  readonly verifiedAt: string;
  readonly base: { readonly inputUsdPerMTok: number; readonly outputUsdPerMTok: number };
  readonly windows: ReadonlyArray<{
    readonly utcDays: readonly number[];
    /** HHMM inclusive. */
    readonly utcStart: number;
    /** HHMM exclusive. */
    readonly utcEnd: number;
    readonly inputUsdPerMTok: number;
    readonly outputUsdPerMTok: number;
  }>;
}

const WEEKDAYS = [1, 2, 3, 4, 5] as const;
export const MODEL_PRICE_SCHEDULES: readonly ModelPriceSchedule[] = Object.freeze([
  {
    // "Off-peak rates are half of the peak rates. Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through
    // Friday, excluding Chinese public holidays." deepseek-flash (DeepSeek-V4.1-Flash-1017), cache-miss input.
    family: "deepseek-v4.1-flash",
    host: "deepseek",
    source: "https://api-docs.deepseek.com/quick_start/pricing",
    verifiedAt: "2026-11-15",
    base: { inputUsdPerMTok: 0.15, outputUsdPerMTok: 0.6 },
    windows: [
      { utcDays: WEEKDAYS, utcStart: 100, utcEnd: 400, inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 },
      { utcDays: WEEKDAYS, utcStart: 600, utcEnd: 1000, inputUsdPerMTok: 0.3, outputUsdPerMTok: 1.2 },
    ],
  },
]);

/** `price` raised to every verified schedule of `model` on `endpoint` at `at`. */
export function withPriceScheduleFloor(model: string, endpoint: string, at: Date, price: TokenPrice): TokenPrice {
  let { inputUsdPerMTok, outputUsdPerMTok } = price;
  for (const schedule of MODEL_PRICE_SCHEDULES) {
    if (!hostMatchesEndpoint(schedule.host, endpoint.toLowerCase()) || !isModelInFamily(model, schedule.family)) continue;
    const floor = schedulePriceAt(schedule, at);
    inputUsdPerMTok = Math.max(inputUsdPerMTok, floor.inputUsdPerMTok);
    outputUsdPerMTok = Math.max(outputUsdPerMTok, floor.outputUsdPerMTok);
  }
  return { inputUsdPerMTok, outputUsdPerMTok };
}

/** The schedule's price at `at`. */
export function schedulePriceAt(schedule: ModelPriceSchedule, at: Date): { inputUsdPerMTok: number; outputUsdPerMTok: number } {
  const hhmm = at.getUTCHours() * 100 + at.getUTCMinutes();
  const window = schedule.windows.find((entry) => entry.utcDays.includes(at.getUTCDay()) && hhmm >= entry.utcStart && hhmm < entry.utcEnd);
  const price = window ?? schedule.base;
  return { inputUsdPerMTok: price.inputUsdPerMTok, outputUsdPerMTok: price.outputUsdPerMTok };
}

/** USD per million tokens. */
export interface TokenPrice {
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
}

/** The route of one automatic call, as far as its price is concerned. */
export interface AutomaticCallRoute {
  /** Model id or `llm://` URI. */
  readonly model: string;
  /**
   * `openrouter` (the default for a bare id or `llm://openrouter/...`), `direct` (a provider's own API, priced at
   * `capUsdPerMTok`, its verified list price) or `private` (an operator route; not checked).
   */
  readonly billing?: "openrouter" | "direct" | "private";
  /** OpenRouter endpoint tags the request is restricted to (`provider.only` / a pinned `order`); null or absent: any. */
  readonly hosts?: readonly string[] | null;
  /** The `max_price` the request sends (OpenRouter refuses hosts above it), or a direct route's list price. */
  readonly capUsdPerMTok?: TokenPrice | null;
  /** Input tokens one call on this route needs at least (a vision model's own image tokens for a page), beyond planning. */
  readonly minInputTokens?: number;
  /** Images one call sends: each may be billed a listed per-image fee. */
  readonly images?: number;
}

/** Why the system makes the call: what the provider's billed value may depend on (a retry may bill nothing new). */
export type AutomaticCallRole = AutomaticCallValueInput["role"];

export type AutomaticCallDecision = {
  readonly kind: AutomaticCallKind;
  readonly model: string;
  readonly allowed: boolean;
  /** Why: `margin` (checked), `not-billed` (no value stated), `private-route`, or the refusal reason. */
  readonly reason: string;
  readonly valueUsd: number | null;
  readonly worstCostUsd: number | null;
  readonly ratio: number | null;
  readonly minMargin: number;
  readonly price: TokenPrice | null;
  /** Where the price came from: `listing`, `cap`, `list-price`. */
  readonly priceSource: string | null;
  readonly at: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
};

function routeBilling(route: AutomaticCallRoute): "openrouter" | "direct" | "private" {
  if (route.billing) return route.billing;
  const trimmed = route.model.trim().toLowerCase();
  if (trimmed.startsWith("llm://private/")) return "private";
  if (/^llm:\/\//.test(trimmed) && !trimmed.startsWith("llm://openrouter/")) return "direct";
  return "openrouter";
}

const validPrice = (price: TokenPrice | null | undefined): price is TokenPrice => !!price
  && Number.isFinite(price.inputUsdPerMTok) && price.inputUsdPerMTok >= 0
  && Number.isFinite(price.outputUsdPerMTok) && price.outputUsdPerMTok >= 0;

/**
 * The highest price the route can be billed at `at`, or the reason it is unknown. Each component (input, output) is
 * the maximum over the reachable hosts, so the pair never under-prices any one of them.
 */
export function automaticRouteWorstPrice(
  route: AutomaticCallRoute,
  options: { at: Date; now?: number; maxAgeMs?: number; promptTokens?: number },
): { price: TokenPrice; source: string; requestUsd: number; imageUsd: number } | { unknown: string } {
  const billing = routeBilling(route);
  const cap = route.capUsdPerMTok ?? null;
  if (cap && !validPrice(cap)) return { unknown: "invalid price cap" };
  const fromCap = (source: string) => ({ price: cap!, source, requestUsd: 0, imageUsd: 0 });
  if (billing === "direct") return cap ? fromCap("list-price") : { unknown: "no verified list price for a direct route" };
  const model = policyModelId(route.model);
  const maxAge = options.maxAgeMs ?? automaticPriceMaxAgeMs();
  const now = options.now ?? Date.now();
  const listing = endpointPriceListing(model, maxAge, now);
  if (!listing) {
    requestEndpointPrices(model, maxAge, now);
    return cap ? fromCap("cap") : { unknown: "no fresh price listing" };
  }
  const hosts = route.hosts?.length ? route.hosts.map((host) => host.trim().toLowerCase()) : null;
  // Every allowed host must be listed: one that is not could be the dearest, so the listing alone cannot price the route.
  if (hosts && hosts.some((host) => !listing.endpoints.some((endpoint) => hostMatchesEndpoint(host, endpoint.endpoint)))) {
    return cap ? fromCap("cap") : { unknown: "an allowed host is not in the price listing" };
  }
  const reachable = listing.endpoints.filter((endpoint) => !hosts || hosts.some((host) => hostMatchesEndpoint(host, endpoint.endpoint)));
  if (reachable.length === 0) return cap ? fromCap("cap") : { unknown: "no listed endpoint the route allows" };
  if (reachable.some((endpoint) => !endpoint.priced)) return cap ? fromCap("cap") : { unknown: "an allowed endpoint has an unreadable price" };
  let input = 0, output = 0, requestUsd = 0, imageUsd = 0;
  for (const endpoint of reachable) {
    const floored = withPriceScheduleFloor(model, endpoint.endpoint, options.at, endpointPriceAt(endpoint, options.at, options.promptTokens));
    const timeVarying = endpoint.overrides.length > 0 || MODEL_PRICE_SCHEDULES.some((schedule) =>
      hostMatchesEndpoint(schedule.host, endpoint.endpoint) && isModelInFamily(model, schedule.family));
    // OpenRouter does not route to a host whose listed price is above the request's max_price, so such a host is not
    // reachable. Whether it compares a time-of-day price is not documented: a host with one always counts.
    if (cap && !timeVarying && (endpoint.inputUsdPerMTok > cap.inputUsdPerMTok + 1e-12 || endpoint.outputUsdPerMTok > cap.outputUsdPerMTok + 1e-12)) continue;
    input = Math.max(input, floored.inputUsdPerMTok);
    output = Math.max(output, floored.outputUsdPerMTok);
    requestUsd = Math.max(requestUsd, endpoint.requestUsd ?? 0);
    imageUsd = Math.max(imageUsd, endpoint.imageUsd ?? 0);
  }
  if (input === 0 && output === 0 && cap) {
    // Every allowed host is above the cap (the call cannot route) or free: the cap still bounds it.
    return fromCap("cap");
  }
  return { price: { inputUsdPerMTok: input, outputUsdPerMTok: output }, source: "listing", requestUsd, imageUsd };
}

/**
 * The pricing provider's billed value for the call: a number, null (not billed: no check) or an error (refuse). Where
 * pricing is required (pricingRequired), a provider must state a value: no hook, or null, refuses.
 */
export function automaticCallValue(
  kind: AutomaticCallKind,
  model: string,
  tokens: { inputTokens: number; outputTokens: number },
  role: AutomaticCallRole = "pick",
): { value: number | null } | { error: string } {
  let provider;
  try {
    provider = pricing();
  } catch (error) {
    return { error: `no pricing provider (${error instanceof Error ? error.message.slice(0, 80) : "error"})` };
  }
  if (typeof provider.automaticCallValueUsd !== "function") {
    return pricingRequired() ? { error: "the pricing provider states no automatic call value" } : { value: null };
  }
  let value: unknown;
  try {
    value = provider.automaticCallValueUsd({ kind, model, role, ...tokens });
  } catch (error) {
    return { error: `the pricing provider's automatic call value failed (${error instanceof Error ? error.message.slice(0, 80) : "error"})` };
  }
  if (value === null) return pricingRequired() ? { error: "the pricing provider states no value for this automatic call" } : { value: null };
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return { error: "the pricing provider returned an invalid automatic call value" };
  return { value };
}

/**
 * Decide one automatic call. Pure apart from reading the price cache and the pricing provider; never throws.
 * `at` is when the call would be made (default now).
 */
export function automaticCallMarginDecision(
  kind: AutomaticCallKind,
  route: AutomaticCallRoute,
  options: {
    at?: Date; now?: number; env?: Env; maxAgeMs?: number;
    /** Why the system makes this call (default `pick`); passed to the provider's billed value. */
    role?: AutomaticCallRole;
    /** The call's own size when known (a chat turn's prompt and output cap): raises the planning tokens, never lowers them. */
    tokens?: { inputTokens?: number; outputTokens?: number };
  } = {},
): AutomaticCallDecision {
  const now = options.now ?? Date.now();
  const at = options.at ?? new Date(now);
  const env = options.env ?? processEnv();
  const minMargin = automaticMinMargin(env);
  const model = policyModelId(route.model);
  if (!AUTOMATIC_CALL_KINDS.includes(kind)) {
    return { kind, model, minMargin, at: at.toISOString(), inputTokens: 0, outputTokens: 0, allowed: false, reason: "unknown call kind",
      valueUsd: null, worstCostUsd: null, ratio: null, price: null, priceSource: null };
  }
  const planned = AUTOMATIC_CALL_PLANNING_TOKENS[kind];
  const positive = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : 0);
  const tokens = {
    inputTokens: Math.max(planned.inputTokens, positive(route.minInputTokens), positive(options.tokens?.inputTokens)),
    outputTokens: Math.max(planned.outputTokens, positive(options.tokens?.outputTokens)),
  };
  const base = { kind, model, minMargin, at: at.toISOString(), inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens };
  const refuse = (reason: string, extra: Partial<AutomaticCallDecision> = {}): AutomaticCallDecision =>
    ({ ...base, allowed: false, reason, valueUsd: null, worstCostUsd: null, ratio: null, price: null, priceSource: null, ...extra });
  if (routeBilling(route) === "private") {
    return { ...base, allowed: true, reason: "private-route", valueUsd: null, worstCostUsd: null, ratio: null, price: null, priceSource: null };
  }
  const value = automaticCallValue(kind, model, tokens, options.role ?? "pick");
  if ("error" in value) return refuse(value.error);
  if (value.value === null) {
    return { ...base, allowed: true, reason: "not-billed", valueUsd: null, worstCostUsd: null, ratio: null, price: null, priceSource: null };
  }
  const worst = automaticRouteWorstPrice(route, { at, now, maxAgeMs: options.maxAgeMs ?? automaticPriceMaxAgeMs(env), promptTokens: tokens.inputTokens });
  if ("unknown" in worst) return refuse(`price unknown: ${worst.unknown}`, { valueUsd: value.value });
  const cost = (tokens.inputTokens * worst.price.inputUsdPerMTok + tokens.outputTokens * worst.price.outputUsdPerMTok) / 1e6
    + worst.requestUsd + worst.imageUsd * Math.max(0, route.images ?? 0);
  const ratio = cost > 0 ? value.value / cost : Number.POSITIVE_INFINITY;
  const decided = { valueUsd: value.value, worstCostUsd: cost, ratio, price: worst.price, priceSource: worst.source };
  if (ratio + 1e-9 < minMargin) return refuse("below the minimum margin", decided);
  return { ...base, allowed: true, reason: "margin", ...decided };
}

function fmt(value: number | null | undefined, digits = 6): string {
  return value === null || value === undefined ? "na" : Number.isFinite(value) ? value.toFixed(digits) : "inf";
}

/** One structured log line for a decision (refusals at warn). */
export function logAutomaticCallDecision(decision: AutomaticCallDecision, label: string): void {
  // Refusals only: an admitted call's numbers come back in its outcome report when it loses or overruns.
  if (decision.allowed) return;
  const line = `[automatic-margin] ${decision.allowed ? "allowed" : "skipped"} label=${label} kind=${decision.kind} `
    + `model=${decision.model.slice(0, 120)} reason=${JSON.stringify(decision.reason)} value_usd=${fmt(decision.valueUsd)} `
    + `worst_cost_usd=${fmt(decision.worstCostUsd)} ratio=${fmt(decision.ratio, 3)} min_margin=${decision.minMargin} `
    + `price_in=${fmt(decision.price?.inputUsdPerMTok, 4)} price_out=${fmt(decision.price?.outputUsdPerMTok, 4)} `
    + `price_source=${decision.priceSource ?? "na"} at=${decision.at}`;
  if (decision.allowed) console.log(line);
  else console.warn(line);
}

/** Decide, log, and return whether the automatic call may be made. */
export function admitAutomaticCall(kind: AutomaticCallKind, route: AutomaticCallRoute, label: string, options: Parameters<typeof automaticCallMarginDecision>[2] = {}): AutomaticCallDecision {
  const decision = automaticCallMarginDecision(kind, route, options);
  logAutomaticCallDecision(decision, label);
  return decision;
}

/**
 * Load fresh endpoint listings for OpenRouter routes before deciding (async callers). Only where the gate is active (a
 * billed value is stated) and the process runs the price refresher; never throws.
 */
export async function prepareAutomaticCallPrices(kind: AutomaticCallKind, routes: readonly AutomaticCallRoute[]): Promise<void> {
  // A capped route is priced without a listing: waiting for one buys nothing on a request path.
  const models = routes.filter((route) => routeBilling(route) === "openrouter" && !route.capUsdPerMTok).map((route) => policyModelId(route.model));
  if (models.length === 0) return;
  const value = automaticCallValue(kind, models[0]!, AUTOMATIC_CALL_PLANNING_TOKENS[kind]);
  if ("value" in value && value.value === null) return;
  await ensureEndpointPrices(models, automaticPriceMaxAgeMs()).catch(() => undefined);
}

/**
 * After an admitted automatic call: compare its actual provider cost (the provider-reported charge where there is one)
 * with the estimate and the billed value. A call that cost more than its billed value lost money: `[automatic-margin]
 * overrun ... loss=true` at error, for the provider-cost alert. One that only exceeded the planning estimate (a larger
 * page or chart than planned) logs the same line at warn. Never throws.
 */
export function reportAutomaticCallOutcome(decision: AutomaticCallDecision, actual: { costUsd: number | null | undefined; inputTokens?: number; outputTokens?: number }, label: string): void {
  try {
    if (decision.reason !== "margin" || actual.costUsd === null || actual.costUsd === undefined || !Number.isFinite(actual.costUsd)) return;
    const loss = decision.valueUsd !== null && actual.costUsd > decision.valueUsd;
    const over = decision.worstCostUsd !== null && actual.costUsd > decision.worstCostUsd * 1.0001;
    if (!loss && !over) return;
    const line = `[automatic-margin] overrun label=${label} kind=${decision.kind} model=${decision.model.slice(0, 120)} `
      + `actual_cost_usd=${fmt(actual.costUsd)} estimate_usd=${fmt(decision.worstCostUsd)} value_usd=${fmt(decision.valueUsd)} `
      + `loss=${loss} input_tokens=${actual.inputTokens ?? "na"} output_tokens=${actual.outputTokens ?? "na"} `
      + `planned_input=${decision.inputTokens} planned_output=${decision.outputTokens} at=${decision.at}`;
    if (loss) console.error(line);
    else console.warn(line);
  } catch {
    // Reporting never fails the call.
  }
}

/** A page render the planning size assumes: US Letter at 200 dpi. */
const PLANNING_PAGE_PX = { widthPx: 1_700, heightPx: 2_200 } as const;
/** Instructions and framing around the image. */
const VISION_PROMPT_TOKENS = 600;

/** A vision model's own input tokens for one planning page (its catalog image-token bound), when the catalog has one. */
function pageInput(modelOrUri: string): { minInputTokens?: number } {
  const image = visionImageTokens(modelOrUri, PLANNING_PAGE_PX) ?? visionImageTokens(policyModelId(modelOrUri), PLANNING_PAGE_PX);
  return image === null ? {} : { minInputTokens: image + VISION_PROMPT_TOKENS };
}

/**
 * The route of a vision call (page transcription, chart read, OCR escalation, a page-router target) on `modelOrUri`, as
 * the vision runtime sends it: an OpenRouter request carries `max_price` at the model's catalog token price, restricted
 * to the catalog's pinned hosts when the catalog prices a pinned route; a direct provider route (DeepInfra, OpenAI) is
 * billed at its catalog list price; an operator private route is not checked. A model outside the catalog has no cap.
 */
export function visionAutomaticRoute(modelOrUri: string): AutomaticCallRoute {
  const trimmed = modelOrUri.trim();
  if (/^llm:\/\/private\//i.test(trimmed)) return { model: trimmed, billing: "private" };
  const direct = /^llm:\/\//i.test(trimmed) && !/^llm:\/\/openrouter\//i.test(trimmed);
  const bareUri = trimmed.split(/[?#]/, 1)[0] ?? trimmed;
  const catalog = visionModelTokenPricing(bareUri) ?? (direct ? null : visionModelTokenPricing(policyModelId(trimmed)));
  const cap = catalog ? { inputUsdPerMTok: visionInputUsdPerMillion(catalog), outputUsdPerMTok: catalog.outputUsdPerMillion } : null;
  if (direct) return { model: trimmed, billing: "direct", capUsdPerMTok: cap, images: 1, ...pageInput(bareUri) };
  const hosts = catalog?.basis === "pinned-route" && catalog.providers?.length ? catalog.providers : null;
  return { model: trimmed, billing: "openrouter", capUsdPerMTok: cap, hosts, images: 1, ...pageInput(trimmed) };
}

/**
 * Start the endpoint price refresher for automatic call candidates (worker and API startup), beside the live catalog
 * prices: off with LIVE_MODEL_PRICES=off or without OPENROUTER_API_KEY, like them. Models are bare ids or `llm://` URIs;
 * any other model the gate looks up is tracked and refreshed as well. Never throws.
 */
export function startAutomaticCallPriceRefresh(models: Iterable<string> = [], env: Env = processEnv()): void {
  try {
    if (liveModelPricesDisabled(env) || !env.OPENROUTER_API_KEY?.trim()) return;
    const ids = [...models].filter((model) => routeBilling({ model }) === "openrouter").map((model) => policyModelId(model));
    startEndpointPriceRefresh(ids);
  } catch (error) {
    console.warn(`[automatic-margin] price refresher not started: ${error instanceof Error ? error.message : String(error)}`);
  }
}

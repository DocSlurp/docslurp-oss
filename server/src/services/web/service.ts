import { createHash, randomUUID } from "node:crypto";

import { BILLABLE_UNIT_METRICS, webMapCredits, webPageCredits, webSearchCredits } from "@docslurp/shared";
import { startTelemetrySpan, type TelemetrySpan } from "@docslurp/shared/observability";

import { env } from "../../config.js";
import { recordCostEvent, recordUnitCharge } from "../../lib/ai-usage.js";
import { assertSafeExternalUrl } from "../../lib/network-security.js";
import { allowHostedCallForWorkspace } from "../../lib/privacy.js";
import { loadWorkspacePipeline } from "../../search/session-setup.js";
import { assertCanSpend } from "../billing/spend-guard.js";
import { reviewUntrustedEvidenceText } from "../prompt-injection.js";
import { createExaAdapter } from "./providers/exa.js";
import { createFirecrawlAdapter } from "./providers/firecrawl.js";
import { createJinaAdapter } from "./providers/jina.js";
import { createTavilyAdapter } from "./providers/tavily.js";
import { WebRouter, type WebAttempt, type WebRouteResult } from "./router.js";
import {
  WEB_PROVIDER_IDS, WebToolError,
  type WebCapability, type WebInput, type WebOutput, type WebPage, type WebProviderId,
} from "./types.js";

export type WebSurface = "api" | "mcp" | "chat" | "ingest";

export interface WebCallContext {
  userId: string;
  orgId: string | null;
  workspaceId: string;
  surface: WebSurface;
  signal?: AbortSignal;
  parent?: TelemetrySpan;
}

/** What callers see: normalized data, whether it came from cache, and the credits charged. No provider identity. */
export type WebCallResult<C extends WebCapability> = WebOutput<C> & { cached: boolean; usage: { credits: number } };

type WebConfig = typeof env.web;

export interface WebServiceDeps {
  config: WebConfig;
  router: WebRouter;
  now: () => number;
  assertSafeUrl: (url: string) => Promise<string>;
  /** The workspace's own opt-out (`pipeline.webTools`) first, then its privacy mode. */
  workspaceAccess: (workspaceId: string, capability: WebCapability) => Promise<"allowed" | "disabled" | "privacy">;
  assertCanSpend: (orgId: string | null, workspaceId: string) => Promise<void>;
  recordCost: typeof recordCostEvent;
  recordCharge: typeof recordUnitCharge;
}

/** Whole-call deadlines (failovers included); crawl uses the request's own timeout. */
const CALL_DEADLINE_MS: Record<Exclude<WebCapability, "crawl">, number> = { search: 30_000, fetch: 60_000, map: 60_000 };
/** Chat tool results go to a hosted model; keep each page small. */
const CHAT_PAGE_CHARACTERS = 10_000;
/** Appended to a page cut for chat. Worded to pass the prompt-injection screen (no fetch/URL instructions). */
export const CHAT_SHORTENED_NOTE = "[Page shortened for chat. The remaining text is not available in this conversation; search for the specific section instead.]";

function isProviderId(value: string): value is WebProviderId {
  return (WEB_PROVIDER_IDS as readonly string[]).includes(value);
}

export function createWebRouter(config: WebConfig, fetchImpl?: typeof fetch): WebRouter {
  const ids = (list: string[] | undefined) => list?.filter(isProviderId);
  return new WebRouter({
    adapters: [
      createJinaAdapter({ usdPerMillionTokens: config.pricing.jinaUsdPerMillionTokens }),
      createFirecrawlAdapter({ usdPerCredit: config.pricing.firecrawlUsdPerCredit }),
      createExaAdapter(),
      createTavilyAdapter({ usdPerCredit: config.pricing.tavilyUsdPerCredit }),
    ],
    keys: config.keys,
    strategy: config.strategy,
    order: ids(config.order) ?? [...WEB_PROVIDER_IDS],
    perCapability: {
      search: ids(config.perCapability.search), fetch: ids(config.perCapability.fetch),
      map: ids(config.perCapability.map), crawl: ids(config.perCapability.crawl),
    },
    maxAttempts: config.maxAttempts,
    fetch: fetchImpl,
  });
}

let defaultDeps: WebServiceDeps | undefined;
function deps(): WebServiceDeps {
  defaultDeps ??= {
    config: env.web,
    router: createWebRouter(env.web),
    now: Date.now,
    assertSafeUrl: assertSafeExternalUrl,
    workspaceAccess: async (workspaceId, capability) => {
      const pipeline = await loadWorkspacePipeline(workspaceId);
      if (pipeline.webTools === false) return "disabled";
      return await allowHostedCallForWorkspace({
        privacyMode: pipeline.privacyMode,
        workspaceId,
        // Generic descriptor: privacy audit rows never name the provider.
        call: { provider: "web", model: capability, operation: `api.web.${capability}`, target: "hosted" },
      }) ? "allowed" : "privacy";
    },
    assertCanSpend: (orgId, workspaceId) => assertCanSpend(orgId, workspaceId, { kind: "interactive" }),
    recordCost: recordCostEvent,
    recordCharge: recordUnitCharge,
  };
  return defaultDeps;
}

/** Tests swap in fakes; `undefined` restores the environment-built defaults. */
export function setWebServiceDeps(next: Partial<WebServiceDeps> | undefined): void {
  defaultDeps = next ? { ...deps(), ...next } : undefined;
  cache.clear();
  cachedBytes = 0;
  orgCalls.clear();
}

/** Whether web capabilities are on and at least one provider can serve `capability`. */
export function webCapabilityAvailable(capability: WebCapability): boolean {
  const current = deps();
  return current.config.enabled && current.router.configured(capability).length > 0;
}

// --- Cache: identical public-web requests within the TTL reuse the result (no provider spend). ---

const cache = new Map<string, { expiresAt: number; value: unknown; bytes: number }>();
/** Per-entry and total caps (JSON characters ≈ bytes), bounding heap use. */
const MAX_ENTRY_BYTES = 512_000;
const MAX_TOTAL_BYTES = 48_000_000;
let cachedBytes = 0;

function cacheDelete(key: string): void {
  const entry = cache.get(key);
  if (!entry) return;
  cachedBytes -= entry.bytes;
  cache.delete(key);
}

function cacheKey(capability: WebCapability, input: unknown): string {
  return createHash("sha256").update(`${capability}\0${JSON.stringify(input)}`).digest("hex");
}

function cacheGet<T>(key: string, now: number): T | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expiresAt <= now) { cacheDelete(key); return undefined; }
  cache.delete(key);
  cache.set(key, hit); // LRU: most recent last
  return hit.value as T;
}

function cachePut(key: string, value: unknown, now: number, config: WebConfig): void {
  if (!config.cacheTtlMs || !config.cacheMaxEntries) return;
  const bytes = JSON.stringify(value).length;
  if (bytes > MAX_ENTRY_BYTES) return;
  cacheDelete(key);
  cache.set(key, { expiresAt: now + config.cacheTtlMs, value, bytes });
  cachedBytes += bytes;
  while (cache.size > config.cacheMaxEntries || cachedBytes > MAX_TOTAL_BYTES) cacheDelete(cache.keys().next().value!);
}

// --- Per-organization rate limit (sliding minute, per process). ---

const orgCalls = new Map<string, number[]>();

function admitOrgCall(orgKey: string, now: number, perMinute: number): number | null {
  const recent = (orgCalls.get(orgKey) ?? []).filter((at) => at > now - 60_000);
  if (recent.length >= perMinute) {
    orgCalls.set(orgKey, recent);
    return Math.max(1, Math.ceil((recent[0]! + 60_000 - now) / 1000));
  }
  recent.push(now);
  orgCalls.set(orgKey, recent);
  if (orgCalls.size > 10_000) orgCalls.delete(orgCalls.keys().next().value!);
  return null;
}

type PaidAttempt = WebRouteResult<WebCapability>["paid"][number];

/**
 * Provider cost is our cost, never customer spend: written like priced AI
 * receipts (`costCents: 0`, `providerCostCents`, `billable: false`), so usage
 * totals, budgets and key limits only count the unit charge. One event per paid
 * attempt; the model column names only the capability.
 */
async function recordProviderCosts(d: WebServiceDeps, ctx: WebCallContext, capability: WebCapability, callId: string,
  paid: PaidAttempt[], attempts: WebAttempt[], served: WebProviderId | undefined): Promise<void> {
  await Promise.all(paid.map((spent, index) => d.recordCost({
    userId: ctx.userId,
    scope: { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    event: {
      id: `web-cost:${callId}:${index}`, provider: spent.provider, model: `web-${capability}`, metric: `web-${capability}`,
      amount: spent.units?.amount ?? 1, unit: spent.units?.unit ?? "request", costCents: 0,
      metadata: {
        providerCostCents: cents(spent.costUsd), billable: false, costRole: "provider",
        capability, surface: ctx.surface, callId, costSource: spent.costSource, served: spent.provider === served,
        attempts: attempts.map((attempt) => ({ provider: attempt.provider, outcome: attempt.outcome, runtimeMs: attempt.runtimeMs })),
      },
    },
  }).catch((error) => console.error(`[web] cost record failed call=${callId}: ${error instanceof Error ? error.message : String(error)}`))));
}

function cents(usd: number): number {
  return Math.round(Math.max(0, usd * 100) * 1e6) / 1e6;
}

/** Providers can return the same page twice (redirects, trailing slashes); keep the first. */
function dedupe<C extends WebCapability>(capability: C, output: WebOutput<C>): WebOutput<C> {
  const seen = new Set<string>();
  const first = (url: string) => {
    const key = url.replace(/#.*$/, "").replace(/\/+$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  if (capability === "map") return { urls: (output as WebOutput<"map">).urls.filter(first) } as WebOutput<C>;
  if (capability === "search") return { results: (output as WebOutput<"search">).results.filter((item) => first(item.url)) } as WebOutput<C>;
  return { ...output, pages: (output as WebOutput<"fetch">).pages.filter((item) => first(item.url)) } as WebOutput<C>;
}

// --- Billing ---

function chargeFor<C extends WebCapability>(capability: C, input: WebInput<C>, output: WebOutput<C>): { metric: string; amount: number; unit: string; credits: number } | null {
  // Nothing returned, nothing charged (our provider cost is still recorded).
  if (resultCount(capability, output) === 0) return null;
  if (capability === "search") {
    const search = input as WebInput<"search">;
    return { metric: BILLABLE_UNIT_METRICS.webSearch, amount: 1, unit: "search",
      credits: webSearchCredits({ deep: search.depth === "deep", includeContent: search.includeContent }) };
  }
  if (capability === "map") {
    const urls = (output as WebOutput<"map">).urls.length;
    return { metric: BILLABLE_UNIT_METRICS.webMap, amount: 1, unit: "map", credits: webMapCredits(urls) };
  }
  const pages = (output as WebOutput<"fetch"> | WebOutput<"crawl">).pages.length;
  return pages ? { metric: BILLABLE_UNIT_METRICS.webPage, amount: pages, unit: "page", credits: webPageCredits(pages) } : null;
}

function resultCount<C extends WebCapability>(capability: C, output: WebOutput<C>): number {
  if (capability === "search") return (output as WebOutput<"search">).results.length;
  if (capability === "map") return (output as WebOutput<"map">).urls.length;
  return (output as WebOutput<"fetch">).pages.length;
}

/** Web text is untrusted: instruction-like lines are suppressed before a model reads it. */
function forChat(page: WebPage): WebPage {
  // The page text is screened first and our note appended after, so the screen never removes the note.
  // Saying plainly that the rest is unavailable matters: a bare "[truncated]" made the model refetch the page.
  const clean = (text: string | undefined, max: number) => text === undefined ? undefined
    : text.length > max ? `${reviewUntrustedEvidenceText(text.slice(0, max)).text}\n\n${CHAT_SHORTENED_NOTE}` : reviewUntrustedEvidenceText(text).text;
  return { ...page, title: clean(page.title, 300), snippet: clean(page.snippet, 1_000), markdown: clean(page.markdown, CHAT_PAGE_CHARACTERS) };
}

function chatSafe<C extends WebCapability>(capability: C, output: WebOutput<C>): WebOutput<C> {
  if (capability === "search") return { results: (output as WebOutput<"search">).results.map(forChat) } as WebOutput<C>;
  if (capability === "fetch" || capability === "crawl") return { ...output, pages: (output as WebOutput<"fetch">).pages.map(forChat) } as WebOutput<C>;
  return output;
}

function urlsOf<C extends WebCapability>(capability: C, input: WebInput<C>): string[] {
  if (capability === "fetch") return (input as WebInput<"fetch">).urls;
  if (capability === "map" || capability === "crawl") return [(input as WebInput<"map">).url];
  return [];
}

function withUrls<C extends WebCapability>(capability: C, input: WebInput<C>, urls: string[]): WebInput<C> {
  if (capability === "fetch") return { ...input, urls } as WebInput<C>;
  if (capability === "map" || capability === "crawl") return { ...input, url: urls[0]! } as WebInput<C>;
  return input;
}

/**
 * Run one Web Capability call with every guardrail: feature flag, URL safety,
 * workspace privacy mode, per-org rate limit, spend check, cache, provider
 * failover, provider-cost recording (internal) and the customer unit charge.
 * Traced as one `web <capability>` span with a child span per provider attempt.
 */
export async function runWebCapability<C extends WebCapability>(
  capability: C,
  rawInput: WebInput<C>,
  ctx: WebCallContext,
  options: { deadlineMs?: number } = {},
): Promise<WebCallResult<C>> {
  const d = deps();
  const started = d.now();
  const callId = randomUUID();
  const span = startTelemetrySpan("docslurp.web", `web ${capability}`, {
    "docslurp.web.capability": capability, "docslurp.web.surface": ctx.surface, "docslurp.web.call_id": callId,
    "docslurp.workspaceId": ctx.workspaceId, ...(ctx.orgId ? { "docslurp.orgId": ctx.orgId } : {}),
    "docslurp.web.strategy": d.config.strategy,
  }, { parent: ctx.parent });
  let outcome = "error";
  const fields: Record<string, string | number | boolean> = {};
  try {
    if (!d.config.enabled) throw new WebToolError(404, "web_disabled", "Web tools are not enabled on this server.");

    // Validate and canonicalize every caller URL before anything is spent: private,
    // loopback and metadata addresses are refused even though a provider fetches them.
    let input = rawInput;
    const urls = urlsOf(capability, rawInput);
    if (urls.length) {
      const safe: string[] = [];
      for (const url of urls) {
        try { safe.push(await d.assertSafeUrl(url)); }
        catch { throw new WebToolError(400, "url_blocked", `This URL cannot be fetched: ${url.slice(0, 200)}`); }
      }
      input = withUrls(capability, rawInput, safe);
    }

    const access = await d.workspaceAccess(ctx.workspaceId, capability);
    if (access === "disabled") throw new WebToolError(403, "web_disabled", "Web tools are turned off for this workspace.");
    if (access === "privacy") throw new WebToolError(403, "privacy_mode_blocked", "This workspace's privacy mode does not allow web tools.");
    const retryAfter = admitOrgCall(ctx.orgId ?? `user:${ctx.userId}`, started, d.config.orgPerMinute);
    if (retryAfter !== null) {
      throw new WebToolError(429, "rate_limited", "Too many web tool calls. Try again shortly.", retryAfter);
    }
    await d.assertCanSpend(ctx.orgId, ctx.workspaceId);

    // Deep fetches ask for a fresh render, so they bypass the cache.
    const cacheable = !(capability === "fetch" && (input as WebInput<"fetch">).depth === "deep");
    const key = cacheKey(capability, input);
    let output = cacheable ? cacheGet<WebOutput<C>>(key, started) : undefined;
    const cached = output !== undefined;
    let provider: WebProviderId | undefined;
    let attempts: WebAttempt[] = [];
    if (!output) {
      const deadlineMs = options.deadlineMs ?? (capability === "crawl" ? 120_000 : CALL_DEADLINE_MS[capability as Exclude<C, "crawl">]);
      try {
        const routed = await d.router.run(capability, input, { signal: ctx.signal ?? new AbortController().signal, deadlineAt: started + deadlineMs, parent: span });
        output = routed.result.data;
        provider = routed.provider;
        attempts = routed.attempts;
        output = dedupe(capability, output);
        const costCents = cents(routed.paid.reduce((sum, item) => sum + item.costUsd, 0));
        Object.assign(fields, { "docslurp.web.provider": provider, "docslurp.web.cost_cents": costCents,
          "docslurp.web.cost_source": routed.result.costSource, "docslurp.web.attempts": attempts.length });
        // Provider cost is our cost: internal, non-debiting events, one per paid attempt. The model
        // column names only the capability, since run cost breakdowns show models to customers.
        await recordProviderCosts(d, ctx, capability, callId, routed.paid, attempts, provider);
        if (cacheable) cachePut(key, output, d.now(), d.config);
      } catch (error) {
        // Attempts that did paid work before the call failed (or the caller left) are still our cost.
        const failed = error as { attempts?: WebAttempt[]; paid?: PaidAttempt[] };
        if (failed.attempts) Object.assign(fields, { "docslurp.web.attempts": failed.attempts.length });
        if (failed.paid?.length) {
          Object.assign(fields, { "docslurp.web.cost_cents": cents(failed.paid.reduce((sum, item) => sum + item.costUsd, 0)) });
          await recordProviderCosts(d, ctx, capability, callId, failed.paid, failed.attempts ?? [], undefined);
        }
        throw error;
      }
    }

    const charge = chargeFor(capability, input, output);
    let credits = 0;
    if (charge && charge.credits > 0) {
      credits = charge.credits;
      try {
        await d.recordCharge({
          userId: ctx.userId,
          scope: { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
          charge: { id: `web:${callId}`, metric: charge.metric as never, amount: charge.amount, unit: charge.unit, credits,
            metadata: { capability, surface: ctx.surface, cached, callId } },
        });
      } catch (error) {
        // A failed charge never fails a result the caller already has (same as search).
        console.error(`[web] charge failed call=${callId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    outcome = "ok";
    Object.assign(fields, { "docslurp.web.cache_hit": cached, "docslurp.web.result_count": resultCount(capability, output), "docslurp.web.credits": credits });
    const data = ctx.surface === "chat" ? chatSafe(capability, output) : output;
    return { ...data, cached, usage: { credits } };
  } catch (error) {
    outcome = error instanceof WebToolError ? error.code : (error as { code?: string })?.code ?? (error instanceof Error ? error.name : "error");
    throw error;
  } finally {
    const runtimeMs = d.now() - started;
    span.set({ ...fields, "docslurp.web.outcome": outcome, "docslurp.web.runtime_ms": runtimeMs });
    span.end(outcome === "ok" ? undefined : outcome);
    // Internal log line (SigNoz): provider named here only.
    console.log(`[web] call capability=${capability} surface=${ctx.surface} outcome=${outcome} provider=${fields["docslurp.web.provider"] ?? "-"} cache=${fields["docslurp.web.cache_hit"] ?? false} results=${fields["docslurp.web.result_count"] ?? 0} cost_cents=${fields["docslurp.web.cost_cents"] ?? 0} credits=${fields["docslurp.web.credits"] ?? 0} attempts=${fields["docslurp.web.attempts"] ?? 0} ms=${runtimeMs} call=${callId} org=${ctx.orgId ?? "-"} workspace=${ctx.workspaceId}`);
  }
}

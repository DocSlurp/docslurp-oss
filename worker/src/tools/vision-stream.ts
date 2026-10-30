/**
 * Guarded hosted vision completion: streams the response, aborts degenerate
 * output early (repetition loops, whitespace padding) and retries once on a
 * different route when the output is degenerate, refused, truncated or the
 * provider returned an error body.
 *
 * Usage is accounted per attempt (`[vision-attempt] ...`, deliberately not an
 * `[ai-usage]` line) and summed into the returned totals, so a discarded attempt
 * is still billed honestly; the caller logs the single `[ai-usage]` total.
 */
import { CHINA_PROVIDER_SLUGS, readProviderCharge } from "@docslurp/shared";

import { fetchWithProviderRetry } from "../lib/provider-retry.js";
import type { ProviderRateLease } from "../lib/provider-rate-limit.js";
import type { VisionRequestGate } from "../lib/vision-attempt-guard.js";

export type DegenerateReason = "repeated-pattern" | "low-diversity" | "whitespace-run" | "leader-run";
export interface DegenerateSignal {
  reason: DegenerateReason;
  /** Characters of output received when the detector fired. */
  atChars: number;
}

// --- degeneration detector -------------------------------------------------

/** Trailing whitespace / `&nbsp;` run that no real page produces. */
const WHITESPACE_RUN_CHARS = 1_500;
/** Trailing leader characters (`. `, `·`, `…`, `-`, `_`) with no word or number; real leaders stay under ~120. */
const LEADER_RUN_CHARS = 250;
/** Periods up to this length use the tighter span threshold (`| | |`, `&nbsp;`, one Hebrew word). */
const SHORT_PERIOD_MAX = 12;
const SHORT_PERIOD_SPAN = 1_500;
const LONG_PERIOD_MAX = 240;
/** Dot leaders, rules and repeated table rows stay far below this; observed loops run to tens of thousands. */
const LONG_PERIOD_SPAN = 4_000;
const DIVERSITY_WINDOW = 2_000;
const DIVERSITY_MIN_TOKENS = 150;
const DIVERSITY_MAX_RATIO = 0.05;
const CHECK_EVERY_CHARS = 256;
const TAIL_CHARS = 6_000;

function trailingWhitespaceRun(tail: string): number {
  let i = tail.length;
  while (i > 0) {
    const code = tail.charCodeAt(i - 1);
    if (code === 32 || code === 9 || code === 10 || code === 13 || code === 0xa0) {
      i -= 1;
    } else if (tail.startsWith("&nbsp;", i - 6) && i >= 6) {
      i -= 6;
    } else {
      break;
    }
  }
  return tail.length - i;
}

function trailingLeaderRun(tail: string): number {
  let i = tail.length;
  while (i > 0 && /[.·…_\-\s\u00a0]/.test(tail[i - 1]!)) i -= 1;
  return tail.length - i;
}

/** Length of the tail that repeats with period p (compares each char with the one p earlier). */
function periodicSpan(tail: string, p: number): number {
  let i = tail.length - 1;
  while (i - p >= 0 && tail.charCodeAt(i) === tail.charCodeAt(i - p)) i -= 1;
  return tail.length - 1 - i + p;
}

/** Inspects the end of `text`; returns a signal when it looks like a generation loop. */
export function detectDegeneration(text: string): DegenerateSignal | null {
  const tail = text.length > TAIL_CHARS ? text.slice(-TAIL_CHARS) : text;
  const atChars = text.length;

  if (trailingWhitespaceRun(tail) >= WHITESPACE_RUN_CHARS) return { reason: "whitespace-run", atChars };

  if (trailingLeaderRun(tail) >= LEADER_RUN_CHARS) return { reason: "leader-run", atChars };

  for (let p = 1; p <= LONG_PERIOD_MAX; p++) {
    const need = p <= SHORT_PERIOD_MAX ? SHORT_PERIOD_SPAN : LONG_PERIOD_SPAN;
    if (tail.length < need) break;
    if (periodicSpan(tail, p) >= need) return { reason: "repeated-pattern", atChars };
  }

  if (tail.length >= DIVERSITY_WINDOW) {
    const window = tail.slice(-DIVERSITY_WINDOW);
    const tokens = window.split(/\s+/).filter(Boolean);
    if (tokens.length >= DIVERSITY_MIN_TOKENS && new Set(tokens).size / tokens.length < DIVERSITY_MAX_RATIO) {
      // Dense tables reuse a small vocabulary too, but their rows differ; loops repeat lines or are one long line.
      const lines = window.split("\n").filter((line) => line.trim());
      if (lines.length < 20 || new Set(lines).size / lines.length < 0.3) return { reason: "low-diversity", atChars };
    }
  }
  return null;
}

/** Incremental wrapper: runs the (tail-bounded) check every few hundred characters. */
export function createDegenerationDetector() {
  let text = "";
  let checkedAt = 0;
  return {
    push(delta: string): DegenerateSignal | null {
      text += delta;
      if (text.length - checkedAt < CHECK_EVERY_CHARS) return null;
      checkedAt = text.length;
      return detectDegeneration(text);
    },
  };
}

// --- SSE -------------------------------------------------------------------

/** Yields the `data:` payload of each SSE event (comments and `[DONE]` skipped). */
export async function* readSseData(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  const drain = function* (final: boolean) {
    let index: number;
    while ((index = buffer.search(/\r?\n\r?\n/)) >= 0 || (final && buffer.trim())) {
      const raw = index >= 0 ? buffer.slice(0, index) : buffer;
      buffer = index >= 0 ? buffer.slice(index).replace(/^\r?\n\r?\n/, "") : "";
      const data = raw.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      if (data && data.trim() !== "[DONE]") yield data;
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    yield* drain(false);
  }
  buffer += decoder.decode();
  yield* drain(true);
}

// --- attempt model ---------------------------------------------------------

interface ChatUsage { prompt_tokens?: number; completion_tokens?: number; cost?: number; [key: string]: unknown }
interface ChoiceError { code?: number | string; message?: string; metadata?: { error_type?: string } & Record<string, unknown> }

export interface VisionAttempt {
  text: string;
  finishReason: string | null;
  model: string | null;
  provider: string | null;
  usage: ChatUsage | null;
  /** `choices[0].error` or a top-level `error` object. */
  error: ChoiceError | null;
  hadChoices: boolean;
  degenerate: DegenerateSignal | null;
  streamed: boolean;
  id: string | null;
}

export type RetryableOutcome = "degenerate" | "refusal" | "length" | "provider-error";

export function classifyAttempt(attempt: VisionAttempt): { kind: RetryableOutcome; detail: string } | null {
  if (attempt.degenerate) return { kind: "degenerate", detail: `${attempt.degenerate.reason} after ${attempt.degenerate.atChars} chars` };
  const message = attempt.error?.message ?? "";
  const refusal = attempt.finishReason === "content_filter"
    || attempt.error?.metadata?.error_type === "refusal"
    || /content[ -]?filter|blocked|refus/i.test(message);
  if (refusal) return { kind: "refusal", detail: message || attempt.finishReason || "content filtered" };
  if (attempt.finishReason === "error" || (attempt.error && !attempt.hadChoices)) {
    return { kind: "provider-error", detail: message || "provider returned an error body" };
  }
  if (attempt.error && !attempt.text) return { kind: "provider-error", detail: message || "provider error" };
  if (attempt.finishReason === "length") return { kind: "length", detail: "finish_reason=length" };
  return null;
}

/** Merges `provider.ignore` into any existing provider preferences without dropping them. */
export function withIgnoredProvider(body: Record<string, unknown>, provider: string): Record<string, unknown> {
  const existing = (body.provider && typeof body.provider === "object" ? body.provider : {}) as Record<string, unknown>;
  const ignore = Array.isArray(existing.ignore) ? existing.ignore.map(String) : [];
  return { ...body, provider: { ...existing, ignore: [...new Set([...ignore, provider])] } };
}

export interface RetryRoute {
  order: string[];
  allow_fallbacks: boolean;
}

/** Provider names come back as display names ("Amazon Bedrock") while routing slugs are "amazon-bedrock/us-east-1". */
function providerKey(value: string): string {
  return value.toLowerCase().split("/")[0]!.replace(/[^a-z0-9]/g, "");
}

function sameProvider(a: string, b: string): boolean {
  const x = providerKey(a), y = providerKey(b);
  return Boolean(x) && x === y;
}

/**
 * Request body for the single alternate-route retry, or null when no other route exists.
 *
 * - A refusal or content filter with a profile-preferred retry route sends
 *   `provider: {order: <route minus the failing provider>, allow_fallbacks}` (replacing the first-attempt preferences).
 * - Otherwise the failing provider goes into `provider.ignore`, merged with existing preferences. When those
 *   preferences forbid fallbacks, the ignored provider is also dropped from `order`; if that exhausts the list
 *   there is no alternate route (null) and a repeat on the same route is only worth it for a transient provider error.
 */
export function alternateRouteBody(
  body: Record<string, unknown>,
  failingProvider: string | null,
  kind: RetryableOutcome,
  preferred?: RetryRoute,
): Record<string, unknown> | null {
  if (!failingProvider) return body;
  const existing = (body.provider && typeof body.provider === "object" ? body.provider : {}) as Record<string, unknown>;
  if (kind === "refusal" && preferred) {
    const order = preferred.order.filter((p) => !sameProvider(p, failingProvider));
    if (order.length > 0) {
      // The retry route replaces failure-based ignores, but an org's China-provider restriction stays.
      const { ignore, ...rest } = existing;
      const kept = Array.isArray(ignore) ? ignore.filter((p) => (CHINA_PROVIDER_SLUGS as readonly unknown[]).includes(p)) : [];
      return { ...body, provider: { ...rest, order, allow_fallbacks: preferred.allow_fallbacks, ...(kept.length ? { ignore: kept } : {}) } };
    }
  }
  const ignored = withIgnoredProvider(body, failingProvider);
  if (existing.allow_fallbacks !== false || !Array.isArray(existing.order)) return ignored;
  const order = existing.order.map(String).filter((p) => !sameProvider(p, failingProvider));
  if (order.length === 0) return kind === "provider-error" ? body : null;
  return { ...ignored, provider: { ...(ignored.provider as Record<string, unknown>), order } };
}

export class VisionOutputRejectedError extends Error {
  constructor(
    message: string,
    readonly attempts: AttemptSummary[],
    readonly inputTokens: number,
    readonly outputTokens: number,
    readonly costCents: number | undefined,
    readonly degenerate: DegenerateSignal | null = null,
  ) {
    super(message);
    this.name = "VisionOutputRejectedError";
  }
}

/** The rejection behind `error` (it may be wrapped as a `cause`), whose summed usage was billed but produced no page. */
export function findVisionOutputRejected(error: unknown): VisionOutputRejectedError | null {
  for (let cur: unknown = error, depth = 0; cur && depth < 8; depth += 1) {
    if (cur instanceof VisionOutputRejectedError) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

const acceptedAttemptErrors = new WeakSet<object>();
/** What an accepted stream delivered before it broke (text so far, usage if a usage chunk arrived). */
const partialAttempts = new WeakMap<object, VisionAttempt>();

/** Provider usage a failed (not rejected) vision call was still billed for. */
export interface VisionBilledUsage {
  inputTokens: number;
  outputTokens: number;
  /** Provider charge when known; otherwise the caller prices the tokens. */
  costCents?: number;
  /** Token counts came from the provider's usage, or were estimated (prompt estimate, streamed text). */
  usageSource?: "provider" | "estimated";
}

const billedUsage = new WeakMap<object, VisionBilledUsage>();

/** Record on `error` the usage a failed vision call was billed for (first annotation wins). */
export function attachVisionBilledUsage(error: unknown, usage: VisionBilledUsage): void {
  if (error && typeof error === "object" && !billedUsage.has(error)) billedUsage.set(error, usage);
}

/** Usage billed for the failed vision call behind `error` (it may be wrapped as a `cause`), or null. */
export function findVisionBilledUsage(error: unknown): VisionBilledUsage | null {
  for (let cur: unknown = error, depth = 0; cur && depth < 8; depth += 1) {
    if (typeof cur === "object" && billedUsage.has(cur)) return billedUsage.get(cur)!;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

export interface AttemptSummary {
  attempt: number;
  provider: string | null;
  model: string | null;
  streamed: boolean;
  /** `stream-failed`: the provider accepted a streaming request that broke before its first chunk. */
  outcome: RetryableOutcome | "ok" | "stream-failed";
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
  costCents?: number;
  usageSource: "provider" | "estimated";
}

class StreamStartError extends Error {}

/**
 * The endpoint refused the streaming request itself (400/404/405/415/422/501) before accepting it: a
 * capability answer, not a billed failure. Its request is handed back to the vision guard.
 */
class StreamUnsupportedError extends StreamStartError {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const STREAM_UNSUPPORTED_STATUSES: ReadonlySet<number> = new Set([400, 404, 405, 415, 422, 501]);
/**
 * Statuses that say the endpoint or method itself is unsupported. 400 and 422 are left out: they
 * usually describe the request (a bad image, a schema), so they never turn streaming off.
 */
const STREAM_MEMO_STATUSES: ReadonlySet<number> = new Set([404, 405, 415, 501]);
/** Refusals (each followed by a successful non-streaming retry) before streaming is turned off. */
const STREAM_MEMO_OBSERVATIONS = 2;
/** How long an endpoint stays non-streaming, and how far apart its two observations may be. */
const STREAM_MEMO_TTL_MS = 10 * 60_000;

/**
 * Endpoints (chat completions URL + model) whose streaming request was refused with a capability
 * status while the same request without streaming then succeeded, twice within the TTL: calls in this
 * process go straight to non-streaming until the TTL ends. Learned only from that pair, so a refusal
 * caused by the request itself never turns streaming off, and one stray answer cannot either.
 */
const streamingUnsupported = new Map<string, { observations: number; firstAt: number; disabledUntil: number }>();

function streamingKey(args: { url: string; model: string }): string {
  return `${args.url}\u0000${args.model}`;
}

function streamingDisabled(key: string, now = Date.now()): boolean {
  const entry = streamingUnsupported.get(key);
  return Boolean(entry && entry.disabledUntil > now);
}

/** Records one refused-then-served pair; true when it turns streaming off for this endpoint. */
function noteStreamingUnsupported(key: string, status: number, now = Date.now()): boolean {
  if (!STREAM_MEMO_STATUSES.has(status)) return false;
  const previous = streamingUnsupported.get(key);
  const entry = previous && now - previous.firstAt <= STREAM_MEMO_TTL_MS && previous.disabledUntil <= now
    ? { ...previous, observations: previous.observations + 1 }
    : { observations: 1, firstAt: now, disabledUntil: 0 };
  if (entry.observations >= STREAM_MEMO_OBSERVATIONS) entry.disabledUntil = now + STREAM_MEMO_TTL_MS;
  streamingUnsupported.set(key, entry);
  return entry.disabledUntil > now;
}

/** Test hook: forget which endpoints refused streaming. */
export function resetStreamingSupportForTest(): void {
  streamingUnsupported.clear();
}

function chatText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => (typeof item === "string" ? item : typeof (item as { text?: unknown })?.text === "string" ? (item as { text: string }).text : "")).join("");
  }
  return "";
}

function blankAttempt(streamed: boolean): VisionAttempt {
  return { text: "", finishReason: null, model: null, provider: null, usage: null, error: null, hadChoices: false, degenerate: null, streamed, id: null };
}

function readStringField(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** OpenRouter sends `provider` as a name string on chunks; some gateways send `{ name }`. */
function readProviderName(value: unknown): string | null {
  return readStringField(value) ?? readStringField((value as { name?: unknown } | null)?.name);
}

async function consumeStream(response: Response, abort: () => void): Promise<VisionAttempt> {
  const attempt = blankAttempt(true);
  const detector = createDegenerationDetector();
  const reader = response.body?.getReader();
  if (!reader) throw new StreamStartError("stream response has no body");
  let sawChunk = false;
  try {
    for await (const data of readSseData(reader)) {
      sawChunk = true;
      let chunk: Record<string, any>;
      try { chunk = JSON.parse(data); } catch { continue; }
      attempt.id = readStringField(chunk.id) ?? attempt.id;
      attempt.model = readStringField(chunk.model) ?? attempt.model;
      attempt.provider = readProviderName(chunk.provider) ?? attempt.provider;
      if (chunk.usage && typeof chunk.usage === "object") attempt.usage = chunk.usage;
      if (chunk.error && typeof chunk.error === "object") attempt.error = chunk.error;
      const choice = chunk.choices?.[0];
      if (choice) {
        attempt.hadChoices = true;
        if (choice.finish_reason) attempt.finishReason = choice.finish_reason;
        if (choice.error && typeof choice.error === "object") attempt.error = choice.error;
        const delta = chatText(choice.delta?.content ?? choice.message?.content);
        if (delta) {
          attempt.text += delta;
          const signal = detector.push(delta);
          if (signal) {
            attempt.degenerate = signal;
            abort();
            await reader.cancel().catch(() => {});
            break;
          }
        }
      }
    }
  } catch (error) {
    if (attempt.degenerate) return attempt;
    if (!sawChunk && !(error instanceof Error && error.name === "AbortError")) throw new StreamStartError(error instanceof Error ? error.message : String(error));
    // Interrupted mid-stream: keep what arrived so the usage record counts the streamed output.
    if (error && typeof error === "object") partialAttempts.set(error, attempt);
    throw error;
  }
  return attempt;
}

async function consumeJson(response: Response): Promise<VisionAttempt> {
  const attempt = blankAttempt(false);
  const payload = (await response.json()) as Record<string, any>;
  attempt.id = readStringField(payload.id);
  attempt.model = readStringField(payload.model);
  attempt.provider = readProviderName(payload.provider);
  attempt.usage = payload.usage && typeof payload.usage === "object" ? payload.usage : null;
  const choice = payload.choices?.[0];
  attempt.hadChoices = Boolean(choice);
  attempt.text = chatText(choice?.message?.content).trim();
  attempt.finishReason = choice?.finish_reason ?? null;
  attempt.error = (choice?.error && typeof choice.error === "object" ? choice.error : null)
    ?? (payload.error && typeof payload.error === "object" ? payload.error : null);
  return attempt;
}

export function estimateTokens(text: string): number {
  const normalized = text.trim();
  return normalized ? Math.max(1, Math.ceil(normalized.length / 4)) : 0;
}

export interface GuardedCompletionArgs {
  url: string;
  headers: Record<string, string>;
  /** Request body without streaming fields; `provider` preferences, if any, are merged on retry. */
  body: Record<string, unknown>;
  model: string;
  providerLabel: string;
  openRouter: boolean;
  /** Streaming on unless VISION_STREAMING=off. */
  streaming: boolean;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /** Prompt plus image estimate, used for the rate reservation and for aborted streams without usage. */
  inputTokenEstimate: number;
  /** Profile-preferred route for the retry after a refusal or content filter (see `alternateRouteBody`). */
  preferredRetryRoute?: RetryRoute;
  /**
   * The vision attempt guard's admission for every HTTP request this call sends (first try, inline
   * retries, the streaming fallback, the alternate-route retry); null only outside a run (benchmarks).
   */
  gate: VisionRequestGate | null;
  /** Prices a discarded attempt that has no provider charge (config per-1k rates). */
  estimateCostCents?: (usage: { inputTokens: number; outputTokens: number }) => number | undefined;
}

export interface GuardedCompletion {
  text: string;
  raw: unknown;
  finishReason: string | null;
  model: string | null;
  provider: string | null;
  inputTokens: number;
  outputTokens: number;
  usageSource: "provider" | "estimated";
  costCents?: number;
  costMetadata?: Record<string, unknown>;
  attempts: number;
  attemptLog: AttemptSummary[];
  degenerate: DegenerateSignal | null;
}

async function runAttempt(args: GuardedCompletionArgs, body: Record<string, unknown>, streaming: boolean): Promise<VisionAttempt> {
  const controller = new AbortController();
  const onCaller = () => controller.abort(args.signal?.reason);
  if (args.signal?.aborted) controller.abort(args.signal.reason);
  else args.signal?.addEventListener("abort", onCaller, { once: true });
  let lease: ProviderRateLease | null = null;
  let attempt: VisionAttempt | null = null;
  try {
    const response = await fetchWithProviderRetry(args.url, {
      method: "POST",
      headers: args.headers,
      body: JSON.stringify(streaming ? { ...body, stream: true, stream_options: { include_usage: true } } : body),
    }, {
      provider: args.providerLabel,
      fetchImpl: args.fetchImpl,
      label: "vision request",
      signal: controller.signal,
      rateLimit: { model: args.model, tokens: args.inputTokenEstimate, onLease: (l) => { lease = l; } },
      ...(args.gate ? { gate: args.gate } : {}),
    });
    if (!response.ok) {
      const text = await response.text();
      if (streaming && STREAM_UNSUPPORTED_STATUSES.has(response.status)) {
        // Refused before acceptance: no page admission, no breaker failure, no org count.
        await args.gate?.unbilled("unsupported", { provider: args.providerLabel, status: response.status });
        throw new StreamUnsupportedError(`${response.status} ${text.slice(0, 200)}`, response.status);
      }
      args.gate?.failed();
      throw new Error(`vision request failed: ${response.status} ${text}`);
    }
    const isSse = streaming && (response.headers.get("content-type") ?? "").includes("text/event-stream");
    try {
      attempt = isSse ? await consumeStream(response, () => controller.abort(new Error("degenerate vision output"))) : await consumeJson(response);
    } catch (error) {
      args.gate?.failed();
      // The provider accepted the request: it may bill the input even though no usage came back.
      if (error && typeof error === "object") acceptedAttemptErrors.add(error);
      throw error;
    }
    return attempt;
  } finally {
    args.signal?.removeEventListener("abort", onCaller);
    // Settle this attempt's reservation with what it actually used (estimate when aborted without usage).
    const used = attempt?.usage
      ? (attempt.usage.prompt_tokens ?? 0) + (attempt.usage.completion_tokens ?? 0)
      : attempt ? args.inputTokenEstimate + estimateTokens(attempt.text) : null;
    (lease as ProviderRateLease | null)?.settle(used);
  }
}

function summarize(args: GuardedCompletionArgs, attempt: VisionAttempt, index: number, outcome: RetryableOutcome | null): AttemptSummary & { charge: ReturnType<typeof readProviderCharge> } {
  const charge = readProviderCharge(attempt.usage);
  const hasUsage = Boolean(attempt.usage);
  const inputTokens = attempt.usage?.prompt_tokens ?? args.inputTokenEstimate;
  const outputTokens = attempt.usage?.completion_tokens ?? estimateTokens(attempt.text);
  const costCents = charge.costCents ?? (hasUsage ? undefined : args.estimateCostCents?.({ inputTokens, outputTokens }));
  return {
    attempt: index, provider: attempt.provider, model: attempt.model, streamed: attempt.streamed, outcome: outcome ?? "ok",
    finishReason: attempt.finishReason, inputTokens, outputTokens, costCents, usageSource: hasUsage ? "provider" : "estimated", charge,
  };
}

/** A streaming request the provider accepted (200) that broke before any chunk: input estimated, no output. */
function acceptedWithoutOutput(args: GuardedCompletionArgs, index: number): AttemptSummary & { charge: ReturnType<typeof readProviderCharge> } {
  const inputTokens = args.inputTokenEstimate;
  return {
    attempt: index, provider: null, model: null, streamed: true, outcome: "stream-failed", finishReason: null,
    inputTokens, outputTokens: 0, costCents: args.estimateCostCents?.({ inputTokens, outputTokens: 0 }),
    usageSource: "estimated", charge: readProviderCharge(null),
  };
}

function logAttempt(s: AttemptSummary, model: string) {
  console.log(`[vision-attempt] model=${model} input_tokens=${s.inputTokens} output_tokens=${s.outputTokens} attempt=${s.attempt} outcome=${s.outcome} usage_source=${s.usageSource}`);
}

/** One guarded call: stream (with non-streaming fallback), classify, retry once on another route. */
export async function runGuardedChatCompletion(args: GuardedCompletionArgs): Promise<GuardedCompletion> {
  let streaming = args.streaming && !streamingDisabled(streamingKey(args));
  const log: Array<ReturnType<typeof summarize>> = [];
  let body = args.body;
  let last: VisionAttempt | null = null;
  let degenerate: DegenerateSignal | null = null;

  const rejected = (attempts: number, verdict: { kind: RetryableOutcome; detail: string }) => {
    const totals = totalsOf(log, args);
    const trail = log.map((s) => `attempt ${s.attempt}: ${s.outcome} via ${s.provider ?? "unknown provider"}`).join("; ");
    return new VisionOutputRejectedError(
      `vision output rejected after ${attempts} attempt${attempts === 1 ? "" : "s"} (${verdict.kind}: ${verdict.detail}); ${trail}`,
      log.map(stripCharge), totals.inputTokens, totals.outputTokens, totals.costCents, degenerate,
    );
  };

  for (let index = 1; index <= 2; index++) {
    let attempt: VisionAttempt;
    try {
      try {
        attempt = await runAttempt(args, body, streaming);
      } catch (error) {
        if (!(error instanceof StreamStartError)) throw error;
        // A 200 stream that broke before its first chunk was still accepted (and may be billed): count it.
        if (acceptedAttemptErrors.has(error)) {
          const summary = acceptedWithoutOutput(args, index);
          log.push(summary);
          logAttempt(summary, args.model);
        }
        // Endpoint rejects or fails streaming before the first chunk: one non-streaming retry of the same attempt.
        console.warn(`[vision-stream] streaming unavailable (${error.message}); retrying without streaming`);
        streaming = false;
        attempt = await runAttempt(args, body, false);
        if (error instanceof StreamUnsupportedError && noteStreamingUnsupported(streamingKey(args), error.status)) {
          console.warn(`[vision-stream] model=${args.model} streaming unsupported by this endpoint (${error.status}); non-streaming for ${STREAM_MEMO_TTL_MS / 60_000} min in this process`);
        }
      }
    } catch (error) {
      // Earlier attempts (and an accepted one that broke mid-response) were billed: keep that for the caller.
      const accepted = error !== null && typeof error === "object" && acceptedAttemptErrors.has(error);
      const totals = log.length > 0 ? totalsOf(log, args) : null;
      const partial = accepted ? partialAttempts.get(error as object) ?? null : null;
      // An interrupted stream counts its streamed output (provider usage when a usage chunk arrived).
      const estimate = accepted ? {
        inputTokens: partial?.usage?.prompt_tokens ?? args.inputTokenEstimate,
        outputTokens: partial?.usage?.completion_tokens ?? estimateTokens(partial?.text ?? ""),
      } : null;
      if (totals || estimate) {
        const inputTokens = (totals?.inputTokens ?? 0) + (estimate?.inputTokens ?? 0);
        const outputTokens = (totals?.outputTokens ?? 0) + (estimate?.outputTokens ?? 0);
        const known = totals?.costCents ?? (totals ? undefined : 0);
        const estimated = estimate ? readProviderCharge(partial?.usage ?? null).costCents ?? args.estimateCostCents?.(estimate) : 0;
        const providerUsage = (!totals || totals.usageSource === "provider") && (!estimate || Boolean(partial?.usage));
        attachVisionBilledUsage(error, {
          inputTokens, outputTokens,
          ...(known !== undefined && estimated !== undefined ? { costCents: known + estimated } : {}),
          usageSource: providerUsage ? "provider" : "estimated",
        });
      }
      throw error;
    }
    last = attempt;
    degenerate ??= attempt.degenerate;
    const verdict = classifyAttempt(attempt);
    const summary = summarize(args, attempt, index, verdict?.kind ?? null);
    log.push(summary);
    logAttempt(summary, args.model);
    if (!verdict) break;
    args.gate?.failed();
    console.warn(`[vision-stream] attempt ${index} rejected: ${verdict.kind} (${verdict.detail}) provider=${attempt.provider ?? "unknown"}`);
    if (index === 2) throw rejected(index, verdict);
    if (args.openRouter) {
      const next = alternateRouteBody(args.body, attempt.provider, verdict.kind, args.preferredRetryRoute);
      if (!next) {
        console.warn(`[vision-stream] no alternate route left after ${attempt.provider}; not retrying`);
        throw rejected(index, verdict);
      }
      body = next;
    }
  }

  const finalAttempt = last!;
  const totals = totalsOf(log, args);
  return {
    text: finalAttempt.text.trim(),
    raw: {
      id: finalAttempt.id, model: finalAttempt.model, provider: finalAttempt.provider, usage: finalAttempt.usage ?? undefined,
      choices: [{ message: { content: finalAttempt.text }, finish_reason: finalAttempt.finishReason }],
    },
    finishReason: finalAttempt.finishReason,
    model: finalAttempt.model,
    provider: finalAttempt.provider,
    ...totals,
    // Attempts that returned output; a stream broken before its first chunk is only in the log (and usage).
    attempts: log.filter((s) => s.outcome !== "stream-failed").length,
    attemptLog: log.map(stripCharge),
    /** The signal that triggered a retry (the accepted output itself is never degenerate). */
    degenerate,
  };
}

function stripCharge(s: AttemptSummary & { charge?: unknown }): AttemptSummary {
  const { charge: _charge, ...rest } = s;
  return rest;
}

function totalsOf(log: Array<ReturnType<typeof summarize>>, args: GuardedCompletionArgs) {
  const inputTokens = log.reduce((n, s) => n + s.inputTokens, 0);
  const outputTokens = log.reduce((n, s) => n + s.outputTokens, 0);
  const anyCharge = log.some((s) => s.charge.costCents !== undefined);
  // Without any provider charge, leave cost to the caller's per-token pricing of the summed tokens
  // (estimated ones included). With one, attempts without a charge add their estimate.
  const costCents = anyCharge
    ? log.reduce((n, s) => n + (s.charge.costCents ?? s.costCents ??
      args.estimateCostCents?.({ inputTokens: s.inputTokens, outputTokens: s.outputTokens }) ?? 0), 0)
    : undefined;
  const usageSource: "provider" | "estimated" = log.every((s) => s.usageSource === "provider") ? "provider" : "estimated";
  const costMetadata = anyCharge ? {
    costSource: "provider",
    providerCostUsd: log.reduce((n, s) => n + (s.charge.costCents ?? 0), 0) / 100,
    ...(log.length > 1 ? { visionAttempts: log.map(stripCharge) } : log[0]!.charge.metadata),
  } : log.length > 1 ? { visionAttempts: log.map(stripCharge) } : undefined;
  return { inputTokens, outputTokens, usageSource, costCents, costMetadata };
}

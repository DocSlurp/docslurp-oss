import type { Context, MiddlewareHandler } from "hono";

import { middlewareErrorResponse } from "../lib/api-error.js";
import { requestIp } from "../lib/request-context.js";
import { classifyRateLimitCategory, rateLimitAddress } from "../lib/rate-limit-keys.js";

import { chatTurnTimeBudget } from "../services/chat-turn-deadline.js";

/**
 * In-flight cap on AI chat turns (`chat-ai` routes, streaming included) per
 * API key, and per visitor (IP, or IPv6 /64) inside a browser (client) key.
 * Visitors behind one NAT or office address share the per-visitor cap.
 *
 * The request-rate limits count turns as they start; a turn can then run up to
 * its deadline and an SSE stream stays open the whole time, so a key at its
 * rate limit could still hold hundreds of concurrent model turns. A slot is
 * held until the response body finishes or is cancelled, the handler throws,
 * or the hard deadline (turn deadline + grace) passes, whichever comes first,
 * so a client that stops reading cannot hold a slot past the turn.
 *
 * Defaults: browser keys 16 per key and 3 per visitor; server keys have no
 * per-key default (backend batch callers), and any key can set its own with a
 * `concurrent` rate-limit rule. Counts are per process. Sessions (the
 * first-party app) are not capped here. 0 disables a cap.
 */
const DEFAULTS = { perClientKey: 16, perServerKey: 0, perClientVisitor: 3 };
/** Grace after the turn deadline before a slot is reclaimed regardless of the stream. */
const RELEASE_GRACE_MS = 15_000;

function readCap(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const inFlight = new Map<string, number>();

function acquire(keys: Array<{ key: string; cap: number }>, holdMs: number): (() => void) | null {
  if (keys.some(({ key, cap }) => cap > 0 && (inFlight.get(key) ?? 0) >= cap)) return null;
  for (const { key } of keys) inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(deadline);
    for (const { key } of keys) {
      const next = (inFlight.get(key) ?? 1) - 1;
      if (next <= 0) inFlight.delete(key); else inFlight.set(key, next);
    }
  };
  const deadline = setTimeout(release, holdMs);
  deadline.unref?.();
  return release;
}

/** The response with `release` called once its body is fully sent or cancelled (or at once when it has none). */
function releaseWhenDone(c: Context, release: () => void): void {
  const body = c.res.body;
  // A JSON answer (or an error) is complete when the handler returns; only an
  // event stream keeps working while the client reads it.
  if (!body || c.error || !/text\/event-stream/i.test(c.res.headers.get("Content-Type") ?? "")) {
    release();
    return;
  }
  const reader = body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      release();
      await reader.cancel(reason).catch(() => undefined);
    },
  });
  c.res = new Response(stream, { status: c.res.status, statusText: c.res.statusText, headers: c.res.headers });
}

export function chatConcurrencyKeys(c: Context): Array<{ key: string; cap: number }> {
  const actor = c.get("requestActor");
  if (actor?.type !== "apiKey") return [];
  const client = actor.apiKey.keyType !== "server";
  const own = (actor.apiKey.rateLimits ?? []).find((rule) => rule.metric === "concurrent")?.limit;
  const perKey = own ?? (client
    ? readCap("API_CHAT_MAX_CONCURRENT_PER_KEY", DEFAULTS.perClientKey)
    : readCap("API_CHAT_MAX_CONCURRENT_PER_SERVER_KEY", DEFAULTS.perServerKey));
  const keys = [{ key: `key:${actor.apiKey.keyId}`, cap: perKey }];
  if (client) {
    // No client address: one shared "unknown" visitor, never an uncapped one.
    const ip = requestIp(c);
    keys.push({ key: `key:${actor.apiKey.keyId}:ip:${ip ? rateLimitAddress(ip) : "unknown"}`, cap: readCap("API_CHAT_MAX_CONCURRENT_PER_CLIENT_VISITOR", DEFAULTS.perClientVisitor) });
  }
  return keys.filter(({ cap }) => cap > 0);
}

/** How long a slot may be held: the turn deadline plus grace. */
export function chatSlotHoldMs(): number {
  return chatTurnTimeBudget().turnDeadlineMs + RELEASE_GRACE_MS;
}

/**
 * Takes a slot for a chat turn outside the HTTP middleware (the MCP `chat`
 * tool). Null when a cap is full; otherwise call the release when the turn ends.
 */
export function acquireChatSlot(c: Context): { release: () => void } | null | "uncapped" {
  const keys = chatConcurrencyKeys(c);
  if (keys.length === 0) return "uncapped";
  const release = acquire(keys, chatSlotHoldMs());
  return release ? { release } : null;
}

declare module "hono" {
  interface ContextVariableMap {
    chatConcurrencyCounted: boolean;
  }
}

const RETRY_AFTER_SECONDS = 5;

/** `limited` shapes the 429 for protocol surfaces (the OpenAI-compatible route); default is the API error envelope. */
export function createChatConcurrencyLimit(limited?: (c: Context) => Response): MiddlewareHandler {
  return async (c, next) => {
    if (c.get("chatConcurrencyCounted") || classifyRateLimitCategory(c.req.method, c.req.path) !== "chat-ai") return next();
    const keys = chatConcurrencyKeys(c);
    if (keys.length === 0) return next();
    const release = acquire(keys, chatSlotHoldMs());
    if (!release) {
      c.header("Retry-After", String(RETRY_AFTER_SECONDS));
      return limited?.(c) ?? middlewareErrorResponse(c, 429, "rate_limited", "Too many chat requests in progress for this key; wait for one to finish", {
        category: "chat-ai", policy: "chat-concurrency", retryAfterSeconds: RETRY_AFTER_SECONDS,
      });
    }
    c.set("chatConcurrencyCounted", true);
    try {
      await next();
    } catch (error) {
      release();
      throw error;
    }
    releaseWhenDone(c, release);
  };
}

export const chatConcurrencyLimit: MiddlewareHandler = createChatConcurrencyLimit();

/** Test hook: in-flight turns for a counter key. */
export function chatTurnsInFlight(key: string): number {
  return inFlight.get(key) ?? 0;
}

export function resetChatConcurrency(): void {
  inFlight.clear();
}

import type { Context, MiddlewareHandler } from "hono";

import { middlewareErrorResponse } from "../lib/api-error.js";
import { requestIp } from "../lib/request-context.js";
import { classifyRateLimitCategory, rateLimitAddress } from "../lib/rate-limit-keys.js";

/**
 * In-flight cap on AI chat turns (`chat-ai` routes, streaming included) per
 * API key, and per visitor (IP) inside a browser (client) key.
 *
 * The request-rate limits count turns as they start; a turn can then run up to
 * its deadline (about 100 s) and an SSE stream stays open the whole time, so a
 * key at its rate limit could still hold hundreds of concurrent model turns.
 * This counts turns until their response body finishes, is cancelled or the
 * handler throws. Counts are per process (a stopgap with no shared store,
 * like the in-memory rate limiter). Sessions (the first-party app) are not
 * capped here. 0 disables a cap.
 */
const DEFAULTS = { perKey: 16, perClientVisitor: 3 };

function readCap(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

const inFlight = new Map<string, number>();

function acquire(keys: Array<{ key: string; cap: number }>): (() => void) | null {
  if (keys.some(({ key, cap }) => cap > 0 && (inFlight.get(key) ?? 0) >= cap)) return null;
  for (const { key } of keys) inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const { key } of keys) {
      const next = (inFlight.get(key) ?? 1) - 1;
      if (next <= 0) inFlight.delete(key); else inFlight.set(key, next);
    }
  };
}

/** The response with `release` called once its body is fully sent or cancelled (or at once when it has none). */
function releaseWhenDone(c: Context, release: () => void): void {
  const body = c.res.body;
  if (!body) {
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
  const keys = [{ key: `key:${actor.apiKey.keyId}`, cap: readCap("API_CHAT_MAX_CONCURRENT_PER_KEY", DEFAULTS.perKey) }];
  const ip = requestIp(c);
  if (actor.apiKey.keyType !== "server" && ip) {
    keys.push({ key: `key:${actor.apiKey.keyId}:ip:${rateLimitAddress(ip)}`, cap: readCap("API_CHAT_MAX_CONCURRENT_PER_CLIENT_VISITOR", DEFAULTS.perClientVisitor) });
  }
  return keys.filter(({ cap }) => cap > 0);
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
    const release = acquire(keys);
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

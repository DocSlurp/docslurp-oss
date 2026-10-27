import { WebProviderError, type ProviderCallContext, type WebPage } from "../types.js";

function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 15 * 60_000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 15 * 60_000)) : undefined;
}

/** Map a provider HTTP status to a failover decision. 432/433 are plan or pay-as-you-go limits. */
export function providerErrorForStatus(provider: string, status: number, retryAfter: string | null): WebProviderError {
  const message = `${provider} responded ${status}`;
  if (status === 401 || status === 403) return new WebProviderError("auth", message, status);
  if (status === 402 || status === 432 || status === 433) return new WebProviderError("quota_exhausted", message, status);
  if (status === 429) return new WebProviderError("rate_limited", message, status, retryAfterMs(retryAfter));
  if (status === 408 || status === 504) return new WebProviderError("timeout", message, status);
  if (status >= 500) return new WebProviderError("unavailable", message, status);
  return new WebProviderError("invalid_request", message, status);
}

/**
 * One JSON request to a provider's fixed API host. Bodies of failed responses
 * are read (bounded) for logs only, never surfaced to callers.
 */
export async function providerJson<T>(provider: string, ctx: ProviderCallContext, url: string, init: {
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
}): Promise<T> {
  let response: Response;
  try {
    response = await ctx.fetch(url, {
      method: init.method ?? "POST",
      headers: { Accept: "application/json", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...init.headers },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctx.signal,
    });
  } catch (error) {
    if (ctx.signal.aborted) {
      const reason = ctx.signal.reason as { name?: string } | undefined;
      if (reason?.name === "TimeoutError") throw new WebProviderError("timeout", `${provider} timed out`);
      throw error;
    }
    throw new WebProviderError("unavailable", `${provider} request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    const error = providerErrorForStatus(provider, response.status, response.headers.get("retry-after"));
    if (detail) error.message = `${error.message}: ${detail}`;
    throw error;
  }
  try {
    return await response.json() as T;
  } catch {
    throw new WebProviderError("unavailable", `${provider} returned invalid JSON`, response.status);
  }
}

export function clip(text: unknown, maxCharacters: number): string | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= maxCharacters ? trimmed : `${trimmed.slice(0, maxCharacters)}\n\n[truncated]`;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Keep only fields with a value, so normalized pages carry no provider-specific keys. */
export function page(fields: WebPage): WebPage {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as unknown as WebPage;
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Why a single page could not be read, from the per-URL error: drives tier escalation and is shown as "unreadable". */
export function pageFailureReason(error: unknown): string {
  const status = error instanceof WebProviderError ? error.status : undefined;
  if (status === 401 || status === 403 || status === 429 || status === 451) return "blocked";
  if (error instanceof WebProviderError && error.kind === "timeout") return "timeout";
  return status ? `http_${status}` : "unreadable";
}

/** Reasons from a provider's own per-URL status (target site HTTP code). */
export function targetStatusReason(status: number | undefined): string | null {
  if (!status || status < 400) return null;
  return status === 401 || status === 403 || status === 429 || status === 451 ? "blocked" : `http_${status}`;
}

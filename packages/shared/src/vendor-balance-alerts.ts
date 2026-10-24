import { createHash } from "node:crypto";
import { emitTelemetryLog } from "./telemetry.js";

const vendors: Record<string, { host: string; key: string | string[]; header?: string; query?: string }> = {
  openai: { host: "api.openai.com", key: "OPENAI_API_KEY" },
  openrouter: { host: "openrouter.ai", key: "OPENROUTER_API_KEY" },
  deepinfra: { host: "api.deepinfra.com", key: "DEEPINFRA_API_KEY" },
  google: { host: "generativelanguage.googleapis.com", key: "GOOGLE_GENERATIVE_AI_API_KEY", header: "x-goog-api-key", query: "key" },
  perplexity: { host: "api.perplexity.ai", key: ["PERPLEXITY_API_KEY", "PERPLEXITYAI_API_KEY"] },
  resend: { host: "api.resend.com", key: "RESEND_API_KEY" },
  fly: { host: "api.machines.dev", key: "FLY_WORKER_API_TOKEN" },
  vast: { host: "console.vast.ai", key: "VAST_API_KEY" },
  anthropic: { host: "api.anthropic.com", key: "ANTHROPIC_API_KEY", header: "x-api-key" },
};

/** Never classify tenant HTTP responses, ordinary rate limiting or BYOK failures. */
export function vendorBillingReason(status: number, body: string): string | null {
  if (status === 200 && body) {
    try {
      const error = (JSON.parse(body) as { error?: unknown }).error;
      if (!error || typeof error !== "object") return null;
      const fields = error as { code?: unknown; type?: unknown; message?: unknown };
      if (fields.code === 402 || fields.code === "402") return "payment_required";
      // Only a real top-level upstream error object, never assistant content.
      return vendorBillingReason(429, [fields.code, fields.type, fields.message].filter(value => typeof value === "string").join(" "));
    } catch { return null; }
  }
  if (status === 402) return "payment_required";
  if (![400, 403, 429].includes(status)) return null;
  if (/insufficient_quota|billing_hard_limit(?:_reached)?|monthly_quota_exceeded|daily_quota_exceeded|billing_disabled/i.test(body)) return "billing_quota_exhausted";
  if (/credit_balance_(?:too_low|exhausted)|insufficient[ _-]+(?:credits|balance)|credit balance.{0,30}(?:too low|insufficient|exhausted)/i.test(body)) return "vendor_credit_exhausted";
  return null;
}

export function platformVendorScope(provider: string, url: URL, headers: Headers, env: NodeJS.ProcessEnv = process.env): string | null {
  const vendor = vendors[provider];
  if (!vendor || url.protocol !== "https:" || url.hostname !== vendor.host) return null;
  const supplied = headers.get(vendor.header ?? "authorization");
  const keys = (Array.isArray(vendor.key) ? vendor.key : [vendor.key]).map(name => env[name]?.trim()).filter(Boolean);
  const key = keys.find(key => supplied === (vendor.header || (provider === "fly" && key?.startsWith("FlyV1 ")) ? key : `Bearer ${key}`) || (!supplied && vendor.query && url.searchParams.get(vendor.query) === key));
  if (!key) return null;
  // Credential changes must not resolve an incident for the previous key.
  return `${provider}:${createHash("sha256").update(key).digest("hex")}`;
}

/** Bounded SSE framing. Returns only upstream top-level error objects, not generated content. */
export class VendorErrorFrames {
  private line = "";
  private data = "";
  private overflow = false;
  uninspectable = false;
  push(fragment: string, finish = false): string[] {
    const errors: string[] = [];
    const flushLine = () => {
      if (!this.line) {
        if (this.overflow) this.uninspectable = true;
        else if (this.data.trim() && this.data.trim() !== "[DONE]") {
          try {
            const value = JSON.parse(this.data) as { error?: unknown };
            if (value && value.error && typeof value.error === "object") errors.push(JSON.stringify({ error: value.error }));
          } catch { this.uninspectable = true; }
        }
        this.data = ""; this.overflow = false;
      } else if (this.line.startsWith("data:")) {
        const next = this.line.slice(5).trimStart();
        if (this.data.length + next.length <= 16384) this.data += (this.data ? "\n" : "") + next;
        else this.overflow = true;
      }
      this.line = "";
    };
    for (const char of fragment) {
      if (char === "\r") continue;
      if (char === "\n") flushLine();
      else if (this.line.length < 16384) this.line += char;
      else this.overflow = true;
    }
    if (finish) { if (this.line) flushLine(); flushLine(); }
    return errors;
  }
}

type Signal = { provider: string; operation: string; status: "firing" | "resolved"; reason: string };
type State = { firing: boolean; delivered: "firing" | "resolved" | null; lastAttempt: number; lastObserved: number; pending: boolean; provider: string; operation: string; reason: string; queue: Promise<void> };

export class VendorBalanceMonitor {
  private readonly states = new Map<string, State>();
  constructor(private readonly notify: (signal: Signal) => Promise<void>, private readonly emit: (signal: Signal) => void, private readonly now = Date.now) {}

  observe(scope: string, provider: string, operation: string, status: number, body = ""): void {
    if (!/^[a-z0-9_.-]{1,40}$/.test(operation)) return;
    const reason = vendorBillingReason(status, body);
    if (!reason && (status < 200 || status >= 300)) return;
    const key = `${scope}:${operation}`;
    let state = this.states.get(key);
    if (!state) {
      if (!reason) return;
      // Resolved entries disappear immediately; abandoned credential scopes expire
      // silently after 24h, never producing a made-up recovery notification.
      for (const [oldKey, old] of this.states) {
        if (!old.pending && this.now() - old.lastObserved >= 24 * 3600_000) this.states.delete(oldKey);
      }
      if (this.states.size >= 32) return;
      state = { firing: false, delivered: null, lastAttempt: -Infinity, lastObserved: this.now(), pending: false, provider, operation, reason, queue: Promise.resolve() };
      this.states.set(key, state);
    }
    const firing = reason !== null;
    const changed = state.firing !== firing;
    state.firing = firing;
    state.lastObserved = this.now();
    state.reason = reason ?? "successful_upstream_response";
    if (changed) this.emit({ provider, operation, status: firing ? "firing" : "resolved", reason: state.reason });
    if (state.pending) return;
    if (!firing && state.delivered !== "firing") { this.states.delete(key); return; }
    const repeat = firing && state.delivered === "firing";
    if (!changed && this.now() - state.lastAttempt < (repeat ? 4 * 3600_000 : 60_000)) return;
    state.queue = this.dispatch(key, state);
  }

  private async dispatch(key: string, state: State): Promise<void> {
    state.pending = true;
    state.lastAttempt = this.now();
    const firing = state.firing;
    try {
      if (firing || state.delivered === "firing") {
        await this.notify({ provider: state.provider, operation: state.operation, status: firing ? "firing" : "resolved", reason: state.reason });
        state.delivered = firing ? "firing" : "resolved";
      }
    } catch { /* Retry only on new evidence after cooldown; retain undelivered recovery. */ }
    finally {
      state.pending = false;
      if (state.firing !== firing) await this.dispatch(key, state);
      else if (!state.firing && state.delivered !== "firing" && this.states.get(key) === state) this.states.delete(key);
    }
  }

  async settled(): Promise<void> { await Promise.all([...this.states.values()].map(state => state.queue)); }
}

async function notifyTelegram(signal: Signal): Promise<void> {
  const env = process.env;
  if (env.NODE_ENV !== "production") throw new Error("Vendor Telegram requires production mode");
  if (["off", "false", "0", "no"].includes(env.ALERT_TELEGRAM?.trim().toLowerCase() ?? "")) throw new Error("Vendor Telegram disabled");
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chat = env.ALERT_TELEGRAM_CHAT_ID?.trim() || env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chat) throw new Error("Vendor Telegram not configured");
  const text = `[${signal.status.toUpperCase()}] Vendor billing/quota: ${signal.provider}\nOperation: ${signal.operation}\nEvidence: ${signal.reason}\n${signal.status === "resolved" ? "An actual upstream request succeeded in the same credential scope; no balance estimate." : "Upstream rejected the platform credential. Check the vendor billing console; no balance estimate."}`;
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(5000) });
    const result = await response.json() as { ok?: boolean };
    if (!response.ok || result.ok !== true) throw new Error("delivery incomplete");
  } catch {
    console.error("[vendor-billing] telegram_delivery_failed=true");
    throw new Error("Vendor notification delivery incomplete");
  }
}

export const vendorBalanceMonitor = new VendorBalanceMonitor(notifyTelegram, signal => {
  const attributes = { "docslurp.vendor": signal.provider, "docslurp.operation": signal.operation, "docslurp.alert.status": signal.status, "docslurp.vendor.billing_reason": signal.reason };
  const body = `[vendor-billing] provider=${signal.provider} operation=${signal.operation} status=${signal.status} reason=${signal.reason}`;
  console.warn(body);
  emitTelemetryLog({ eventName: "docslurp.vendor.billing", severityText: signal.status === "firing" ? "warn" : "info", body, attributes });
});

import { describe, expect, it, vi } from "vitest";
vi.mock("../telemetry.js", () => ({ emitTelemetryLog: vi.fn() }));
import { platformVendorScope, vendorBillingReason, VendorBalanceMonitor, vendorBalanceMonitor, VendorErrorFrames } from "../vendor-balance-alerts.js";

describe("vendor billing evidence", () => {
  it.each(["development", "test", "preview", "staging", undefined])("never sends vendor Telegram outside production (%s)", async (nodeEnv) => {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "test-token");
    vi.stubEnv("TELEGRAM_CHAT_ID", "test-chat");
    vi.stubEnv("ALERT_TELEGRAM", "on");
    const transport = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
    vi.stubGlobal("fetch", transport);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vendorBalanceMonitor.observe(`nonproduction-${nodeEnv}`, "openai", "chat", 402);
      await vendorBalanceMonitor.settled();
      expect(transport).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    }
  });

  it("distinguishes billing failure from normal rate limits", () => {
    expect(vendorBillingReason(402, "")).toBe("payment_required");
    expect(vendorBillingReason(429, '{"error":{"code":"insufficient_quota"}}')).toBe("billing_quota_exhausted");
    expect(vendorBillingReason(403, "credit balance is too low")).toBe("vendor_credit_exhausted");
    expect(vendorBillingReason(429, "rate_limit_exceeded: tokens per minute")).toBeNull();
    expect(vendorBillingReason(500, "secret insufficient_quota")).toBeNull();
  });
  it("accepts only configured platform credentials on exact vendor hosts", () => {
    const env = { OPENAI_API_KEY: "secret-platform" };
    const headers = new Headers({ authorization: "Bearer secret-platform" });
    const scope = platformVendorScope("openai", new URL("https://api.openai.com/v1/chat"), headers, env);
    expect(scope).toMatch(/^openai:/);
    expect(scope).not.toContain("secret-platform");
    expect(platformVendorScope("openai", new URL("https://api.openai.com/v1/chat"), new Headers({ authorization: "Bearer customer-key" }), env)).toBeNull();
    expect(platformVendorScope("openai", new URL("https://docslurp.io/v1/chat"), headers, env)).toBeNull();
    expect(platformVendorScope("openai", new URL("https://api.openai.com.evil.invalid"), headers, env)).toBeNull();
  });
  it("matches real Google, SaaS email and Fly platform authentication while excluding other keys", () => {
    const google = new URL("https://generativelanguage.googleapis.com/v1beta/models/test?key=google-platform");
    expect(platformVendorScope("google", google, new Headers(), { GOOGLE_GENERATIVE_AI_API_KEY: "google-platform" })).toMatch(/^google:/);
    expect(platformVendorScope("google", google, new Headers(), { GOOGLE_GENERATIVE_AI_API_KEY: "different-platform" })).toBeNull();
    expect(platformVendorScope("resend", new URL("https://api.resend.com/emails"), new Headers({ authorization: "Bearer resend-platform" }), { RESEND_API_KEY: "resend-platform" })).toMatch(/^resend:/);
    expect(platformVendorScope("fly", new URL("https://api.machines.dev/v1/apps/x/machines"), new Headers({ authorization: "FlyV1 platform" }), { FLY_WORKER_API_TOKEN: "FlyV1 platform" })).toMatch(/^fly:/);
    expect(vendorBillingReason(429, '{"name":"monthly_quota_exceeded"}')).toBe("billing_quota_exhausted");
    expect(vendorBillingReason(403, '{"reason":"BILLING_DISABLED"}')).toBe("billing_quota_exhausted");
    expect(vendorBillingReason(429, '{"status":"RESOURCE_EXHAUSTED"}')).toBeNull();
  });
  it("deduplicates and resolves only an actual success in the same credential/operation scope", async () => {
    const notify = vi.fn(async (_signal: { status: string; reason: string }) => {}), emit = vi.fn();
    const monitor = new VendorBalanceMonitor(notify, emit, () => 1000);
    monitor.observe("platform-a", "openai", "chat", 429, "insufficient_quota secret-response-content");
    monitor.observe("platform-a", "openai", "chat", 429, "insufficient_quota");
    monitor.observe("platform-a", "openai", "chat", 429, "rate_limit_exceeded");
    monitor.observe("platform-b", "openai", "chat", 200);
    monitor.observe("platform-a", "openai", "embedding", 200);
    await monitor.settled();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(notify.mock.calls)).not.toContain("secret-response-content");
    monitor.observe("platform-a", "openai", "chat", 200);
    monitor.observe("platform-a", "openai", "chat", 200);
    await monitor.settled();
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1]?.[0]).toMatchObject({ status: "resolved", reason: "successful_upstream_response" });
    expect(emit).toHaveBeenCalledTimes(2);
  });
  it("retries failed delivery only after cooldown on new observed evidence", async () => {
    let now = 1000;
    const notify = vi.fn(async () => { throw new Error("failed"); });
    const monitor = new VendorBalanceMonitor(notify, vi.fn(), () => now);
    monitor.observe("p", "openai", "chat", 402);
    await monitor.settled();
    monitor.observe("p", "openai", "chat", 402);
    await monitor.settled();
    expect(notify).toHaveBeenCalledTimes(1);
    now += 60000;
    monitor.observe("p", "openai", "chat", 402);
    await monitor.settled();
    expect(notify).toHaveBeenCalledTimes(2);
    monitor.observe("p", "openai", "chat", 200);
    await monitor.settled();
    expect(notify).toHaveBeenCalledTimes(2); // No resolved notice for a warning never delivered.
  });
  it("retries a failed recovery after new success evidence and releases resolved slots", async () => {
    let now = 1000;
    let failRecovery = true;
    const notify = vi.fn(async (signal: { status: string }) => { if (signal.status === "resolved" && failRecovery) throw Error("temporary outage"); });
    const monitor = new VendorBalanceMonitor(notify, vi.fn(), () => now);
    monitor.observe("one", "openai", "chat", 402); await monitor.settled();
    monitor.observe("one", "openai", "chat", 200); await monitor.settled();
    monitor.observe("one", "openai", "chat", 200); await monitor.settled();
    expect(notify).toHaveBeenCalledTimes(2);
    now += 60000; failRecovery = false;
    monitor.observe("one", "openai", "chat", 200); await monitor.settled();
    expect(notify).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 40; i++) {
      monitor.observe(`scope-${i}`, "openai", "chat", 402); await monitor.settled();
      monitor.observe(`scope-${i}`, "openai", "chat", 200); await monitor.settled();
    }
    expect(notify).toHaveBeenCalledTimes(83);
  });
  it("serializes firing/recovery while notification delivery is pending", async () => {
    let release!: () => void;
    const first = new Promise<void>(resolve => { release = resolve; });
    const notify = vi.fn(async (_signal: { status: string }) => { if (notify.mock.calls.length === 1) await first; });
    const monitor = new VendorBalanceMonitor(notify, vi.fn(), () => 1000);
    monitor.observe("one", "openai", "chat", 402);
    monitor.observe("one", "openai", "chat", 200);
    release(); await monitor.settled();
    expect(notify.mock.calls.map(([signal]) => signal.status)).toEqual(["firing", "resolved"]);
  });
  it("expires abandoned scopes without sending invented recovery", async () => {
    let now = 0;
    const notify = vi.fn(async (_signal: { status: string }) => {});
    const monitor = new VendorBalanceMonitor(notify, vi.fn(), () => now);
    for (let i = 0; i < 32; i++) monitor.observe(`old-${i}`, "openai", "chat", 402);
    await monitor.settled();
    now = 24 * 3600000;
    monitor.observe("fresh", "openai", "chat", 402);
    await monitor.settled();
    expect(notify).toHaveBeenCalledTimes(33);
    expect(notify.mock.calls.every(([signal]) => signal.status === "firing")).toBe(true);
  });
  it("coalesces a later failure while the first warning is still delivering", async () => {
    let release!: () => void;
    const first = new Promise<void>(resolve => { release = resolve; });
    const notify = vi.fn(async (_signal: { status: string }) => { await first; });
    const monitor = new VendorBalanceMonitor(notify, vi.fn(), () => 1000);
    monitor.observe("one", "openai", "chat", 402);
    monitor.observe("one", "openai", "chat", 200);
    monitor.observe("one", "openai", "chat", 402);
    release(); await monitor.settled();
    expect(notify.mock.calls.map(([signal]) => signal.status)).toEqual(["firing"]);
  });
  it("parses split SSE error frames without interpreting assistant content as errors", () => {
    const frames = new VendorErrorFrames();
    expect(frames.push('da')).toEqual([]);
    expect(frames.push('ta: {"choices":[{"delta":{"content":"insufficient_quota"}}]}\n\ndata: {"err')).toEqual([]);
    expect(frames.push('or":{"code":402,"message":"Insufficient credits"}}\n\n')).toEqual(['{"error":{"code":402,"message":"Insufficient credits"}}']);
    expect(vendorBillingReason(200, '{"choices":[{"delta":{"content":"insufficient_quota"}}]}')).toBeNull();
    expect(vendorBillingReason(200, '{"error":{"code":"insufficient_quota"}}')).toBe("billing_quota_exhausted");
    const oversized = new VendorErrorFrames();
    expect(oversized.push('data: ' + 'x'.repeat(20000) + '\n\n')).toEqual([]);
    expect(oversized.uninspectable).toBe(true);
  });
  it("never leaks token URLs or provider error bodies when actual Telegram transport throws", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "secret-bot-token");
    vi.stubEnv("TELEGRAM_CHAT_ID", "qa-chat");
    vi.stubEnv("ALERT_TELEGRAM", "on");
    const transport = vi.fn(async () => { throw new Error("https://api.telegram.org/botsecret-bot-token/sendMessage"); });
    vi.stubGlobal("fetch", transport);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vendorBalanceMonitor.observe("test-transport", "openai", "chat", 402, "raw-secret-provider-response");
      await vendorBalanceMonitor.settled();
      expect(transport).toHaveBeenCalledOnce();
      const logs = JSON.stringify([...error.mock.calls, ...warn.mock.calls]);
      expect(logs).not.toContain("secret-bot-token");
      expect(logs).not.toContain("raw-secret-provider-response");
      expect(logs).toContain("telegram_delivery_failed=true");
    } finally {
      error.mockRestore(); warn.mockRestore(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
    }
  });

});

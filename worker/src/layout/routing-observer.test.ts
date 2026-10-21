import { createHash } from "node:crypto";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readLayoutObserverConfig, RoutingLayoutObserver, type RoutingLayoutObserverConfig } from "./routing-observer.js";

const env = {
  PAGE_ROUTER_LAYOUT: "shadow", PAGE_ROUTER_LAYOUT_ENDPOINT: "http://127.0.0.1:9876/layout",
  PAGE_ROUTER_LAYOUT_MODEL_ID: "detector", PAGE_ROUTER_LAYOUT_REVISION: "pinned",
  PAGE_ROUTER_LAYOUT_ARTIFACT_SHA256: "a".repeat(64), PAGE_ROUTER_LAYOUT_PROFILE_SHA256: "b".repeat(64),
};
const config = (overrides: Partial<RoutingLayoutObserverConfig> = {}) => ({ ...readLayoutObserverConfig(env)!, ...overrides });
const image = (background = "white") => sharp({ create: { width: 20, height: 10, channels: 3, background } }).png().toBuffer();
function response(payload: Uint8Array, overrides: Record<string, unknown> = {}): Response {
  return Response.json({ schemaVersion: 1, inferenceProfileSha256: "b".repeat(64), coordinateSpace: "normalized-source", model: { id: "detector", revision: "pinned", artifactSha256: "a".repeat(64) }, device: "cpu",
    image: { width: 20, height: 10, sha256: createHash("sha256").update(payload).digest("hex") }, supportedLabels: ["paragraph"],
    regions: [{ label: "paragraph", rawLabel: "text", confidence: 0.9, bbox: [0, 0, 1, 1] }], ...overrides });
}
function mockEndpoint(options: { delay?: number; overrides?: Record<string, unknown>; fail?: boolean } = {}) {
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    await new Promise<void>((resolve, reject) => {
      if (init.signal?.aborted) { reject(init.signal.reason); return; }
      const aborted = () => { clearTimeout(timer); reject(init.signal?.reason); };
      const timer = setTimeout(() => { init.signal?.removeEventListener("abort", aborted); resolve(); }, options.delay ?? 0);
      init.signal?.addEventListener("abort", aborted, { once: true });
    });
    return options.fail ? new Response("unavailable", { status: 503 }) : response(init.body as Uint8Array, options.overrides);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
afterEach(() => vi.unstubAllGlobals());

describe("layout observer configuration", () => {
  it("is disabled by default and keeps unknown pricing unknown", () => {
    expect(readLayoutObserverConfig({})).toBeNull();
    expect(config()).toMatchObject({ timeoutMs: 2000, maxPages: 4, concurrency: 1, queueCapacity: 8, queueMaxBytes: 64 * 1024 * 1024, auditPages: 1, hourlyCostUsd: null });
    expect(readLayoutObserverConfig({ ...env, PAGE_ROUTER_LAYOUT_HOURLY_COST_USD: "0.39" })?.hourlyCostUsd).toBe(0.39);
  });
  it.each([
    { PAGE_ROUTER_LAYOUT: "on" }, { PAGE_ROUTER_LAYOUT_ENDPOINT: "https://example.com/layout" },
    { PAGE_ROUTER_LAYOUT_ENDPOINT: "http://localhost/layout" }, { PAGE_ROUTER_LAYOUT_ENDPOINT: "http://127.0.0.1/layout?x=1" },
    { PAGE_ROUTER_LAYOUT_ARTIFACT_SHA256: "" }, { PAGE_ROUTER_LAYOUT_REVISION: "" }, { PAGE_ROUTER_LAYOUT_PROFILE_SHA256: "" },
    { PAGE_ROUTER_LAYOUT_MAX_BYTES: "26214401" }, { PAGE_ROUTER_LAYOUT_CONCURRENCY: "0" },
    { PAGE_ROUTER_LAYOUT_TIMEOUT_MS: "NaN" }, { PAGE_ROUTER_LAYOUT_DEVICE: "auto" },
    { PAGE_ROUTER_LAYOUT_HOURLY_COST_USD: "" }, { PAGE_ROUTER_LAYOUT_HOURLY_COST_USD: "0" },
    { PAGE_ROUTER_LAYOUT_QUEUE_MAX_BYTES: "0" }, { PAGE_ROUTER_LAYOUT_AUDIT_PAGES: "17" },
  ])("rejects unsafe enabled configuration %j", (override) => {
    expect(() => readLayoutObserverConfig({ ...env, ...override })).toThrow();
  });
});

describe("bounded routing layout observer", () => {
  it("reuses completed observations by exact payload and tenant, preserving independent result ownership", async () => {
    const fetcher = mockEndpoint();
    const observer = new RoutingLayoutObserver(config());
    const payload = await image();
    const first = await observer.observe({ scopeKey: "org-a/workspace-a", payload });
    first.result.regions.length = 0;
    const second = await observer.observe({ scopeKey: "org-a/workspace-a", payload });
    expect(first.inferencePerformed).toBe(true);
    expect(second.inferencePerformed).toBe(false);
    expect(second.inferenceKey).toBe(first.inferenceKey);
    expect(second.cacheHit).toBe(true);
    expect(second.result.regions).toHaveLength(1);
    expect(second.inputBytes).toBe(payload.byteLength);
    expect(second.elapsedMs).toBeGreaterThanOrEqual(0);
    await observer.observe({ scopeKey: "org-b/workspace-a", payload });
    await observer.observe({ scopeKey: "org-a/workspace-a", payload: await image("black") });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("freezes configuration so later caller mutation cannot alter cache identity", async () => {
    const fetcher = mockEndpoint();
    const settings = config();
    const observer = new RoutingLayoutObserver(settings);
    settings.expectedRevision = "mutated";
    await observer.observe({ scopeKey: "tenant", payload: await image() });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    { model: { id: "other", revision: "pinned", artifactSha256: "a".repeat(64) } },
    { model: { id: "detector", revision: "other", artifactSha256: "a".repeat(64) } },
    { model: { id: "detector", revision: "pinned", artifactSha256: "b".repeat(64) } },
    { inferenceProfileSha256: "c".repeat(64) }, { inferenceProfileSha256: undefined },
    { device: "cuda" }, { image: { width: 20, height: 10, sha256: "b".repeat(64) } },
  ])("rejects endpoint identity mismatch without caching %j", async (overrides) => {
    const fetcher = mockEndpoint({ overrides });
    const observer = new RoutingLayoutObserver(config());
    const request = { scopeKey: "tenant", payload: await image() };
    await expect(observer.observe(request)).rejects.toThrow();
    await expect(observer.observe(request)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("does not cache transport failures", async () => {
    const fetcher = mockEndpoint({ fail: true });
    const observer = new RoutingLayoutObserver(config());
    const request = { scopeKey: "tenant", payload: await image() };
    await expect(observer.observe(request)).rejects.toThrow("503");
    await expect(observer.observe(request)).rejects.toThrow("503");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("single-flights identical concurrent work and isolates cancellation of the first caller", async () => {
    const fetcher = mockEndpoint({ delay: 30 });
    const observer = new RoutingLayoutObserver(config());
    const request = { scopeKey: "tenant", payload: await image() };
    const controller = new AbortController();
    const first = observer.observe({ ...request, signal: controller.signal });
    const second = observer.observe(request);
    controller.abort(new Error("caller left"));
    await expect(first).rejects.toThrow("caller left");
    expect(await second).toMatchObject({ cacheHit: false, inferencePerformed: false });
    expect(fetcher).toHaveBeenCalledOnce();
    expect((await observer.observe(request)).cacheHit).toBe(true);
  });
  it("bounds active concurrency and queue capacity", async () => {
    const fetcher = mockEndpoint({ delay: 30 });
    const observer = new RoutingLayoutObserver(config({ concurrency: 1, queueCapacity: 1 }));
    const payload = await image();
    const first = observer.observe({ scopeKey: "a", payload });
    const second = observer.observe({ scopeKey: "b", payload });
    await expect(observer.observe({ scopeKey: "c", payload })).rejects.toThrow("queue is full");
    await Promise.all([first, second]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("bounds total held payload bytes and reports capacity before callers render", async () => {
    const fetcher = mockEndpoint({ delay: 30 });
    const payload = await image();
    const observer = new RoutingLayoutObserver(config({ concurrency: 1, queueCapacity: 8, queueMaxBytes: payload.byteLength * 2 }));
    expect(observer.hasCapacity(payload.byteLength)).toBe(true);
    const first = observer.observe({ scopeKey: "a", payload });
    const second = observer.observe({ scopeKey: "b", payload });
    expect(observer.hasCapacity(1)).toBe(false);
    await expect(observer.observe({ scopeKey: "c", payload })).rejects.toThrow("byte budget");
    await Promise.all([first, second]);
    expect(observer.hasCapacity(payload.byteLength * 2)).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("releases held bytes when queued work is cancelled before dispatch", async () => {
    mockEndpoint({ delay: 30 });
    const payload = await image();
    const observer = new RoutingLayoutObserver(config({ concurrency: 1, queueMaxBytes: payload.byteLength * 2 }));
    const first = observer.observe({ scopeKey: "a", payload });
    const controller = new AbortController();
    const queued = observer.observe({ scopeKey: "b", payload, signal: controller.signal });
    controller.abort(new Error("left"));
    await expect(queued).rejects.toThrow("left");
    expect(observer.hasCapacity(payload.byteLength)).toBe(true);
    await first;
  });
  it("deadline includes time waiting in the queue and failed work can retry", async () => {
    const fetcher = mockEndpoint({ delay: 100 });
    const observer = new RoutingLayoutObserver(config({ timeoutMs: 20 }));
    const payload = await image();
    const outcomes = await Promise.allSettled([
      observer.observe({ scopeKey: "a", payload }), observer.observe({ scopeKey: "b", payload }),
    ]);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(2);
    mockEndpoint();
    expect((await observer.observe({ scopeKey: "a", payload })).cacheHit).toBe(false);
  });
  it("rejects cancelled and oversized inputs before calling the service", async () => {
    const fetcher = mockEndpoint();
    const observer = new RoutingLayoutObserver(config({ maxBytes: 5 }));
    await expect(observer.observe({ scopeKey: "a", payload: Buffer.alloc(6) })).rejects.toThrow("byte bounds");
    await expect(observer.observe({ scopeKey: "a", payload: Buffer.alloc(1), signal: AbortSignal.abort(new Error("cancelled")) })).rejects.toThrow("cancelled");
    await expect(observer.observe({ scopeKey: "", payload: Buffer.alloc(1) })).rejects.toThrow("scope");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("records each actual HTTP attempt once, including failures, and excludes joins and hits", async () => {
    mockEndpoint({ delay: 20 });
    const observer = new RoutingLayoutObserver(config());
    const payload = await image();
    const creatorHook = vi.fn();
    const joinHook = vi.fn();
    const [first, second] = await Promise.all([
      observer.observe({ scopeKey: "a", payload, onRequest: creatorHook }),
      observer.observe({ scopeKey: "a", payload, onRequest: joinHook }),
    ]);
    expect(creatorHook).toHaveBeenCalledExactlyOnceWith({ inferenceKey: first.inferenceKey, inputBytes: payload.byteLength });
    expect(second.inferenceKey).toBe(first.inferenceKey);
    expect(joinHook).not.toHaveBeenCalled();
    await observer.observe({ scopeKey: "a", payload, onRequest: joinHook });
    expect(joinHook).not.toHaveBeenCalled();
    mockEndpoint({ fail: true });
    await expect(observer.observe({ scopeKey: "b", payload, onRequest: joinHook })).rejects.toThrow("503");
    expect(joinHook).toHaveBeenCalledOnce();
  });
  it("does not record invalid-image or cancelled queued requests as HTTP attempts", async () => {
    mockEndpoint({ delay: 30 });
    const observer = new RoutingLayoutObserver(config());
    const hook = vi.fn();
    await expect(observer.observe({ scopeKey: "invalid", payload: Buffer.from("not an image"), onRequest: hook })).rejects.toThrow();
    expect(hook).not.toHaveBeenCalled();
    const payload = await image();
    const first = observer.observe({ scopeKey: "a", payload });
    const controller = new AbortController();
    const queued = observer.observe({ scopeKey: "b", payload, signal: controller.signal, onRequest: hook });
    controller.abort(new Error("cancel queued"));
    await expect(queued).rejects.toThrow("cancel queued");
    await first;
    expect(hook).not.toHaveBeenCalled();
  });
  it("transfers queued dispatch accounting to a surviving caller when its creator cancels", async () => {
    const fetcher = mockEndpoint({ delay: 30 });
    const observer = new RoutingLayoutObserver(config());
    const payload = await image();
    const blocker = observer.observe({ scopeKey: "blocker", payload });
    const controller = new AbortController();
    const cancelledHook = vi.fn();
    const survivorHook = vi.fn();
    const creator = observer.observe({ scopeKey: "shared", payload, signal: controller.signal, onRequest: cancelledHook });
    const survivor = observer.observe({ scopeKey: "shared", payload, onRequest: survivorHook });
    controller.abort(new Error("creator cancelled"));
    await expect(creator).rejects.toThrow("creator cancelled");
    const [, result] = await Promise.all([blocker, survivor]);
    expect(cancelledHook).not.toHaveBeenCalled();
    expect(survivorHook).toHaveBeenCalledExactlyOnceWith({ inferenceKey: result.inferenceKey, inputBytes: payload.byteLength });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("prevents HTTP dispatch when accounting callback throws", async () => {
    const fetcher = mockEndpoint();
    const observer = new RoutingLayoutObserver(config());
    await expect(observer.observe({ scopeKey: "a", payload: await image(), onRequest: () => { throw new Error("accounting unavailable"); } })).rejects.toThrow("accounting unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("bounds serialized result cache bytes independently of entry count", async () => {
    mockEndpoint({ overrides: { diagnostics: { padding: "x".repeat(9 * 1024 * 1024) } } });
    const observer = new RoutingLayoutObserver(config());
    const payload = await image();
    await observer.observe({ scopeKey: "a", payload });
    await observer.observe({ scopeKey: "b", payload });
    expect((await observer.observe({ scopeKey: "b", payload })).cacheHit).toBe(true);
    expect((await observer.observe({ scopeKey: "a", payload })).cacheHit).toBe(false);
  });
  it("evicts least recently used entries after 64 observations", async () => {
    const fetcher = mockEndpoint();
    const observer = new RoutingLayoutObserver(config());
    const payload = await image();
    for (let index = 0; index < 64; index++) await observer.observe({ scopeKey: String(index), payload });
    expect((await observer.observe({ scopeKey: "0", payload })).cacheHit).toBe(true);
    await observer.observe({ scopeKey: "64", payload });
    expect((await observer.observe({ scopeKey: "0", payload })).cacheHit).toBe(true);
    expect((await observer.observe({ scopeKey: "1", payload })).cacheHit).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(66);
  });
});

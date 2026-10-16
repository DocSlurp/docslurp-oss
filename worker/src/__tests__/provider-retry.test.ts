import { ApplicationFailure } from "@temporalio/common";
import { describe, expect, it } from "vitest";

import {
  ProviderConcurrencyLimiter,
  ProviderRetryableError,
  backoffDelayMs,
  fetchWithProviderRetry,
  findProviderRetryableError,
  parseRetryAfterMs,
  providerFromBaseUrl,
  toProviderRetryableError,
} from "../lib/provider-retry.js";
import { shouldFailOpenVisionError } from "../stages/vision-extract.js";
import { toActivityFailure } from "../temporal/activities.js";
import { PROVIDER_RATE_LIMITED } from "../temporal/shared.js";
import { resolveActivityConcurrency } from "../concurrency.js";
import { perSlotShare, resolveWorkerDeploymentProfile } from "../pipeline/local-compute-cost.js";

const response = (status: number, body = "", headers: Record<string, string> = {}) => new Response(body, { status, headers });

function scripted(responses: Array<Response | Error>) {
  const calls: number[] = [];
  const fetchImpl = (async () => {
    calls.push(Date.now());
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("parseRetryAfterMs", () => {
  it("reads retry-after-ms, delta seconds and HTTP dates", () => {
    expect(parseRetryAfterMs(new Headers({ "retry-after-ms": "1500" }))).toBe(1500);
    expect(parseRetryAfterMs(new Headers({ "retry-after": "7" }))).toBe(7000);
    const now = Date.parse("2026-10-09T00:00:00Z");
    expect(parseRetryAfterMs({ "Retry-After": "Fri, 09 Oct 2026 00:00:30 GMT" }, now)).toBe(30_000);
    expect(parseRetryAfterMs(new Headers())).toBeNull();
  });
});

describe("backoffDelayMs", () => {
  it("is full-jitter exponential with a floor and a ceiling", () => {
    expect(backoffDelayMs(0, () => 0)).toBe(250);
    expect(backoffDelayMs(3, () => 1)).toBe(8_000);
    expect(backoffDelayMs(20, () => 1)).toBe(30_000);
  });
});

describe("fetchWithProviderRetry", () => {
  it("retries 429/5xx honouring Retry-After, then succeeds", async () => {
    const { fetchImpl, calls } = scripted([response(429, "slow down", { "retry-after": "2" }), response(503), response(200, "ok")]);
    const sleeps: number[] = [];
    const result = await fetchWithProviderRetry("https://x", { method: "POST" }, {
      provider: "openai", label: "vision request", fetchImpl, random: () => 0, sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(await result.text()).toBe("ok");
    expect(calls).toHaveLength(3);
    expect(sleeps).toEqual([2_000, 250]); // Retry-After, then the jitter floor
  });

  it("throws a retryable error once retries are exhausted", async () => {
    const { fetchImpl } = scripted([response(429), response(429), response(429, "", { "retry-after": "9" })]);
    const error = await fetchWithProviderRetry("https://x", {}, {
      provider: "openrouter", label: "vision request", fetchImpl, maxRetries: 2, random: () => 0, sleep: async () => {},
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderRetryableError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 9_000, attempts: 3, provider: "openrouter" });
  });

  it("hands long Retry-After waits to Temporal instead of sleeping", async () => {
    const { fetchImpl, calls } = scripted([response(429, "", { "retry-after": "300" })]);
    const error = await fetchWithProviderRetry("https://x", {}, {
      provider: "openai", label: "vision request", fetchImpl, sleep: async () => {},
    }).catch((e: unknown) => e);
    expect(calls).toHaveLength(1);
    expect(error).toMatchObject({ retryAfterMs: 300_000 });
  });

  it("retries network errors but not quota exhaustion or 4xx", async () => {
    const network = scripted([new TypeError("fetch failed"), response(200, "ok")]);
    expect((await fetchWithProviderRetry("https://x", {}, { provider: "p", label: "l", fetchImpl: network.fetchImpl, sleep: async () => {} })).status).toBe(200);
    const quota = scripted([response(429, '{"error":{"code":"insufficient_quota"}}')]);
    const quotaResponse = await fetchWithProviderRetry("https://x", {}, { provider: "p", label: "l", fetchImpl: quota.fetchImpl, sleep: async () => {} });
    expect(quotaResponse.status).toBe(429);
    expect(quota.calls).toHaveLength(1);
    const bad = scripted([response(400, "bad")]);
    expect((await fetchWithProviderRetry("https://x", {}, { provider: "p", label: "l", fetchImpl: bad.fetchImpl })).status).toBe(400);
  });
});

describe("ProviderConcurrencyLimiter", () => {
  it("caps in-flight calls per provider", async () => {
    const limiter = new ProviderConcurrencyLimiter((provider) => (provider === "a" ? 2 : 1));
    let active = 0;
    let peak = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
    };
    await Promise.all(Array.from({ length: 7 }, () => limiter.run("a", task)));
    expect(peak).toBe(2);
    expect(limiter.inFlight("a")).toBe(0);
  });

  it("drops aborted waiters", async () => {
    const limiter = new ProviderConcurrencyLimiter(() => 1);
    let release!: () => void;
    const held = limiter.run("a", () => new Promise<void>((resolve) => { release = resolve; }));
    const controller = new AbortController();
    const waiting = limiter.run("a", async () => "never", controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    release();
    await held;
    expect(await limiter.run("a", async () => "next")).toBe("next");
  });
});

describe("throttling is not a silent page skip", () => {
  it("does not fail open on provider throttling, but still does on quota/auth", () => {
    const throttled = new ProviderRetryableError("vision request failed after 5 attempt(s): 429", "openai", 429, null, 5);
    expect(shouldFailOpenVisionError(throttled)).toBe(false);
    expect(shouldFailOpenVisionError(new Error("vision request failed: 429 rate limit"))).toBe(false);
    expect(shouldFailOpenVisionError(new Error('vision request failed: 429 {"code":"insufficient_quota"}'))).toBe(true);
    expect(shouldFailOpenVisionError(new Error("vision request failed: 401 invalid_api_key"))).toBe(true);
  });

  it("stops ordinary stage failures at the ordinary attempt limit but keeps retrying throttling", () => {
    const plain = new Error("parse failed");
    expect(toActivityFailure(plain, 2, 3)).toBe(plain);
    const exhausted = toActivityFailure(plain, 3, 3) as ApplicationFailure;
    expect(exhausted).toBeInstanceOf(ApplicationFailure);
    expect(exhausted.nonRetryable).toBe(true);
    expect(exhausted.message).toBe("parse failed");

    const throttled = toActivityFailure(new Error("embed", { cause: new ProviderRetryableError("429", "openai", 429, 5_000, 5) }), 6, 3) as ApplicationFailure;
    expect(throttled.type).toBe("ProviderRateLimited");
    expect(throttled.nonRetryable).toBe(false);

    const retryable = ApplicationFailure.create({ type: "Transient", message: "x", nonRetryable: false });
    expect((toActivityFailure(retryable, 3, 3) as ApplicationFailure).nonRetryable).toBe(true);
    const fatal = ApplicationFailure.nonRetryable("fatal", "WorkerSlotUnavailable");
    expect(toActivityFailure(fatal, 5, 3)).toBe(fatal);
  });

  it("maps throttling to a retryable Temporal failure with nextRetryDelay", () => {
    const failure = toActivityFailure(new Error("wrapped", { cause: new ProviderRetryableError("429", "openai", 429, 20_000, 5) }));
    expect(failure).toMatchObject({ type: PROVIDER_RATE_LIMITED, nonRetryable: false, nextRetryDelay: 20_000 });
    const plain = new Error("parser crashed");
    expect(toActivityFailure(plain)).toBe(plain);
  });

  it("recognises AI SDK API errors", () => {
    const sdkError = Object.assign(new Error("Too Many Requests"), { statusCode: 429, responseHeaders: { "retry-after": "3" }, responseBody: "" });
    expect(toProviderRetryableError({ lastError: sdkError }, "openai", "embedding request")).toMatchObject({ status: 429, retryAfterMs: 3_000 });
    expect(toProviderRetryableError(Object.assign(new Error("quota"), { statusCode: 429, responseBody: "insufficient_quota" }), "openai", "e")).toBeNull();
    expect(findProviderRetryableError(new Error("x"))).toBeNull();
    expect(providerFromBaseUrl("https://openrouter.ai/api/v1")).toBe("openrouter");
  });
});

describe("per-slot compute allocation", () => {
  it("bills one slot's share of the machine, not the whole machine", () => {
    expect(perSlotShare("8", "8")).toBe(1);
    expect(perSlotShare("16", "8")).toBe(2);
    expect(perSlotShare(undefined, "8")).toBeNull();
    const profile = resolveWorkerDeploymentProfile({ DOCSLURP_MACHINE_VCPU: "8", DOCSLURP_MACHINE_MEMORY_GB: "16", WORKER_ACTIVITY_CONCURRENCY: "8" });
    expect(profile).toMatchObject({ allocatedVcpu: 1, allocatedMemoryGb: 2 });
    expect(resolveWorkerDeploymentProfile({ DOCSLURP_ALLOCATED_VCPU: "0.5", DOCSLURP_MACHINE_VCPU: "8", WORKER_ACTIVITY_CONCURRENCY: "8" }).allocatedVcpu).toBe(0.5);
  });

  it("divides by the same resolved slot count the worker runs when WORKER_ACTIVITY_CONCURRENCY is unset", () => {
    const machine = { DOCSLURP_MACHINE_VCPU: "8", DOCSLURP_MACHINE_MEMORY_GB: "16" };
    // Unset: the default is twice the CPU-derived document concurrency, not 1.
    const expectedSlots = resolveActivityConcurrency({});
    const unset = resolveWorkerDeploymentProfile(machine);
    expect(unset.allocatedVcpu).toBeCloseTo(8 / expectedSlots, 10);
    expect(unset.allocatedMemoryGb).toBeCloseTo(16 / expectedSlots, 10);
    // An explicit slot count (the worker's config value) wins.
    expect(resolveWorkerDeploymentProfile(machine, 4)).toMatchObject({ allocatedVcpu: 2, allocatedMemoryGb: 4 });
    expect(resolveWorkerDeploymentProfile({ ...machine, WORKER_ACTIVITY_CONCURRENCY: "8" })).toMatchObject({ allocatedVcpu: 1, allocatedMemoryGb: 2 });
    expect(perSlotShare("16", 4)).toBe(4);
  });
});

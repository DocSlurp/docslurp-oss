import { describe, expect, it, vi } from "vitest";
import { buildDecisionModelCatalog, type DecisionModel, type PolicyPack } from "@docslurp/shared";

import {
  DecisionRequestError,
  PAGE_ROUTE_DECISION_CANARY_METRIC,
  type DecisionAnswer,
  type DecisionCallResult,
  type DecisionClient,
  type DecisionQuestion,
} from "../decision-client.js";
import { BaselineRouter } from "../routers/baseline.js";
import { loadRuntimePolicyPack } from "../runtime.js";
import { BIG_BUDGET, makePage, testCatalog, testPack } from "../testing.js";
import { CANARY_QUESTIONS, CANARY_STATE, judgeCanary, runCanary } from "./canary.js";
import { DecisionModelChainRouter, packHasCalibrations } from "./chain.js";
import { DecisionDegenerateError, detectDegenerate } from "./degenerate.js";
import { DecisionModelHealthRegistry, DecisionModelUnhealthyError } from "./registry.js";

const models = buildDecisionModelCatalog({
  env: { OPENROUTER_API_KEY: true, PERPLEXITYAI_API_KEY: true },
}).models;
const byId = (id: string) => models.find((m) => m.id === id)!;
const CHAIN = ["cloudflare/clef-flash", "openai/gpt-6-luna-decisions", "typesafe/jev-1.13", "perplexity/pplx-decider-v1.1-27b"];

/** The fitted pack with the clef-flash calibrations copied to every chain model. */
function calibratedPack(ids = CHAIN): PolicyPack {
  const fitted = loadRuntimePolicyPack("decision-model");
  const clef = fitted.calibrations.filter((c) => c.decisionModel === "cloudflare/clef-flash");
  return {
    ...fitted,
    decisionModels: ids,
    calibrations: ids.flatMap((id) => clef.map((c) => ({ ...c, decisionModel: id }))),
  };
}

const healthyCanary = (): Record<string, DecisionAnswer> => ({
  has_math: { type: "noul", noul: 0.96 },
  mentions_cat: { type: "noul", noul: 0.01 },
  subject: { type: "choice", choice: "mathematics", confidence: 0.93, probabilities: { mathematics: 0.93, animals: 0.04, cooking: 0.03 } },
});

const constantAnswers = (q: Record<string, DecisionQuestion>, p = 0.29637396196437554): Record<string, DecisionAnswer> =>
  Object.fromEntries(Object.entries(q).map(([k, qq]) => [
    k,
    qq.type === "noul"
      ? ({ type: "noul", noul: p } as DecisionAnswer)
      : ({ type: "choice", choice: Object.keys(qq.criteria)[0]!, confidence: 0.33, probabilities: Object.fromEntries(Object.keys(qq.criteria).map((c) => [c, 0.33])) } as DecisionAnswer),
  ]));

const healthyTriage = (q: Record<string, DecisionQuestion>): Record<string, DecisionAnswer> =>
  Object.fromEntries(Object.entries(q).map(([k, qq], i) => [
    k,
    qq.type === "noul"
      ? ({ type: "noul", noul: k.endsWith("trust_text_layer") ? 0.92 : 0.05 + (i % 6) * 0.1 } as DecisionAnswer)
      : ({ type: "choice", choice: "chart-graph", confidence: 0.9, probabilities: { "chart-graph": 0.9, none: 0.1 } } as DecisionAnswer),
  ]));

type Behavior = (model: DecisionModel, q: Record<string, DecisionQuestion>, isCanary: boolean) => Record<string, DecisionAnswer> | Error;

/** Fake client: records every request and the usage events the real client would emit. */
function fakeClient(behavior: Behavior) {
  const requests: Array<{ model: string; canary: boolean }> = [];
  const usage: Array<{ model: string; canary: boolean }> = [];
  const client: DecisionClient = {
    async ask(model, _state, questions) {
      const canary = "mentions_cat" in questions;
      requests.push({ model: model.id, canary });
      const out = behavior(model, questions, canary);
      if (out instanceof Error) throw out;
      usage.push({ model: model.id, canary });
      const result: DecisionCallResult = {
        answers: out, usage: { inputTokens: 100, outputTokens: 0 }, latencyMs: 2, costCents: 0.0004, model: model.id, provider: "fake",
      };
      return result;
    },
  };
  return { client, requests, usage };
}

const chart = makePage({ pageNumber: 1, words: 60, images: [{ coverage: 0.4 }] });
const pages = [chart, makePage({ pageNumber: 2, words: 40, textLayer: "suspect" })];

function chain(
  behavior: Behavior,
  opts: { ids?: string[]; health?: DecisionModelHealthRegistry; pack?: PolicyPack } = {},
) {
  const triageFake = fakeClient(behavior);
  const canaryFake = fakeClient(behavior);
  const health = opts.health ?? new DecisionModelHealthRegistry();
  const pack = opts.pack ?? calibratedPack();
  const router = new DecisionModelChainRouter({
    pack,
    models: (opts.ids ?? CHAIN).map((id) => ({ model: byId(id), client: triageFake.client, triageOptions: { format: "text-state" as const } })),
    health,
    canaryClient: canaryFake.client,
    baseline: (carry) => new BaselineRouter({ pack: testPack(), carry }),
    documentId: "doc",
    runId: "run",
  });
  return { router, triageFake, canaryFake, health };
}

const plan = (r: DecisionModelChainRouter) => r.plan(pages, testCatalog(), BIG_BUDGET, "cost-quality");
const behaves = (healthy: Behavior = (_m, q, c) => (c ? healthyCanary() : healthyTriage(q))): Behavior => healthy;

describe("detectDegenerate", () => {
  it("flags identical answers for distinct questions (the observed failure) and all-0.5", () => {
    expect(detectDegenerate(Array(10).fill(0.29637396196437554))?.kind).toBe("constant");
    expect(detectDegenerate([0.5, 0.5, 0.49, 0.51, 0.5, 0.5, 0.5])?.kind).toBe("all-half");
  });
  it("passes varied answers and ignores too-few answers", () => {
    expect(detectDegenerate([0.9, 0.1, 0.05, 0.7, 0.02, 0.95, 0.3])).toBeNull();
    expect(detectDegenerate([0.3, 0.3, 0.3])).toBeNull();
  });
});

describe("judgeCanary / runCanary", () => {
  it("is healthy when has_math separates from mentions_cat and the choice is mathematics", () => {
    expect(judgeCanary(healthyCanary()).healthy).toBe(true);
  });
  it("rejects the observed constant 0.29637 answers", () => {
    const verdict = judgeCanary(constantAnswers(CANARY_QUESTIONS));
    expect(verdict.healthy).toBe(false);
    expect(verdict.reason).toMatch(/degenerate/);
  });
  it("rejects all-0.5, inverted direction, wrong choice and missing answers", () => {
    expect(judgeCanary({ ...healthyCanary(), has_math: { type: "noul", noul: 0.5 }, mentions_cat: { type: "noul", noul: 0.5 } }).healthy).toBe(false);
    expect(judgeCanary({ ...healthyCanary(), has_math: { type: "noul", noul: 0.05 }, mentions_cat: { type: "noul", noul: 0.9 } }).healthy).toBe(false);
    expect(judgeCanary({ ...healthyCanary(), subject: { type: "choice", choice: "cooking", confidence: 0.8, probabilities: { cooking: 0.8 } } }).healthy).toBe(false);
    expect(judgeCanary({}).healthy).toBe(false);
  });
  it("sends a fixed text-only state and reports tokens and cost", async () => {
    const fake = fakeClient(() => healthyCanary());
    const ask = vi.spyOn(fake.client, "ask");
    const result = await runCanary(fake.client, byId("cloudflare/clef-flash"));
    expect(result).toMatchObject({ healthy: true, modelId: "cloudflare/clef-flash", inputTokens: 100 });
    expect(ask.mock.calls[0]![1]).toBe(CANARY_STATE);
    expect(typeof ask.mock.calls[0]![1]).toBe("string");
  });
});

describe("DecisionModelHealthRegistry", () => {
  const model = byId("cloudflare/clef-flash");
  const good = async () => judgeCanaryResult(true);
  const bad = async () => judgeCanaryResult(false);
  function judgeCanaryResult(healthy: boolean) {
    return { healthy, reason: healthy ? "ok" : "bad", noul: { healthy, reason: healthy ? "ok" : "bad" }, choice: { healthy, reason: healthy ? "ok" : "bad" }, reading: { hasMath: null, mentionsCat: null, subject: null, subjectProbability: null, subjectMargin: null }, modelId: model.id, latencyMs: 1, inputTokens: 1, costCents: 0 };
  }

  it("caches a healthy result for the TTL, then re-probes", async () => {
    let t = 0;
    const reg = new DecisionModelHealthRegistry({ ttlMs: 600_000, now: () => t });
    const probe = vi.fn(good);
    await reg.ensureHealthy(model, probe);
    t = 599_000;
    await reg.ensureHealthy(model, probe);
    expect(probe).toHaveBeenCalledTimes(1);
    t = 601_000;
    await reg.ensureHealthy(model, probe);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("backs off after a failure (cached, no probe), doubles on repeats, then half-opens", async () => {
    let t = 0;
    const reg = new DecisionModelHealthRegistry({ backoffMs: 1000, maxBackoffMs: 3000, now: () => t });
    const probe = vi.fn(bad);
    await expect(reg.ensureHealthy(model, probe)).rejects.toBeInstanceOf(DecisionModelUnhealthyError);
    t = 999;
    await expect(reg.ensureHealthy(model, probe)).rejects.toMatchObject({ cached: true });
    expect(probe).toHaveBeenCalledTimes(1);
    t = 1001;
    await expect(reg.ensureHealthy(model, probe)).rejects.toBeInstanceOf(DecisionModelUnhealthyError);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(reg.status(model.id)!.until - t).toBe(2000); // doubled
    t += 2001;
    await reg.ensureHealthy(model, good);
    expect(reg.status(model.id)).toMatchObject({ healthy: true, consecutiveFailures: 0 });
  });

  it("treats a throwing probe (timeout / 5xx) as unhealthy and shares one in-flight probe", async () => {
    const reg = new DecisionModelHealthRegistry();
    const probe = vi.fn(async () => { throw new Error("timeout"); });
    const results = await Promise.allSettled([reg.ensureHealthy(model, probe), reg.ensureHealthy(model, probe)]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(reg.status(model.id)!.reason).toMatch(/canary failed: timeout/);
  });
});

describe("DecisionModelChainRouter", () => {
  it("uses the first model when healthy and records canary + triage usage separately", async () => {
    const { router, triageFake, canaryFake } = chain(behaves());
    const p = await plan(router);
    expect(p.routerKind).toBe("decision-model");
    expect(p.triage).toMatchObject({ ran: true, decisionModel: "cloudflare/clef-flash" });
    expect(router.servedBy).toBe("cloudflare/clef-flash");
    expect(router.trace).toEqual([{ model: "cloudflare/clef-flash", outcome: "served", reason: "primary" }]);
    expect(canaryFake.requests).toEqual([{ model: "cloudflare/clef-flash", canary: true }]);
    expect(triageFake.requests.every((r) => !r.canary && r.model === "cloudflare/clef-flash")).toBe(true);
    expect(PAGE_ROUTE_DECISION_CANARY_METRIC).toBe("page-route-decision-canary");
  });

  it("falls to the next model when the first is degenerate (constant 0.29637) and orders attempts by the chain", async () => {
    const { router, canaryFake } = chain(behaves((m, q, c) =>
      m.id === "cloudflare/clef-flash" ? constantAnswers(q) : c ? healthyCanary() : healthyTriage(q)));
    const p = await plan(router);
    expect(p.triage.decisionModel).toBe("openai/gpt-6-luna-decisions");
    expect(router.trace.map((t) => `${t.model}:${t.outcome}`)).toEqual([
      "cloudflare/clef-flash:failed",
      "openai/gpt-6-luna-decisions:served",
    ]);
    expect(router.trace[0]!.reason).toMatch(/degenerate/);
    expect(canaryFake.requests.map((r) => r.model)).toEqual(["cloudflare/clef-flash", "openai/gpt-6-luna-decisions"]);
    expect(router.trace[1]!.reason).toMatch(/fallback after cloudflare\/clef-flash failed/);
  });

  it("discards runtime-degenerate triage answers from a model whose canary passed, keeps the billed calls, and falls through", async () => {
    const { router, health } = chain(behaves((m, q, c) =>
      c ? healthyCanary() : m.id === "cloudflare/clef-flash" ? constantAnswers(q, 0.5) : healthyTriage(q)));
    const p = await plan(router);
    expect(p.triage.decisionModel).toBe("openai/gpt-6-luna-decisions");
    expect(router.trace[0]).toMatchObject({ model: "cloudflare/clef-flash", outcome: "failed" });
    expect(router.trace[0]!.reason).toMatch(/degenerate/);
    expect(health.status("cloudflare/clef-flash")!.healthy).toBe(false);
    const clefCalls = p.decisionModelCalls.filter((c) => c.model === "cloudflare/clef-flash");
    expect(clefCalls.length).toBeGreaterThan(0); // billed even though discarded
    expect(p.decisionModelCalls.some((c) => c.model === "openai/gpt-6-luna-decisions")).toBe(true);
    expect(p.triage.costUsd).toBeCloseTo(p.decisionModelCalls.reduce((a, c) => a + c.costUsd, 0));
  });

  it("falls through on timeout and 5xx, but not into models without calibrations", async () => {
    const { router, triageFake } = chain(
      behaves((m, q, c) =>
        m.id === "cloudflare/clef-flash" ? new DecisionRequestError("503", 503)
        : m.id === "openai/gpt-6-luna-decisions" ? new Error("The operation was aborted due to timeout")
        : c ? healthyCanary() : healthyTriage(q)),
      { pack: calibratedPack(["cloudflare/clef-flash", "openai/gpt-6-luna-decisions", "perplexity/pplx-decider-v1.1-27b"]) },
    );
    const p = await plan(router);
    // jev has no calibrations in this pack: skipped, never called; pplx serves.
    expect(p.triage.decisionModel).toBe("perplexity/pplx-decider-v1.1-27b");
    expect(router.trace.map((t) => `${t.model}:${t.outcome}`)).toEqual([
      "cloudflare/clef-flash:failed",
      "openai/gpt-6-luna-decisions:failed",
      "typesafe/jev-1.13:skipped",
      "perplexity/pplx-decider-v1.1-27b:served",
    ]);
    expect(router.trace[2]!.reason).toMatch(/no calibrations/);
    expect(triageFake.requests.some((r) => r.model === "typesafe/jev-1.13")).toBe(false);
  });

  it("uses the no-model baseline router (never a generative LLM) when no model qualifies, with the reasons in the plan", async () => {
    const { router } = chain(behaves((_m, q) => constantAnswers(q)));
    const p = await plan(router);
    expect(p.routerKind).toBe("baseline");
    expect(p.triage.ran).toBe(false);
    expect(p.triage.skippedReason).toMatch(/^decision-chain-exhausted: /);
    for (const id of CHAIN) expect(p.triage.skippedReason).toContain(id);
    expect(router.servedBy).toBeNull();
  });

  it("serves from the real fitted pack: only clef-flash is calibrated, so other models are skipped", async () => {
    const fitted = loadRuntimePolicyPack("decision-model");
    expect(packHasCalibrations(fitted, "cloudflare/clef-flash")).toBe(true);
    expect(packHasCalibrations(fitted, "perplexity/pplx-decider-v1.1-27b")).toBe(false);
    const { router } = chain(behaves((m, q, c) => (c ? healthyCanary() : healthyTriage(q))), { pack: fitted });
    await plan(router);
    expect(router.trace.map((t) => `${t.model}:${t.outcome}`)).toEqual(["cloudflare/clef-flash:served"]);
  });

  it("does not canary or call anything when triage is not needed", async () => {
    const { router, canaryFake } = chain(behaves());
    const p = await router.plan([makePage({ pageNumber: 1, words: 500 })], testCatalog(), BIG_BUDGET, "cost-quality");
    expect(p.triage.ran).toBe(false);
    expect(canaryFake.requests).toEqual([]);
    expect(router.servedBy).toBeNull();
  });

  it("a model marked unhealthy is skipped from cache (no new canary) until the backoff ends", async () => {
    let t = 0;
    const health = new DecisionModelHealthRegistry({ backoffMs: 60_000, now: () => t });
    health.markUnhealthy("cloudflare/clef-flash", "earlier degenerate");
    const { router, canaryFake } = chain(behaves(), { health });
    const p = await plan(router);
    expect(p.triage.decisionModel).toBe("openai/gpt-6-luna-decisions");
    expect(router.trace[0]).toMatchObject({ outcome: "failed", reason: expect.stringContaining("(cached)") });
    expect(canaryFake.requests.map((r) => r.model)).toEqual(["openai/gpt-6-luna-decisions"]);
    t = 61_000;
    const again = await plan(router);
    expect(again.triage.decisionModel).toBe("cloudflare/clef-flash");
  });
});

describe("DecisionDegenerateError", () => {
  it("names the model and the observed spread", () => {
    const verdict = detectDegenerate(Array(8).fill(0.3))!;
    expect(new DecisionDegenerateError("m", verdict).message).toMatch(/m degenerate: 8 distinct questions answered identically/);
  });
});

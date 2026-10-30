import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivacyModeViolationError } from "@docslurp/shared";

import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import {
  DecisionRequestError,
  DecisionUnavailableError,
  LIQUID_SYSTEMONE_URL,
  OPENROUTER_SYSTEMONE_URL,
  PERPLEXITY_DECISIONS_URL,
  createDecisionClient,
  decisionCostCents,
  imageDataUrlPart,
  parseDecisionResponse,
  recordDecisionUsage,
  wireModelId,
  type DecisionQuestion,
} from "./decision-client.js";
import { catalogModel } from "./routing-test-fixtures.js";
import { inAllowingRun } from "../test/provider-scope.js";
import { runWithProviderRateScope } from "../lib/provider-rate-limit.js";

const questions: Record<string, DecisionQuestion> = {
  p01_has_math: { type: "noul", instructions: "math?" },
  p01_image_kind: { type: "choice", criteria: { none: null, logo: "a logo" } },
};

function okBody(inputTokens = 1200) {
  return {
    model: "x",
    answers: {
      p01_has_math: { type: "noul", noul: 0.9 },
      p01_image_kind: { type: "choice", choice: "none", confidence: 0.8, probabilities: { none: 0.8, logo: 0.2 } },
    },
    usage: { input_tokens: inputTokens, output_tokens: 3 },
  };
}

function mockFetch(body: unknown = okBody(), status = 200) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

const env = { PERPLEXITYAI_API_KEY: "pk", OPENROUTER_API_KEY: "ok", LIQUID_API_KEY: "lk" } as NodeJS.ProcessEnv;
const retry = { maxRetries: 0 };

afterEach(() => vi.restoreAllMocks());

describe("decision client request shapes", () => {
  it("perplexity: bare model id, bearer key, image_url parts in a state array", async () => {
    const fetchImpl = mockFetch();
    const client = createDecisionClient({ privacyMode: "standard", env, fetchImpl, retry });
    const model = catalogModel("perplexity/pplx-decider-v1.1-27b");
    const state = ["Page P01:", imageDataUrlPart(Buffer.from("png"))];
    const result = await client.ask(model, state, questions);

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(PERPLEXITY_DECISIONS_URL);
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer pk");
    const body = JSON.parse(String(init!.body));
    expect(body.model).toBe("pplx-decider-v1.1-27b");
    expect(body.questions).toEqual(questions);
    expect(body.state[0]).toBe("Page P01:");
    expect(body.state[1]).toEqual({ type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from("png").toString("base64")}` } });
    expect(result.usage.inputTokens).toBe(1200);
    expect(result.costCents).toBeCloseTo((1200 / 1e6) * 0.02 * 100, 10);
    expect(result.answers.p01_has_math).toEqual({ type: "noul", noul: 0.9 });
  });

  it("openrouter systemone: namespaced model id, text only", async () => {
    const fetchImpl = mockFetch();
    const client = createDecisionClient({ privacyMode: "standard", env, fetchImpl, retry });
    const model = catalogModel("typesafe/jev-1.13");
    await inAllowingRun(() => client.ask(model, "P01: 412 words, 0 images, text layer ok", questions));
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(OPENROUTER_SYSTEMONE_URL);
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer ok");
    expect(JSON.parse(String(init!.body)).model).toBe("typesafe/jev-1.13");
    await expect(inAllowingRun(() => client.ask(model, ["x", imageDataUrlPart(Buffer.from("a"))], questions))).rejects.toThrow(/text-only/);
  });

  it("liquid systemone: direct endpoint, 8 image cap and 4.5 MB body cap", async () => {
    const fetchImpl = mockFetch();
    const client = createDecisionClient({ privacyMode: "standard", env, fetchImpl, retry });
    const model = catalogModel("liquid/d1:direct");
    expect(wireModelId(model)).toBe("liquid/d1");
    await inAllowingRun(() => client.ask(model, [imageDataUrlPart(Buffer.from("a"))], questions));
    expect(fetchImpl.mock.calls[0]![0]).toBe(LIQUID_SYSTEMONE_URL);

    const nine = Array.from({ length: 9 }, () => imageDataUrlPart(Buffer.from("a")));
    await expect(inAllowingRun(() => client.ask(model, nine, questions))).rejects.toThrow(/exceeds/);
    const big = [imageDataUrlPart(Buffer.alloc(3_500_000, 1))];
    await expect(inAllowingRun(() => client.ask(model, big, questions))).rejects.toThrow(/body .* exceeds/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses an upstream the China-provider policy does not allow, before sending anything", async () => {
    const fetchImpl = mockFetch();
    const client = createDecisionClient({ privacyMode: "standard", env, fetchImpl, retry });
    const restricted = <T>(fn: () => Promise<T>) => runWithProviderRateScope({ orgId: "org", allowChinaProviders: false }, fn);
    // Typesafe (via OpenRouter /systemone) and Liquid have no known region: refused when opted out, and outside any scope.
    for (const id of ["typesafe/jev-1.13", "liquid/d1:direct"]) {
      await expect(restricted(() => client.ask(catalogModel(id), "s", questions))).rejects.toBeInstanceOf(DecisionUnavailableError);
      await expect(client.ask(catalogModel(id), "s", questions)).rejects.toBeInstanceOf(DecisionUnavailableError);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
    // US-based upstreams still serve a restricted org.
    await restricted(() => client.ask(catalogModel("perplexity/pplx-decider-v1.1-27b"), "s", questions));
    await restricted(() => client.ask(catalogModel("cloudflare/clef-flash"), "s", questions));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

    it("rejects more questions than the model allows and empty question sets", async () => {
    const fetchImpl = mockFetch();
    const client = createDecisionClient({ privacyMode: "standard", env, fetchImpl, retry });
    const model = catalogModel("perplexity/pplx-decider-v1.1-27b");
    const many = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`q${i}`, { type: "noul" as const, instructions: "x" }]));
    await expect(client.ask(model, "s", many)).rejects.toThrow(/129 questions/);
    await expect(client.ask(model, "s", {})).rejects.toThrow(/at least one/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports missing keys as unavailable and HTTP errors with status", async () => {
    const model = catalogModel("perplexity/pplx-decider-v1.1-27b");
    const noKey = createDecisionClient({ privacyMode: "standard", env: {}, fetchImpl: mockFetch(), retry });
    await expect(noKey.ask(model, "s", questions)).rejects.toBeInstanceOf(DecisionUnavailableError);
    const failing = createDecisionClient({ privacyMode: "standard", env, fetchImpl: mockFetch({ error: "bad" }, 400), retry });
    await expect(failing.ask(model, "s", questions)).rejects.toMatchObject({ status: 400 });
  });
});

describe("privacy", () => {
  it.each(["local-only", "strict-privacy"])("blocks hosted decision calls in %s before any request", async (mode) => {
    const fetchImpl = mockFetch();
    const client = createDecisionClient({ privacyMode: mode, env, fetchImpl, retry });
    for (const id of ["perplexity/pplx-decider-v1.1-27b", "typesafe/jev-1.13", "liquid/d1:direct"]) {
      await expect(client.ask(catalogModel(id), "s", questions)).rejects.toBeInstanceOf(PrivacyModeViolationError);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("unknown privacy modes fail closed", async () => {
    const client = createDecisionClient({ privacyMode: "mystery", env, fetchImpl: mockFetch(), retry });
    await expect(client.ask(catalogModel("typesafe/jev-1.13"), "s", questions)).rejects.toBeInstanceOf(PrivacyModeViolationError);
  });

  it("local sidecar runs in local-only mode and is unavailable when unconfigured", async () => {
    const model = catalogModel("local/LiquidAI/d1-omni-600M");
    const runSidecar = vi.fn(async () => okBody(50));
    const client = createDecisionClient({
      privacyMode: "local-only",
      env: { DECISION_LOCAL_SIDECAR_CMD: '["python3","sidecar.py"]' } as NodeJS.ProcessEnv,
      runSidecar,
    });
    const result = await client.ask(model, "s", questions);
    expect(runSidecar).toHaveBeenCalledWith(["python3", "sidecar.py"], expect.objectContaining({ model: model.id }), undefined);
    expect(result.costCents).toBe(0);
    expect(result.provider).toBe("local");

    const bare = createDecisionClient({ privacyMode: "standard", env: {} });
    await expect(bare.ask(model, "s", questions)).rejects.toBeInstanceOf(DecisionUnavailableError);
  });
});

describe("response parsing", () => {
  it("rejects malformed answers and missing usage", () => {
    expect(() => parseDecisionResponse({ answers: { p01_has_math: { type: "noul", noul: 1.5 } }, usage: { input_tokens: 1 } }, questions)).toThrow(DecisionRequestError);
    expect(() => parseDecisionResponse({ answers: {} }, questions)).toThrow(/usage/);
    expect(() => parseDecisionResponse({}, questions)).toThrow(/answers/);
    expect(() => parseDecisionResponse({ answers: { p01_image_kind: { type: "choice", choice: "none" } }, usage: { input_tokens: 1 } }, questions)).toThrow(/malformed choice/);
  });

  it("leaves absent answers out for the caller to reject", () => {
    const parsed = parseDecisionResponse({ answers: { p01_has_math: { type: "noul", noul: 0.5 } }, usage: { input_tokens: 7 } }, questions);
    expect(Object.keys(parsed.answers)).toEqual(["p01_has_math"]);
  });
});

describe("usage recording", () => {
  it("records page-route-decision through the ledger with actual tokens and catalog cost", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ledger = new PipelineUsageEventLedger();
    const model = catalogModel("perplexity/pplx-decider-v1.1-27b");
    const seen: unknown[] = [];
    const client = createDecisionClient({
      privacyMode: "standard",
      env,
      fetchImpl: mockFetch(okBody(5000)),
      retry,
      onUsage: (m, result) => seen.push(recordDecisionUsage(ledger, m, result, { documentId: "doc-1", role: "triage", pages: [1] })),
    });
    await client.ask(model, "s", questions);
    expect(seen).toHaveLength(1);
    const [event] = ledger.snapshot();
    expect(event).toMatchObject({
      model: "perplexity/pplx-decider-v1.1-27b",
      inputTokens: 5000,
      metadata: { documentId: "doc-1", role: "triage", endpoint: "perplexity-decisions" },
    });
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[ai-usage\] page-route-decision model=perplexity\/pplx-decider-v1\.1-27b input_tokens=5000/));
    // Provider cost is recorded for our reports; routing decisions bill no credits.
    expect(Number(event!.metadata?.providerCostCents)).toBeGreaterThan(0);
    expect(Number(event!.metadata?.providerCostCents)).toBeLessThan(1);
    expect(ledger.pendingBillableCents).toBe(0);
  });

  it("prices input tokens only", () => {
    expect(decisionCostCents(catalogModel("typesafe/jev-1.13"), 1_000_000)).toBeCloseTo(4.2, 10);
  });
});

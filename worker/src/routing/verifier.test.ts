import { describe, expect, it, vi } from "vitest";

import { PipelineUsageEventLedger } from "../pipeline/usage-ledger.js";
import type { DecisionAnswer, DecisionCallResult, DecisionClient } from "./decision-client.js";
import { CANARY_QUESTIONS } from "./health/canary.js";
import { DecisionModelHealthRegistry } from "./health/registry.js";
import {
  DecisionModelVerifier,
  VERIFIER_MODELS,
  VERIFIER_QUESTIONS,
  createDecisionVerifier,
  escalationThreshold,
  pFailFromFeatures,
  targetClass,
  verifierFeatures,
  type VerifierSlot,
} from "./verifier.js";
import { PAGE_VERIFIER_FITTED } from "./verifier-config.js";

/** Aggregated decision answers (probabilities only) and the P(fail) the Python/sklearn pipeline gave them. */
const GOLDEN: Array<{
  targetId: string;
  textLength: number;
  omni: Record<string, DecisionAnswer>;
  flash: Record<string, DecisionAnswer>;
  pFail: number;
}> = [
  {
    "targetId": "vlm:openrouter/deepseek/deepseek-v4.1-flash",
    "textLength": 4928,
    "omni": {
      "all_text_present": {
        "type": "noul",
        "noul": 0.9084
      },
      "nothing_invented": {
        "type": "noul",
        "noul": 0.9477
      },
      "numbers_preserved": {
        "type": "noul",
        "noul": 0.7749
      },
      "reading_order": {
        "type": "noul",
        "noul": 0.9319
      },
      "table_rows": {
        "type": "noul",
        "noul": 0.9953
      },
      "table_columns": {
        "type": "noul",
        "noul": 0.9836
      },
      "table_cells": {
        "type": "noul",
        "noul": 0.9916
      },
      "formulas": {
        "type": "noul",
        "noul": 0.9319
      },
      "quality": {
        "type": "score",
        "score": 3.774,
        "confidence": 0.7034,
        "probabilities": {
          "0": 0.0031,
          "1": 0.0242,
          "2": 0.0381,
          "3": 0.0649,
          "4": 0.8697
        }
      },
      "page_has_table": {
        "type": "noul",
        "noul": 0.0103
      },
      "page_has_formula": {
        "type": "noul",
        "noul": 0.0061
      },
      "page_dense": {
        "type": "noul",
        "noul": 0.8386
      },
      "table_in_candidate": {
        "type": "noul",
        "noul": 0.2724
      },
      "cut_off": {
        "type": "noul",
        "noul": 0.4931
      },
      "layout_matches": {
        "type": "noul",
        "noul": 0.8628
      }
    },
    "flash": {
      "all_text_present": {
        "type": "noul",
        "noul": 0.7115
      },
      "nothing_invented": {
        "type": "noul",
        "noul": 0.8807
      },
      "numbers_preserved": {
        "type": "noul",
        "noul": 0.5628
      },
      "reading_order": {
        "type": "noul",
        "noul": 0.8247
      },
      "table_rows": {
        "type": "noul",
        "noul": 0.973
      },
      "table_columns": {
        "type": "noul",
        "noul": 0.949
      },
      "table_cells": {
        "type": "noul",
        "noul": 0.9647
      },
      "formulas": {
        "type": "noul",
        "noul": 0.9346
      },
      "quality": {
        "type": "score",
        "score": 3.192,
        "confidence": 0.2024,
        "probabilities": {
          "0": 0.0174,
          "1": 0.0708,
          "2": 0.1401,
          "3": 0.2459,
          "4": 0.5258
        }
      },
      "page_has_table": {
        "type": "noul",
        "noul": 0.0149
      },
      "page_has_formula": {
        "type": "noul",
        "noul": 0.0155
      },
      "page_dense": {
        "type": "noul",
        "noul": 0.4149
      },
      "table_in_candidate": {
        "type": "noul",
        "noul": 0.3918
      },
      "cut_off": {
        "type": "noul",
        "noul": 0.4826
      },
      "layout_matches": {
        "type": "noul",
        "noul": 0.4788
      }
    },
    "pFail": 0.015355
  },
  {
    "targetId": "vlm:private/mineru2.5",
    "textLength": 8733,
    "omni": {
      "all_text_present": {
        "type": "noul",
        "noul": 0.6257
      },
      "nothing_invented": {
        "type": "noul",
        "noul": 0.6545
      },
      "numbers_preserved": {
        "type": "noul",
        "noul": 0.7017
      },
      "reading_order": {
        "type": "noul",
        "noul": 0.6164
      },
      "table_rows": {
        "type": "noul",
        "noul": 0.5623
      },
      "table_columns": {
        "type": "noul",
        "noul": 0.3575
      },
      "table_cells": {
        "type": "noul",
        "noul": 0.5809
      },
      "formulas": {
        "type": "noul",
        "noul": 0.7055
      },
      "quality": {
        "type": "score",
        "score": 2.3577,
        "confidence": 0.0382,
        "probabilities": {
          "0": 0.0574,
          "1": 0.253,
          "2": 0.2381,
          "3": 0.1775,
          "4": 0.274
        }
      },
      "page_has_table": {
        "type": "noul",
        "noul": 0.9691
      },
      "page_has_formula": {
        "type": "noul",
        "noul": 0.407
      },
      "page_dense": {
        "type": "noul",
        "noul": 0.8922
      },
      "table_in_candidate": {
        "type": "noul",
        "noul": 0.6029
      },
      "cut_off": {
        "type": "noul",
        "noul": 0.5611
      },
      "layout_matches": {
        "type": "noul",
        "noul": 0.5926
      }
    },
    "flash": {
      "all_text_present": {
        "type": "noul",
        "noul": 0.5586
      },
      "nothing_invented": {
        "type": "noul",
        "noul": 0.8631
      },
      "numbers_preserved": {
        "type": "noul",
        "noul": 0.5599
      },
      "reading_order": {
        "type": "noul",
        "noul": 0.6849
      },
      "table_rows": {
        "type": "noul",
        "noul": 0.5384
      },
      "table_columns": {
        "type": "noul",
        "noul": 0.4993
      },
      "table_cells": {
        "type": "noul",
        "noul": 0.7383
      },
      "formulas": {
        "type": "noul",
        "noul": 0.643
      },
      "quality": {
        "type": "score",
        "score": 2.7795,
        "confidence": 0.0771,
        "probabilities": {
          "0": 0.039,
          "1": 0.1392,
          "2": 0.1943,
          "3": 0.2584,
          "4": 0.3691
        }
      },
      "page_has_table": {
        "type": "noul",
        "noul": 0.9751
      },
      "page_has_formula": {
        "type": "noul",
        "noul": 0.2209
      },
      "page_dense": {
        "type": "noul",
        "noul": 0.8355
      },
      "table_in_candidate": {
        "type": "noul",
        "noul": 0.483
      },
      "cut_off": {
        "type": "noul",
        "noul": 0.6281
      },
      "layout_matches": {
        "type": "noul",
        "noul": 0.3152
      }
    },
    "pFail": 0.27563
  },
  {
    "targetId": "native:pdf-text",
    "textLength": 2409,
    "omni": {
      "all_text_present": {
        "type": "noul",
        "noul": 0.6837
      },
      "nothing_invented": {
        "type": "noul",
        "noul": 0.7824
      },
      "numbers_preserved": {
        "type": "noul",
        "noul": 0.6269
      },
      "reading_order": {
        "type": "noul",
        "noul": 0.6814
      },
      "table_rows": {
        "type": "noul",
        "noul": 0.9873
      },
      "table_columns": {
        "type": "noul",
        "noul": 0.9089
      },
      "table_cells": {
        "type": "noul",
        "noul": 0.9778
      },
      "formulas": {
        "type": "noul",
        "noul": 0.4311
      },
      "quality": {
        "type": "score",
        "score": 2.4592,
        "confidence": 0.0646,
        "probabilities": {
          "0": 0.0249,
          "1": 0.1779,
          "2": 0.3054,
          "3": 0.2968,
          "4": 0.195
        }
      },
      "page_has_table": {
        "type": "noul",
        "noul": 0.0151
      },
      "page_has_formula": {
        "type": "noul",
        "noul": 0.9689
      },
      "page_dense": {
        "type": "noul",
        "noul": 0.3572
      },
      "table_in_candidate": {
        "type": "noul",
        "noul": 0.5694
      },
      "cut_off": {
        "type": "noul",
        "noul": 0.3231
      },
      "layout_matches": {
        "type": "noul",
        "noul": 0.5825
      }
    },
    "flash": {
      "all_text_present": {
        "type": "noul",
        "noul": 0.7018
      },
      "nothing_invented": {
        "type": "noul",
        "noul": 0.8347
      },
      "numbers_preserved": {
        "type": "noul",
        "noul": 0.5876
      },
      "reading_order": {
        "type": "noul",
        "noul": 0.5254
      },
      "table_rows": {
        "type": "noul",
        "noul": 0.9642
      },
      "table_columns": {
        "type": "noul",
        "noul": 0.9299
      },
      "table_cells": {
        "type": "noul",
        "noul": 0.9347
      },
      "formulas": {
        "type": "noul",
        "noul": 0.3026
      },
      "quality": {
        "type": "score",
        "score": 2.9088,
        "confidence": 0.1068,
        "probabilities": {
          "0": 0.0321,
          "1": 0.1175,
          "2": 0.1743,
          "3": 0.2617,
          "4": 0.4144
        }
      },
      "page_has_table": {
        "type": "noul",
        "noul": 0.0187
      },
      "page_has_formula": {
        "type": "noul",
        "noul": 0.93
      },
      "page_dense": {
        "type": "noul",
        "noul": 0.3116
      },
      "table_in_candidate": {
        "type": "noul",
        "noul": 0.2676
      },
      "cut_off": {
        "type": "noul",
        "noul": 0.2169
      },
      "layout_matches": {
        "type": "noul",
        "noul": 0.4113
      }
    },
    "pFail": 0.811487
  }
] as never;

describe("fitted head parity with the offline pipeline", () => {
  it("reproduces the sklearn P(fail) from raw answers within 1e-3", () => {
    for (const g of GOLDEN) {
      const x = verifierFeatures({ targetId: g.targetId, text: "x".repeat(g.textLength), answers: { omni: g.omni, flash: g.flash } });
      expect(x).toHaveLength(PAGE_VERIFIER_FITTED.features.length);
      expect(Math.abs(pFailFromFeatures(x) - g.pFail)).toBeLessThan(1e-3);
    }
  });

  it("orders the golden cases from likely-good to likely-failed", () => {
    const p = GOLDEN.map((g) =>
      pFailFromFeatures(verifierFeatures({ targetId: g.targetId, text: "x".repeat(g.textLength), answers: { omni: g.omni, flash: g.flash } })));
    expect(p[0]!).toBeLessThan(p[1]!);
    expect(p[1]!).toBeLessThan(p[2]!);
  });

  it("asks only the questions the head was fitted on, with a score question", () => {
    expect(Object.keys(VERIFIER_QUESTIONS)).toContain("quality");
    for (const name of PAGE_VERIFIER_FITTED.features) {
      const m = /^(?:omni|flash):(.+?)(?:_lo)?$/.exec(name);
      if (m) expect(Object.keys(VERIFIER_QUESTIONS)).toContain(m[1]);
    }
  });

  it("classifies targets like the offline fit", () => {
    expect(targetClass("native:pdf-text")).toBe("native");
    expect(targetClass("ocr:tesseract")).toBe("ocr");
    expect(targetClass("vlm:private/mineru2.5")).toBe("parser");
    expect(targetClass("vlm:openrouter/z-ai/glm-5.3-flash")).toBe("vlm");
  });
});

describe("expected-value gating", () => {
  it("escalates earlier as quality gets more valuable and abstains below the minimum value", () => {
    const lo = escalationThreshold({ valueUsdPerQualityUnit: 0.5 })!;
    const hi = escalationThreshold({ valueUsdPerQualityUnit: 2 })!;
    expect(hi).toBeLessThan(lo);
    expect(lo).toBeCloseTo(PAGE_VERIFIER_FITTED.escalationUsdPerPage / (PAGE_VERIFIER_FITTED.gainGivenFail * 0.5), 6);
    expect(escalationThreshold({ valueUsdPerQualityUnit: 0.05 })).toBeNull();
    expect(escalationThreshold({ valueUsdPerQualityUnit: null })).toBeNull();
    expect(escalationThreshold({ valueUsdPerQualityUnit: 1000 })).toBeLessThan(0.001);
    expect(escalationThreshold({ valueUsdPerQualityUnit: 0.01, minValueUsdPerQualityUnit: 0 })).toBe(1);
  });
});

const PNG = new Uint8Array([137, 80, 78, 71]);

function healthyCanary(): Record<string, DecisionAnswer> {
  return {
    has_math: { type: "noul", noul: 0.96 },
    mentions_cat: { type: "noul", noul: 0.01 },
    subject: { type: "choice", choice: "mathematics", confidence: 0.93, probabilities: { mathematics: 0.93, animals: 0.04, cooking: 0.03 } },
  };
}

function result(answers: Record<string, DecisionAnswer>, costCents = 0.01): DecisionCallResult {
  return { answers, usage: { inputTokens: 1000, outputTokens: 0 }, latencyMs: 5, costCents, model: "m", provider: "openrouter" };
}

function fakeClients(verifyAnswers: (slot: VerifierSlot) => Record<string, DecisionAnswer> | Error) {
  const calls: Array<{ model: string; questions: string[]; state: unknown }> = [];
  const make = (canary: boolean): DecisionClient => ({
    async ask(model, state, questions) {
      const isCanary = Object.keys(questions).includes("has_math") && Object.keys(CANARY_QUESTIONS).length === Object.keys(questions).length;
      if (isCanary || canary) return result(healthyCanary(), 0.0001);
      calls.push({ model: model.id, questions: Object.keys(questions), state });
      const out = verifyAnswers(model.id === VERIFIER_MODELS.omni.id ? "omni" : "flash");
      if (out instanceof Error) throw out;
      return result(out);
    },
  });
  return { client: make(false), canaryClient: make(true), calls };
}

const answersFor = (g: (typeof GOLDEN)[number]) => (slot: VerifierSlot) => g[slot];

function verifier(g: (typeof GOLDEN)[number], extra: { value?: number | null; loadImage?: () => Promise<Uint8Array | null>; health?: DecisionModelHealthRegistry; answers?: (slot: VerifierSlot) => Record<string, DecisionAnswer> | Error } = {}) {
  const clients = fakeClients(extra.answers ?? answersFor(g));
  const v = new DecisionModelVerifier({
    members: {
      omni: { slot: "omni", model: VERIFIER_MODELS.omni, client: clients.client },
      flash: { slot: "flash", model: VERIFIER_MODELS.flash, client: clients.client },
    },
    canaryClient: clients.canaryClient,
    gate: { valueUsdPerQualityUnit: extra.value === undefined ? 1 : extra.value },
    health: extra.health ?? new DecisionModelHealthRegistry(),
    loadImage: extra.loadImage ?? (async () => PNG),
  });
  return { v, clients };
}

describe("DecisionModelVerifier", () => {
  const failing = GOLDEN[2]!;
  const good = GOLDEN[0]!;
  const request = (g: (typeof GOLDEN)[number]) => ({ pageNumber: 3, targetId: g.targetId, text: "x".repeat(g.textLength), imagePath: "/p.png" });

  it("asks both members the fitted questions with image + candidate and sums their cost", async () => {
    const { v, clients } = verifier(failing);
    const verdict = await v.verify(request(failing));
    expect(clients.calls.map((c) => c.model).sort()).toEqual(["cloudflare/clef-flash", "cloudflare/clef-omni"]);
    for (const c of clients.calls) {
      expect(c.questions).toEqual(Object.keys(VERIFIER_QUESTIONS));
      const state = c.state as unknown[];
      expect(state).toHaveLength(2);
      expect(String(state[1])).toMatch(/^Candidate transcription:/);
    }
    expect(verdict!.costUsd).toBeCloseTo(0.0002, 8);
    expect(verdict!.pFail).toBeGreaterThan(0.7);
    expect(verdict!.escalate).toBe(true);
  });

  it("does not escalate a clean page", async () => {
    const { v } = verifier(good);
    const verdict = await v.verify(request(good));
    expect(verdict!.pFail).toBeLessThan(0.1);
    expect(verdict!.escalate).toBe(false);
  });

  it("abstains without calling any model when quality is not valued enough", async () => {
    const { v, clients } = verifier(failing, { value: 0.05 });
    expect(await v.verify(request(failing))).toBeNull();
    expect(clients.calls).toHaveLength(0);
    expect(v.trace[0]!.reason).toBe("value-of-quality-below-gate");
  });

  it("abstains without an image or text", async () => {
    const { v, clients } = verifier(failing);
    const noImage = verifier(failing, { loadImage: async () => null });
    expect(await noImage.v.verify(request(failing))).toBeNull();
    expect(await v.verify({ ...request(failing), text: "  " })).toBeNull();
    expect(clients.calls).toHaveLength(0);
  });

  it("abstains and marks the member unhealthy when its answers are degenerate", async () => {
    const health = new DecisionModelHealthRegistry();
    const flat = Object.fromEntries(Object.keys(failing.omni).map((k) => [k, { type: "noul", noul: 0.29637 } as DecisionAnswer]));
    const { v } = verifier(failing, { health, answers: (slot) => (slot === "omni" ? flat : failing.flash) });
    expect(await v.verify(request(failing))).toBeNull();
    expect(v.trace[0]!.reason).toBe("degenerate:cloudflare/clef-omni");
    expect(health.status("cloudflare/clef-omni")?.healthy).toBe(false);
    // the next page does not even call the models: the registry short-circuits on the cached unhealthy state
    const second = await v.verify(request(failing));
    expect(second).toBeNull();
    expect(v.trace[1]!.reason).toBe("unhealthy:cloudflare/clef-omni");
  });

  it("abstains when a call fails", async () => {
    const { v } = verifier(failing, { answers: (slot) => (slot === "flash" ? new Error("boom") : failing.omni) });
    expect(await v.verify(request(failing))).toBeNull();
    expect(v.trace[0]!.reason).toBe("call-failed:cloudflare/clef-flash");
  });

  it("abstains when a member omits a fitted question", async () => {
    const partial = { ...failing.flash };
    delete partial.formulas;
    const { v } = verifier(failing, { answers: (slot) => (slot === "flash" ? partial : failing.omni) });
    expect(await v.verify(request(failing))).toBeNull();
    expect(v.trace[0]!.reason).toBe("missing-answers:cloudflare/clef-flash");
  });
});

describe("createDecisionVerifier usage recording", () => {
  it("records verifier and canary calls through the usage ledger", async () => {
    const answers = GOLDEN[1]!;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init!.body)) as { model: string; questions: Record<string, unknown> };
      const isCanary = "has_math" in body.questions;
      const slot = body.model.endsWith("omni") ? "omni" : "flash";
      const out = isCanary ? healthyCanary() : answers[slot];
      return new Response(JSON.stringify({ answers: out, usage: { input_tokens: 2000, output_tokens: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const ledger = new PipelineUsageEventLedger();
    const v = createDecisionVerifier({
      ledger,
      privacyMode: "standard",
      gate: { valueUsdPerQualityUnit: 1 },
      env: { OPENROUTER_API_KEY: "k" } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      health: new DecisionModelHealthRegistry(),
      loadImage: async () => PNG,
      documentId: "doc-1",
    });
    const verdict = await v.verify({ pageNumber: 1, targetId: "native:pdf-text", text: "x".repeat(answers.textLength), imagePath: "/p.png" });
    expect(verdict).not.toBeNull();
    // 2 canaries + 2 verifier calls, all priced from the catalog (omni 0.15, flash 0.038 USD/MTok)
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(verdict!.costUsd).toBeCloseTo((2000 / 1e6) * (0.15 + 0.038), 9);
    expect(ledger.pendingBillableCents).toBeGreaterThan(0);
  });

  it("refuses hosted calls outside standard privacy mode and abstains", async () => {
    const fetchImpl = vi.fn();
    const v = createDecisionVerifier({
      ledger: new PipelineUsageEventLedger(),
      privacyMode: "private",
      gate: { valueUsdPerQualityUnit: 1 },
      env: { OPENROUTER_API_KEY: "k" } as NodeJS.ProcessEnv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      health: new DecisionModelHealthRegistry(),
      loadImage: async () => PNG,
    });
    expect(await v.verify({ pageNumber: 1, targetId: "native:pdf-text", text: "hello", imagePath: "/p.png" })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("verifier page image", () => {
  it("downsizes the page raster to the 768 px long edge the fitted head was tuned at", async () => {
    const { default: sharp } = await import("sharp");
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(`${tmpdir()}/verifier-image-`);
    try {
      const file = `${dir}/page.png`;
      await writeFile(file, await sharp({ create: { width: 1200, height: 1600, channels: 3, background: "white" } }).png().toBuffer());
      const seen: Uint8Array[] = [];
      const { VERIFIER_FORMAT, VERIFIER_IMAGE_LONG_EDGE, defaultVerifierLoadImage } = await import("./verifier.js");
      seen.push((await defaultVerifierLoadImage({ pageNumber: 1, targetId: "t", text: "x", imagePath: file }))!);
      const meta = await sharp(seen[0]!).metadata();
      expect(VERIFIER_IMAGE_LONG_EDGE).toBe(768);
      expect(VERIFIER_FORMAT).toContain("768px");
      expect(Math.max(meta.width!, meta.height!)).toBe(768);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

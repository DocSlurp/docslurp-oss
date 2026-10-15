import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDecisionModelCatalog } from "@docslurp/shared";

import type { DecisionAnswer, DecisionCallResult, DecisionClient } from "../decision-client.js";
import { judgeCanary } from "./canary.js";
import { DecisionModelHealthHistory, DecisionModelQuarantinedError, withHealthHistory } from "./history.js";

const pplx = buildDecisionModelCatalog({ env: { PERPLEXITYAI_API_KEY: true, OPENROUTER_API_KEY: true } }).models
  .find((m) => m.id === "perplexity/pplx-decider-v1.1-27b")!;

const choice = (pick: string, p: number): DecisionAnswer => ({
  type: "choice", choice: pick, confidence: p,
  probabilities: { [pick]: p, animals: (1 - p) / 2, cooking: (1 - p) / 2 },
});
const answers = (o: { math?: number; cat?: number; pick?: string; p?: number } = {}): Record<string, DecisionAnswer> => ({
  has_math: { type: "noul", noul: o.math ?? 0.95 },
  mentions_cat: { type: "noul", noul: o.cat ?? 0.02 },
  subject: choice(o.pick ?? "mathematics", o.p ?? 0.9),
});
const DAY = 86_400_000;

describe("judgeCanary noul/choice split", () => {
  it("reports the degenerate-noul / healthy-choice failure as noul-only", () => {
    const v = judgeCanary(answers({ math: 0.1306, cat: 0.1306 }));
    expect(v.noul.healthy).toBe(false);
    expect(v.choice.healthy).toBe(true);
    expect(v.healthy).toBe(false);
    expect(v.reason).toMatch(/degenerate/);
  });
  it("fails the choice part when the first option is always picked", () => {
    const v = judgeCanary(answers({ pick: "animals", p: 0.9 }));
    expect(v.noul.healthy).toBe(true);
    expect(v.choice.healthy).toBe(false);
  });
  it("fails the choice part when options are not separated", () => {
    const v = judgeCanary({ ...answers(), subject: { type: "choice", choice: "mathematics", confidence: 0.52, probabilities: { mathematics: 0.52, animals: 0.45, cooking: 0.03 } } });
    expect(v.choice.healthy).toBe(false);
    expect(v.choice.reason).toMatch(/margin/);
  });
});

describe("DecisionModelHealthHistory", () => {
  const clean = { noul: { healthy: true, reason: "ok" }, choice: { healthy: true, reason: "ok" }, reason: "ok" };
  it("makes a model eligible only after three distinct clean UTC days, and persists to disk", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hh-")), "h.json");
    let now = Date.UTC(2026, 9, 12, 12);
    const h = new DecisionModelHealthHistory({ path, now: () => now });
    h.recordVerdict("m", clean);
    h.recordVerdict("m", clean); // same day twice still one day
    expect(h.reentryStatus("m").eligible).toBe(false);
    now += DAY;
    h.recordVerdict("m", clean);
    expect(h.reentryStatus("m")).toMatchObject({ eligible: false, cleanDays: ["2026-10-13", "2026-10-12"] });
    now += DAY;
    h.recordVerdict("m", clean);
    expect(h.reentryStatus("m").eligible).toBe(true);
    const reloaded = new DecisionModelHealthHistory({ path, now: () => now });
    expect(reloaded.reentryStatus("m").eligible).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
  });
  it("a failed noul probe or error on one of the days blocks re-entry", () => {
    let now = Date.UTC(2026, 9, 12);
    const h = new DecisionModelHealthHistory({ now: () => now });
    h.recordVerdict("m", clean);
    now += DAY;
    h.recordVerdict("m", { noul: { healthy: false, reason: "degenerate" }, choice: { healthy: true, reason: "ok" }, reason: "degenerate" });
    now += DAY;
    h.recordVerdict("m", clean);
    expect(h.reentryStatus("m").eligible).toBe(false);
    now += DAY;
    h.recordError("m", "timeout");
    expect(h.reentryStatus("m").eligible).toBe(false);
  });
  it("ignores days outside the window", () => {
    let now = Date.UTC(2026, 9, 1);
    const h = new DecisionModelHealthHistory({ now: () => now, windowDays: 5 });
    for (let i = 0; i < 3; i++) { h.recordVerdict("m", clean); now += DAY; }
    expect(h.reentryStatus("m").eligible).toBe(true);
    now += 10 * DAY;
    expect(h.reentryStatus("m").eligible).toBe(false);
  });
});

describe("withHealthHistory", () => {
  const inner = (out: Record<string, DecisionAnswer>): DecisionClient => ({
    async ask(model): Promise<DecisionCallResult> {
      return { answers: out, usage: { inputTokens: 10, outputTokens: 0 }, latencyMs: 1, costCents: 0, model: model.id, provider: "fake" };
    },
  });
  it("rejects a quarantined model's passing canary until history is long enough, then admits it", async () => {
    let now = Date.UTC(2026, 9, 12);
    const history = new DecisionModelHealthHistory({ now: () => now });
    const client = withHealthHistory(inner(answers()), { history, quarantined: [pplx.id] });
    const { CANARY_QUESTIONS, CANARY_STATE } = await import("./canary.js");
    await expect(client.ask(pplx, CANARY_STATE, CANARY_QUESTIONS)).rejects.toBeInstanceOf(DecisionModelQuarantinedError);
    now += DAY;
    await expect(client.ask(pplx, CANARY_STATE, CANARY_QUESTIONS)).rejects.toBeInstanceOf(DecisionModelQuarantinedError);
    now += DAY;
    await expect(client.ask(pplx, CANARY_STATE, CANARY_QUESTIONS)).resolves.toBeTruthy();
  });
  it("does not gate non-quarantined models or non-canary questions", async () => {
    const history = new DecisionModelHealthHistory();
    const client = withHealthHistory(inner(answers()), { history, quarantined: [pplx.id] });
    await expect(client.ask(pplx, "x", { other: { type: "noul", instructions: "?" } })).resolves.toBeTruthy();
    expect(history.days(pplx.id)).toHaveLength(0);
  });
});

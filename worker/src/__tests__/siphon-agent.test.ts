import { beforeEach, describe, expect, it, vi } from "vitest";

const generate = vi.fn();
vi.mock("../lib/ai.js", () => ({ generateOpenRouterText: (args: unknown) => generate(args) }));

import { decideNextWindow, runSiphonLoop, type MapDraft, type SiphonDecision } from "../deferred/siphon-agent.js";
import type { WorkerAiUsageInput } from "../lib/ai-usage.js";

const reply = (text: string) => ({ text, finishReason: "stop", usage: { inputTokens: 900, outputTokens: 120 } });
const emptyMap: MapDraft = { nodes: [], terms: [] };

function decide(text: string) {
  generate.mockResolvedValueOnce(reply(text));
  const usage: WorkerAiUsageInput[] = [];
  return decideNextWindow({
    observation: { startPage: 36, endPage: 40, pageTexts: ["a", "b", "c", "d", "e"] },
    mapSoFar: emptyMap, pageCount: 120, model: "test/model", apiKey: "k", privacyMode: "standard",
    usage: (u) => usage.push(u),
  }).then((result) => ({ ...result, usage }));
}

beforeEach(() => generate.mockReset());

describe("decideNextWindow", () => {
  it("parses a queue decision with extracted nodes and terms, and records usage", async () => {
    const { decision, extracted, usage } = await decide('```json\n{"action":"queue","startPage":40,"endPage":44,"nodes":[{"title":"Methods","level":1,"printedStart":"28"}],"terms":[{"term":"entropy","printedPages":["12","40"]}]}\n```');
    expect(decision).toEqual({ action: "queue", startPage: 40, endPage: 44 });
    expect(extracted.nodes).toMatchObject([{ title: "Methods", level: 1, printedStart: "28", source: "agent" }]);
    expect(extracted.terms).toEqual([{ term: "entropy", printedPages: ["12", "40"] }]);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ inputTokens: 900, outputTokens: 120, metric: "document-map-siphon" });
    expect(generate.mock.calls[0]![0]).toMatchObject({ maxOutputTokens: 600 });
  });

  it("stops with a reason on malformed JSON and still records usage", async () => {
    const { decision, extracted, usage } = await decide("sorry, I cannot do that");
    expect(decision).toEqual({ action: "stop", reason: "malformed-json" });
    expect(extracted).toEqual(emptyMap);
    expect(usage).toHaveLength(1);
  });

  it("rejects out-of-range jump targets", async () => {
    const { decision } = await decide('{"action":"jump","startPage":999}');
    expect(decision.action).toBe("stop");
  });
});

describe("runSiphonLoop", () => {
  const readWindow = async (s: number, e: number) => ({ pageTexts: Array.from({ length: e - s + 1 }, () => "text") });

  it("stops at the page budget when the agent always continues forward", async () => {
    const seen: number[] = [];
    const result = await runSiphonLoop({
      pageCount: 400, maxSiphonPages: 12, seed: emptyMap, readWindow,
      decide: async (obs) => {
        seen.push(obs.startPage);
        return { decision: { action: "continue-forward" } as SiphonDecision, extracted: { nodes: [{ id: `n${obs.startPage}`, title: "t", level: 1, parentId: null, printedStart: null, printedEnd: null, physicalStart: obs.startPage, physicalEnd: null, source: "agent", confidence: 0.6 }], terms: [] } };
      },
    });
    expect(result.pagesRead.length).toBeLessThanOrEqual(12);
    expect(result.stoppedBy).toBe("page-budget");
    expect(seen).toEqual([1, 6, 11]);
  });

  it("visits the back of the document after the front, and stops after two quiet windows", async () => {
    const seen: number[] = [];
    const result = await runSiphonLoop({
      pageCount: 100, maxSiphonPages: 60, seed: emptyMap, readWindow,
      decide: async (obs) => { seen.push(obs.startPage); return { decision: { action: "continue-forward" } as SiphonDecision, extracted: emptyMap }; },
    });
    expect(result.stoppedBy).toBe("no-new-structure");
    expect(seen).toHaveLength(2);
  });

  it("stops when the credit cap is reached", async () => {
    const result = await runSiphonLoop({
      pageCount: 400, maxSiphonPages: 60, maxCredits: 50, seed: emptyMap, readWindow,
      decide: async (obs) => ({ decision: { action: "continue-forward" }, costCents: 30, extracted: { nodes: [{ id: `n${obs.startPage}`, title: "t", level: 1, parentId: null, printedStart: null, printedEnd: null, physicalStart: null, physicalEnd: null, source: "agent", confidence: 0.6 }], terms: [] } }),
    });
    expect(result.stoppedBy).toBe("credit-budget");
    expect(result.decisions).toHaveLength(2);
  });
});

describe("runSiphonLoop seeds and stop hook", () => {
  const readWindow = async (s: number, e: number) => ({ pageTexts: Array.from({ length: e - s + 1 }, () => "text") });

  it("does not count quiet seeded observations toward the no-new-structure stop", async () => {
    const seen: number[] = [];
    const seeds = [1, 6].map((startPage) => ({ startPage, endPage: startPage + 4, pageTexts: ["a", "b", "c", "d", "e"] }));
    const result = await runSiphonLoop({
      pageCount: 100, maxSiphonPages: 60, seed: emptyMap, readWindow, initialObservations: seeds,
      decide: async (obs) => { seen.push(obs.startPage); return { decision: { action: "continue-forward" } as SiphonDecision, extracted: emptyMap }; },
    });
    // Both seeds were quiet, yet the loop still read its own windows before stopping after two quiet ones.
    expect(seen).toEqual([1, 6, 11, 16]);
    expect(result.stoppedBy).toBe("no-new-structure");
  });

  it("shows seeded observations first without spending page budget or re-reading them", async () => {
    const seen: number[] = [];
    const reads: number[] = [];
    const result = await runSiphonLoop({
      pageCount: 100, maxSiphonPages: 5, seed: emptyMap,
      readWindow: async (s, e) => { reads.push(s); return readWindow(s, e); },
      initialObservations: [{ startPage: 1, endPage: 5, pageTexts: ["a", "b", "c", "d", "e"] }],
      decide: async (obs) => { seen.push(obs.startPage); return { decision: { action: "jump", startPage: 40 } as SiphonDecision, extracted: { nodes: [], terms: [{ term: "t", printedPages: ["1"] }] } }; },
    });
    expect(seen[0]).toBe(1);
    expect(seen[1]).toBe(40);
    expect(reads).not.toContain(1);
    expect(result.pagesRead).toContain(1);
  });

  it("stops before the next window when shouldStop trips", async () => {
    let calls = 0;
    const result = await runSiphonLoop({
      pageCount: 100, maxSiphonPages: 60, seed: emptyMap, readWindow, shouldStop: () => calls >= 1,
      decide: async () => { calls++; return { decision: { action: "continue-forward" } as SiphonDecision, extracted: { nodes: [], terms: [{ term: "t", printedPages: ["1"] }] } }; },
    });
    expect(calls).toBe(1);
    expect(result.stoppedBy).toBe("credit-budget");
  });
});

import { afterEach, expect, it, vi } from "vitest";
import { defaultGraphConfig } from "@docslurp/shared";
import { generateOpenRouterText } from "../lib/ai.js";
import { extractDocumentGraph } from "./extract.js";

vi.mock("../lib/ai.js", () => ({ generateOpenRouterText: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it.each([
  ["length", '{"entities":[{"name":"Example"}'],
  ["stop", "not JSON"],
])("records actual usage before a %s response falls back", async (finishReason, text) => {
  vi.mocked(generateOpenRouterText).mockResolvedValue({ text, finishReason, usage: { inputTokens: 100, outputTokens: 1600 } });
  const onUsage = vi.fn();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const graph = await extractDocumentGraph({
    filename: "synthetic.html", chunks: [{ id: "chunk", text: "Example System handles documents." }],
    context: { config: defaultGraphConfig, scope: "Synthetic workspace", model: "test-model", apiKey: "mock", useLlm: true, privacyMode: "standard", onUsage },
  });
  expect(graph).toMatchObject({ source: "heuristic", windows: 0, inputTokens: 100, outputTokens: 1600 });
  expect(onUsage).toHaveBeenCalledExactlyOnceWith({ inputTokens: 100, outputTokens: 1600 }, expect.objectContaining({ finishReason, window: 1 }));
  expect(warning).toHaveBeenCalledWith(expect.stringContaining(`finishReason=${finishReason}`));
});

it("records every generated window once, including usage before later cancellation", async () => {
  const controller = new AbortController();
  vi.mocked(generateOpenRouterText)
    .mockResolvedValueOnce({ text: '{"entities":[],"relationships":[]}', finishReason: "stop", usage: { inputTokens: 50, outputTokens: 10 } })
    .mockImplementationOnce(async () => { controller.abort(); throw new Error("cancelled"); });
  const onUsage = vi.fn();
  await expect(extractDocumentGraph({
    filename: "synthetic.html", chunks: [{ id: "chunk", text: "Example ".repeat(2000) }],
    context: { config: { ...defaultGraphConfig, depth: "standard" }, scope: "Synthetic", model: "test-model", apiKey: "mock", useLlm: true, privacyMode: "standard", signal: controller.signal, onUsage },
  })).rejects.toThrow("cancelled");
  expect(onUsage).toHaveBeenCalledTimes(1);
  expect(onUsage).toHaveBeenCalledWith({ inputTokens: 50, outputTokens: 10 }, expect.objectContaining({ window: 1 }));
});

it("does not turn recorder failures into an unbilled heuristic success", async () => {
  vi.mocked(generateOpenRouterText).mockResolvedValue({ text: '{"entities":[],"relationships":[]}', finishReason: "stop", usage: { inputTokens: 100, outputTokens: 20 } });
  await expect(extractDocumentGraph({
    filename: "synthetic.html", chunks: [{ id: "chunk", text: "Example System handles documents." }],
    context: { config: defaultGraphConfig, scope: "Synthetic", model: "test-model", apiKey: "mock", useLlm: true, privacyMode: "standard", onUsage: () => { throw new Error("recorder unavailable"); } },
  })).rejects.toThrow("recorder unavailable");
});

it("preserves asymmetric subject/object order and distinct reciprocal relationships", async () => {
  vi.mocked(generateOpenRouterText).mockResolvedValue({
    text: JSON.stringify({ entities: [
      { name: "Zulu Team", type: "organization", confidence: 1 },
      { name: "Alpha Team", type: "organization", confidence: 1 },
    ], relationships: [
      { subject: "Zulu Team", predicate: "delegates to", object: "Alpha Team", confidence: 1 },
      { subject: "Alpha Team", predicate: "delegates to", object: "Zulu Team", confidence: 1 },
    ] }), finishReason: "stop", usage: { inputTokens: 10, outputTokens: 20 },
  });
  const graph = await extractDocumentGraph({ filename: "teams.txt", chunks: [
    { id: "one", text: "Zulu Team delegates to Alpha Team." },
    { id: "two", text: "Alpha Team delegates to Zulu Team." },
  ], context: { config: defaultGraphConfig, scope: "Workspace documents", model: "test-model", apiKey: "mock", useLlm: true, privacyMode: "standard", onUsage: () => {} } });
  expect(graph.edges.filter((edge) => edge.normalizedPredicate === "delegates_to").map((edge) => [edge.sourceKey.split("\0")[0], edge.targetKey.split("\0")[0]])).toEqual([
    ["zulu team", "alpha team"], ["alpha team", "zulu team"],
  ]);
  const coMentions = graph.edges.filter((edge) => edge.predicate === "co_mentions");
  expect(coMentions).toHaveLength(1);
  expect(coMentions[0]).toMatchObject({ weight: 2 });
  expect(coMentions[0]!.sourceKey < coMentions[0]!.targetKey).toBe(true);
});

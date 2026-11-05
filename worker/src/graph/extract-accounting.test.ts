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
    context: { config: defaultGraphConfig, scope: "Synthetic project", model: "test-model", apiKey: "mock", useLlm: true, privacyMode: "standard", onUsage },
  });
  // A cut-off answer is retried at 3,200 and 6,400 tokens; each attempt is recorded.
  const attempts = finishReason === "length" ? 3 : 1;
  expect(graph).toMatchObject({ source: "heuristic", llmFailed: true, windows: 0, inputTokens: 100 * attempts, outputTokens: 1600 * attempts });
  expect(onUsage).toHaveBeenCalledTimes(attempts);
  expect(onUsage).toHaveBeenCalledWith({ inputTokens: 100, outputTokens: 1600 }, expect.objectContaining({ finishReason, window: 1 }));
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
  ], context: { config: defaultGraphConfig, scope: "Project documents", model: "test-model", apiKey: "mock", useLlm: true, privacyMode: "standard", onUsage: () => {} } });
  expect(graph.edges.filter((edge) => edge.normalizedPredicate === "delegates_to").map((edge) => [edge.sourceKey.split("\0")[0], edge.targetKey.split("\0")[0]])).toEqual([
    ["zulu team", "alpha team"], ["alpha team", "zulu team"],
  ]);
  const coMentions = graph.edges.filter((edge) => edge.predicate === "co_mentions");
  expect(coMentions).toHaveLength(1);
  expect(coMentions[0]).toMatchObject({ weight: 2 });
  expect(coMentions[0]!.sourceKey < coMentions[0]!.targetKey).toBe(true);
});

it("flags a provider failure on every window, but not a run without a model", async () => {
  vi.mocked(generateOpenRouterText).mockRejectedValue(new Error("404 No endpoints found"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const chunks = [{ id: "chunk", text: "Example System handles documents." }];
  const context = { config: defaultGraphConfig, scope: "Synthetic", model: "test-model", useLlm: true, privacyMode: "standard" as const };
  expect(await extractDocumentGraph({ filename: "synthetic.html", chunks, context: { ...context, apiKey: "mock" } }))
    .toMatchObject({ source: "heuristic", llmFailed: true });
  expect(await extractDocumentGraph({ filename: "synthetic.html", chunks, context }))
    .toMatchObject({ source: "heuristic", llmFailed: false });
});

it("retries a cut-off window with a larger budget before falling back", async () => {
  vi.mocked(generateOpenRouterText).mockReset();
  vi.mocked(generateOpenRouterText)
    .mockResolvedValueOnce({ text: '{"entities":[{"name":"Acme"', finishReason: "length", usage: { inputTokens: 100, outputTokens: 1600 } })
    .mockResolvedValueOnce({ text: '{"entities":[{"name":"Acme","type":"organization","confidence":0.9}],"relationships":[]}', finishReason: "stop", usage: { inputTokens: 100, outputTokens: 40 } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const onUsage = vi.fn();
  const graph = await extractDocumentGraph({
    filename: "synthetic.html", chunks: [{ id: "chunk", text: "Acme supplies documents." }],
    context: { config: defaultGraphConfig, scope: "Synthetic", model: "test-model", apiKey: "mock", useLlm: true, privacyMode: "standard", onUsage },
  });
  expect(graph).toMatchObject({ source: "llm", llmFailed: false, windows: 1, inputTokens: 200, outputTokens: 1640 });
  expect(vi.mocked(generateOpenRouterText).mock.calls.map(([call]) => call.maxOutputTokens)).toEqual([1600, 3200]);
  expect(onUsage).toHaveBeenCalledTimes(2);
});

it("stops expanding at the ceiling", async () => {
  vi.mocked(generateOpenRouterText).mockReset();
  vi.mocked(generateOpenRouterText).mockResolvedValue({ text: '{"entities":[', finishReason: "length", usage: { inputTokens: 10, outputTokens: 10 } });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const graph = await extractDocumentGraph({
    filename: "synthetic.html", chunks: [{ id: "chunk", text: "Acme supplies documents." }],
    context: { config: defaultGraphConfig, scope: "Synthetic", model: "test-model", apiKey: "mock", useLlm: true, privacyMode: "standard" },
  });
  expect(graph).toMatchObject({ source: "heuristic", llmFailed: true });
  expect(vi.mocked(generateOpenRouterText).mock.calls.map(([call]) => call.maxOutputTokens)).toEqual([1600, 3200, 6400]);
});

it("stops after a route-level provider refusal, but keeps reading windows after a rate limit or a per-request 4xx", async () => {
  const { APICallError } = await import("ai");
  const refusal = (statusCode: number) => new APICallError({ message: "No allowed providers are available for the selected model.",
    url: "https://openrouter.ai/api/v1/chat/completions", requestBodyValues: {}, statusCode, isRetryable: statusCode === 429 });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const extract = () => extractDocumentGraph({
    filename: "synthetic.html", chunks: [{ id: "chunk", text: "Example ".repeat(4000) }],
    context: { config: { ...defaultGraphConfig, depth: "standard" }, scope: "Synthetic", model: "test-model", apiKey: "mock", useLlm: true, privacyMode: "standard", onUsage: () => {} },
  });

  vi.mocked(generateOpenRouterText).mockReset().mockRejectedValue(refusal(404));
  expect(await extract()).toMatchObject({ source: "heuristic", llmFailed: true });
  expect(generateOpenRouterText).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(expect.stringContaining("outcome=provider-error (HTTP 404, not retryable)"));

  for (const status of [429, 400, 403, 413, 422]) {
    vi.mocked(generateOpenRouterText).mockReset().mockRejectedValue(refusal(status));
    await extract();
    expect(vi.mocked(generateOpenRouterText).mock.calls.length).toBeGreaterThan(1);
  }
});

it("marks a graph cut short by a route-level refusal after a partial success as failed, so it stays stale", async () => {
  const { APICallError } = await import("ai");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.mocked(generateOpenRouterText).mockReset()
    .mockResolvedValueOnce({ text: '{"entities":[{"name":"Example System","type":"concept","confidence":1}],"relationships":[]}', finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 } })
    .mockRejectedValue(new APICallError({ message: "Insufficient credits", url: "https://openrouter.ai/api/v1/chat/completions", requestBodyValues: {}, statusCode: 402, isRetryable: false }));
  const graph = await extractDocumentGraph({
    filename: "synthetic.html", chunks: [{ id: "chunk", text: "Example System ".repeat(3000) }],
    context: { config: { ...defaultGraphConfig, depth: "standard" }, scope: "Synthetic", model: "test-model", apiKey: "mock", useLlm: true, privacyMode: "standard", onUsage: () => {} },
  });
  expect(generateOpenRouterText).toHaveBeenCalledTimes(2);
  expect(graph).toMatchObject({ source: "llm", llmFailed: true, windows: 1 });
});

it("counts every window the model answered as read, parsed or not, so billing follows what it read", async () => {
  const ok = { text: '{"entities":[{"name":"Example System","type":"concept","confidence":0.9}],"relationships":[]}', finishReason: "stop", usage: { inputTokens: 50, outputTokens: 10 } };
  const bad = { text: "not JSON", finishReason: "stop", usage: { inputTokens: 50, outputTokens: 10 } };
  // Three windows of 12,000 characters (standard depth): the middle answer does not parse. A provider error would read nothing.
  vi.mocked(generateOpenRouterText).mockResolvedValueOnce(ok).mockResolvedValueOnce(bad).mockResolvedValueOnce(ok);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const chunks = Array.from({ length: 3 }, (_, index) => ({ id: `c${index}`, text: `Example ${"x".repeat(11_000)}` }));
  const graph = await extractDocumentGraph({
    filename: "long.txt", chunks,
    context: { config: { ...defaultGraphConfig, depth: "standard" }, scope: "Synthetic", model: "test-model", apiKey: "mock", useLlm: true, privacyMode: "standard", onUsage: () => {} },
  });
  expect(graph.source).toBe("llm");
  expect(graph.windows).toBe(2); // parsed
  expect(graph.charsRead).toBeLessThan(graph.charsAttempted); // the unparsed window was still read
  expect(graph.charsAttempted).toBe(graph.charsTotal);
});

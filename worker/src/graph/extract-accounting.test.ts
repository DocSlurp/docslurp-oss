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

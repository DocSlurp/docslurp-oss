import { afterEach, expect, it, vi } from "vitest";
import { defaultGraphConfig } from "@docslurp/shared";
import { generateOpenRouterText } from "../lib/ai.js";
import { extractDocumentGraph, normalizeName } from "./extract.js";

vi.mock("../lib/ai.js", () => ({ generateOpenRouterText: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

it("retains non-Latin graph identities and canonically equivalent accented names", async () => {
  vi.mocked(generateOpenRouterText).mockResolvedValue({
    text: JSON.stringify({ entities: [
      { name: "星海研究所", type: "organization", confidence: 1 },
      { name: "月影計画", type: "concept", confidence: 1 },
    ], relationships: [{ subject: "星海研究所", predicate: "運営する", object: "月影計画", confidence: 1 }] }),
    finishReason: "stop", usage: { inputTokens: 10, outputTokens: 20 },
  });
  const graph = await extractDocumentGraph({ filename: "source.txt", chunks: [{ id: "page", text: "星海研究所は月影計画を運営する。" }], context: {
    config: defaultGraphConfig, scope: "Workspace documents", model: "test-model", apiKey: "mock", useLlm: true, privacyMode: "standard", onUsage: () => {},
  } });
  expect(graph.nodes.map(node => node.canonicalName)).toEqual(["星海研究所", "月影計画"]);
  expect(graph.edges.some(edge => edge.sourceKey.startsWith("星海研究所\0") && edge.targetKey.startsWith("月影計画\0") && edge.normalizedPredicate === "運営する")).toBe(true);
  expect(normalizeName("Étoile")).toBe(normalizeName("E\u0301toile"));
  expect(normalizeName("Étoile")).not.toBe(normalizeName("toile"));
});

it("does not assign a short Latin name to unrelated words in another chunk", async () => {
  vi.mocked(generateOpenRouterText).mockResolvedValue({
    text: JSON.stringify({ entities: [{ name: "Art", type: "person", confidence: 1 }], relationships: [] }),
    finishReason: "stop", usage: { inputTokens: 10, outputTokens: 20 },
  });
  const graph = await extractDocumentGraph({ filename: "source.txt", chunks: [
    { id: "person", text: "Art reviewed the report." },
    { id: "unrelated", text: "The quarterly department chart is attached." },
    { id: "possessive", text: "Art's review is complete." },
  ], context: { config: defaultGraphConfig, scope: "Workspace documents", model: "test-model", apiKey: "mock", useLlm: true, privacyMode: "standard", onUsage: () => {} } });
  expect(graph.chunkEntities.map(mention => mention.chunkId)).toEqual(["person", "possessive"]);
});

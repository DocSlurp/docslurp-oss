import { afterEach, expect, it, vi } from "vitest";
import { defaultGraphConfig } from "@docslurp/shared";
import { generateOpenRouterText } from "../lib/ai.js";
import { extractDocumentGraph } from "./extract.js";

vi.mock("../lib/ai.js", () => ({ generateOpenRouterText: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

async function graphFor(relationships: Array<{ subject: string; predicate: string; object: string }>) {
  vi.mocked(generateOpenRouterText).mockResolvedValue({
    text: JSON.stringify({
      entities: [
        { name: "Alpha Labs", type: "organization", confidence: 1 },
        { name: "Beta Works", type: "organization", confidence: 1 },
      ],
      relationships: relationships.map((relationship) => ({ ...relationship, confidence: 1 })),
    }),
    finishReason: "stop", usage: { inputTokens: 10, outputTokens: 20 },
  });
  return extractDocumentGraph({
    filename: "source.txt",
    chunks: [{ id: "c1", text: "Alpha Labs and Beta Works appear together." }],
    context: { config: defaultGraphConfig, scope: "Workspace documents", model: "test-model", apiKey: "mock", useLlm: true, privacyMode: "standard", onUsage: () => {} },
  });
}

const directed = (graph: Awaited<ReturnType<typeof graphFor>>) =>
  graph.edges.filter((edge) => edge.normalizedPredicate !== "co_mentions" && edge.normalizedPredicate !== "comentions");

it("keeps a qualified predicate distinct from the unqualified relation and preserves direction", async () => {
  const graph = await graphFor([
    { subject: "Alpha Labs", predicate: "proposed to acquire", object: "Beta Works" },
    { subject: "Beta Works", predicate: "does not supply", object: "Alpha Labs" },
  ]);
  const edges = directed(graph).map((edge) => [edge.sourceKey.split("\0")[0], edge.normalizedPredicate, edge.targetKey.split("\0")[0]]);
  expect(edges).toEqual(expect.arrayContaining([
    ["alpha labs", "proposed_to_acquire", "beta works"],
    ["beta works", "does_not_supply", "alpha labs"],
  ]));
  expect(edges).toHaveLength(2);
});

it("collapses predicate whitespace so equivalent qualified phrasings share one edge", async () => {
  const graph = await graphFor([
    { subject: "Alpha Labs", predicate: "may  fund", object: "Beta Works" },
    { subject: "Alpha Labs", predicate: " may\tfund ", object: "Beta Works" },
  ]);
  const edges = directed(graph);
  expect(edges).toHaveLength(1);
  expect(edges[0]).toMatchObject({ predicate: "may fund", normalizedPredicate: "may_fund", weight: 1 });
});

it("preserves a long qualified predicate whole", async () => {
  const qualified = "would acquire a controlling stake only if regulators approve the transfer and financing is confirmed by both parties";
  const graph = await graphFor([{ subject: "Alpha Labs", predicate: qualified, object: "Beta Works" }]);
  expect(directed(graph).map((edge) => edge.predicate)).toEqual([qualified]);
});

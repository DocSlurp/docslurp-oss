import { describe, expect, it } from "vitest";

import { evaluateParserPolicy } from "../lib/parser-policy.js";

describe("evaluateParserPolicy", () => {
  it("keeps observation-only benchmark candidates out of production selection", () => {
    const decision = evaluateParserPolicy({
      primaryExtractor: "primary",
      candidates: [
        {
          extractor: "primary",
          markdown: "short production text",
          latencyMs: 10,
          eligibleForSelection: true,
        },
        {
          extractor: "shadow",
          markdown: "much longer shadow output ".repeat(100),
          latencyMs: 100,
          eligibleForSelection: false,
        },
      ],
    });

    expect(decision.selectedExtractor).toBe("primary");
    expect(decision.observations).toHaveLength(2);
    expect(decision.observations[1]).toMatchObject({
      extractor: "shadow",
      eligibleForSelection: false,
      selected: false,
    });
  });

  it("matches production consensus and divergence behavior", () => {
    const consensus = evaluateParserPolicy({
      primaryExtractor: "primary",
      candidates: [
        {
          extractor: "primary",
          markdown: "The same document content appears here.",
          latencyMs: 1,
          eligibleForSelection: true,
        },
        {
          extractor: "secondary",
          markdown: "The same document content appears here!",
          latencyMs: 1,
          eligibleForSelection: true,
        },
      ],
    });
    expect(consensus).toMatchObject({
      selectedExtractor: "primary",
      strategy: "consensus",
      needsEscalation: false,
    });

    const divergent = evaluateParserPolicy({
      primaryExtractor: "primary",
      candidates: [
        {
          extractor: "primary",
          markdown: "tiny",
          latencyMs: 1,
          eligibleForSelection: true,
        },
        {
          extractor: "secondary",
          markdown: "A completely different and longer extraction result.",
          latencyMs: 1,
          eligibleForSelection: true,
        },
      ],
    });
    expect(divergent).toMatchObject({
      selectedExtractor: "primary",
      strategy: "divergent",
      needsEscalation: true,
    });
  });

  it("does not treat more characters as calibrated quality", () => {
    const decision = evaluateParserPolicy({
      primaryExtractor: "primary",
      candidates: [
        {
          extractor: "primary",
          markdown: "Grounded primary extraction.",
          latencyMs: 5,
          eligibleForSelection: true,
        },
        {
          extractor: "secondary",
          markdown: "Unrelated hallucinated output. ".repeat(1_000),
          latencyMs: 50,
          eligibleForSelection: true,
        },
      ],
    });

    expect(decision.selectedExtractor).toBe("primary");
    expect(decision.needsEscalation).toBe(true);
  });

  it("removes data URIs before scoring and returning content", () => {
    const payload = "A".repeat(4_000);
    const decision = evaluateParserPolicy({
      primaryExtractor: "primary",
      candidates: [
        {
          extractor: "primary",
          markdown: `![scan](data:image/png;base64,${payload})\nReal text`,
          latencyMs: 1,
          eligibleForSelection: true,
        },
      ],
    });

    expect(decision.selectedMarkdown).not.toContain(payload);
    expect(decision.selectedMarkdown).toContain("artifact://externalized-data-uri");
    expect(decision.observations[0]!.strippedDataUriBytes).toBeGreaterThan(4_000);
    expect(decision.observations[0]!.charCount).toBeLessThan(100);
  });
});

import { describe, expect, it } from "vitest";

import { evaluateParserPolicy, tokenSimilarity } from "../lib/parser-policy.js";

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
          markdown: "Quarterly revenue grew while operating margins narrowed across every region.",
          latencyMs: 1,
          eligibleForSelection: true,
        },
        {
          extractor: "secondary",
          markdown: "A completely different and longer extraction result about something else entirely.",
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

  const candidate = (extractor: string, markdown: string) => ({ extractor, markdown, latencyMs: 1, eligibleForSelection: true });

  it("never selects an empty or near-empty candidate while another has text", () => {
    for (const empty of ["", "  \n", "12"]) {
      const decision = evaluateParserPolicy({
        primaryExtractor: "primary",
        candidates: [candidate("primary", empty), candidate("secondary", "The real extracted text of the page is here in full.")],
      });
      expect(decision.selectedExtractor).toBe("secondary");
      expect(decision.strategy).toBe("divergent");
      expect(decision.needsEscalation).toBe(true);
    }
  });

  it("agrees when both parsers return nothing (a blank or scanned document)", () => {
    const decision = evaluateParserPolicy({ primaryExtractor: "primary", candidates: [candidate("primary", ""), candidate("secondary", "")] });
    expect(decision).toMatchObject({ strategy: "consensus", needsEscalation: false, selectedExtractor: "primary" });
  });

  it("does not call unrelated documents consensus just because they share letters", () => {
    const contract = "The tenant shall pay the rent on the first day of each month and the landlord shall maintain the premises in good repair.";
    const recipe = "Whisk the eggs and the sugar until the mixture is pale, then fold in the flour and bake the cake for forty minutes.";
    expect(tokenSimilarity(contract, recipe)).toBeLessThan(0.45);
    const decision = evaluateParserPolicy({ primaryExtractor: "primary", candidates: [candidate("primary", contract), candidate("secondary", recipe)] });
    expect(decision.strategy).toBe("divergent");
  });

  it("is order independent, so a layout difference alone is consensus", () => {
    const a = "Total due 1,200 euros. Payment terms thirty days. Signed by the supplier and the buyer.";
    const b = "Signed by the supplier and the buyer. Total due 1,200 euros. Payment terms thirty days.";
    expect(tokenSimilarity(a, b)).toBe(1);
    expect(evaluateParserPolicy({ primaryExtractor: "primary", candidates: [candidate("primary", a), candidate("secondary", b)] }).strategy).toBe("consensus");
  });

  it("flags a candidate that dropped most of the text even when the words it kept match", () => {
    const full = Array.from({ length: 60 }, (_, index) => `sentence${index % 6} about contract term`).join(". ");
    const truncated = full.slice(0, Math.floor(full.length * 0.3));
    const decision = evaluateParserPolicy({ primaryExtractor: "primary", candidates: [candidate("primary", full), candidate("secondary", truncated)] });
    expect(decision.lengthRatio).toBeLessThan(0.5);
    expect(decision.strategy).toBe("divergent");
  });

  it("flags a page where one parser lost the text of an otherwise matching document", () => {
    const page = (n: number) => Array.from({ length: 30 }, (_, index) => `word${n}x${index}`).join(" ");
    const pages = Array.from({ length: 10 }, (_, index) => page(index));
    const lossy = [...pages];
    lossy[4] = "";
    const decision = evaluateParserPolicy({
      primaryExtractor: "primary",
      candidates: [candidate("primary", pages.join("\f")), candidate("secondary", lossy.join("\f"))],
    });
    expect(decision.similarity).toBeGreaterThan(0.9);
    expect(decision.pageAgreement).toBeCloseTo(0.9, 5);
    expect(decision.strategy).toBe("consensus");

    lossy[5] = "";
    const worse = evaluateParserPolicy({
      primaryExtractor: "primary",
      candidates: [candidate("primary", pages.join("\f")), candidate("secondary", lossy.join("\f"))],
    });
    expect(worse.pageAgreement).toBeCloseTo(0.8, 5);
    expect(worse.strategy).toBe("divergent");
  });

  it("compares Japanese and Russian text by words, not by ASCII", () => {
    const ja = "請求書の支払期限は来月末日です。お支払いは銀行振込でお願いします。";
    const ru = "Москва является столицей России и крупнейшим городом страны.";
    expect(tokenSimilarity(ja, ja)).toBe(1);
    expect(tokenSimilarity(ru, ru.toUpperCase())).toBe(1);
    expect(tokenSimilarity(ja, ru)).toBeLessThan(0.1);
  });
});

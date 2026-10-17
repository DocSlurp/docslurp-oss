import { describe, expect, it } from "vitest";

import { expandEmbeddingQuery, expandQuery, mergeGlossaries, type Glossary } from "../search/synonym.js";

describe("expandQuery", () => {
  it("returns the query unchanged when the glossary is empty", () => {
    expect(expandQuery("machine learning model", {})).toBe("machine learning model");
  });

  it("expands a single matching token", () => {
    const glossary: Glossary = { ml: ["machine learning"] };
    const result = expandQuery("ml model", glossary);
    expect(result).toContain("ml");
    expect(result).toContain("machine learning");
    expect(result).toContain("model");
  });

  it("uses complete OR branches supported by websearch_to_tsquery", () => {
    const glossary: Glossary = { ml: ["machine learning"] };
    const result = expandQuery("ml", glossary);
    expect(result).toBe('"ml" OR "machine learning"');
  });

  it("expands a bigram (two-word token)", () => {
    const glossary: Glossary = { "natural language": ["NLP", "text processing"] };
    const result = expandQuery("natural language processing", glossary);
    expect(result).toContain("NLP");
    expect(result).toContain("natural language");
  });

  it("expands a trigram (three-word token)", () => {
    const glossary: Glossary = {
      "large language model": ["LLM", "foundation model"],
    };
    const result = expandQuery("large language model performance", glossary);
    expect(result).toContain("LLM");
    expect(result).toContain("foundation model");
    expect(result).toContain("performance");
  });

  it("is case-insensitive for glossary keys", () => {
    const glossary: Glossary = { ML: ["machine learning"] };
    const result = expandQuery("ml", glossary);
    expect(result).toContain("machine learning");
  });

  it("is case-insensitive for query tokens", () => {
    const glossary: Glossary = { ml: ["machine learning"] };
    const result = expandQuery("ML model", glossary);
    expect(result).toContain("machine learning");
  });

  it("passes through tokens with no glossary match unchanged", () => {
    const glossary: Glossary = { ml: ["machine learning"] };
    const result = expandQuery("deep learning", glossary);
    expect(result).toBe("deep learning");
  });

  it("handles multiple expansions in a single query", () => {
    const glossary: Glossary = {
      ml: ["machine learning"],
      nn: ["neural network"],
    };
    const result = expandQuery("ml nn", glossary);
    expect(result).toContain("machine learning");
    expect(result).toContain("neural network");
  });

  it("prefers longer n-gram matches over shorter ones", () => {
    const glossary: Glossary = {
      "machine learning": ["ML"],
      machine: ["device"],
    };
    // "machine learning" should match as a bigram, not "machine" + "learning"
    const result = expandQuery("machine learning", glossary);
    expect(result).toContain("ML");
    expect(result).not.toContain("device");
  });

  it("returns empty string for empty query", () => {
    expect(expandQuery("", {})).toBe("");
  });

  it("handles multiple synonyms in the alternatives list", () => {
    const glossary: Glossary = { ai: ["artificial intelligence", "machine intelligence"] };
    const result = expandQuery("ai", glossary);
    expect(result).toContain("artificial intelligence");
    expect(result).toContain("machine intelligence");
  });
});

describe("scoped abbreviation expansion", () => {
  it("preserves the full context in every lexical branch", () => {
    expect(expandQuery("ML admission requirements", { ml: ["machine learning"] }))
      .toBe('"ML" "admission" "requirements" OR "machine learning" "admission" "requirements"');
  });

  it("expands aliases bidirectionally before vector embedding", () => {
    expect(expandEmbeddingQuery("Machine learning requirements", { ML: ["machine learning"] }))
      .toBe("Machine learning requirements\nAliases: Machine learning = ml");
  });

  it("handles punctuation, literal regex characters and long phrases", () => {
    expect(expandEmbeddingQuery("(C++), SSO?", { "C++": ["C plus plus"], SSO: ["single sign on service"] }))
      .toContain("C++ = C plus plus");
    expect(expandEmbeddingQuery("single sign on service access", { SSO: ["single sign on service"] }))
      .toContain("single sign on service = sso");
  });

  it("does not expand codes or infer an unconfigured abbreviation", () => {
    expect(expandEmbeddingQuery("ML-204 / ML.v2 / XYZ", { ML: ["machine learning"] })).toBe("ML-204 / ML.v2 / XYZ");
    expect(expandEmbeddingQuery("Explain ML.", { ML: ["machine learning"] })).toContain("ML = machine learning");
  });

  it("does not pick a sense for shared aliases", () => {
    const glossary = { "master of science": ["MS"], "multiple sclerosis": ["MS"] };
    expect(expandEmbeddingQuery("MS eligibility", glossary)).toBe("MS eligibility");
    expect(expandQuery("MS eligibility", glossary)).toBe("MS eligibility");
  });

  it("overrides workspace entries case-insensitively and supports disabling", () => {
    const merged = mergeGlossaries({ ML: ["machine learning"] }, { ml: ["maximum likelihood"] });
    expect(expandEmbeddingQuery("ML", merged)).toBe("ML\nAliases: ML = maximum likelihood");
    expect(expandEmbeddingQuery("ML", mergeGlossaries(merged, { ML: [] }))).toBe("ML");
  });

  it("leaves explicit websearch syntax intact", () => {
    for (const query of ['ML -admission', 'ML OR physics', '"ML methods"']) {
      expect(expandQuery(query, { ML: ["machine learning"] })).toBe(query);
    }
  });

  it("bounds alternatives and rejects oversized queries", () => {
    const glossary = { ab: Array.from({ length: 30 }, (_, i) => `alias ${i}`) };
    expect(expandQuery("AB requirements", glossary).split(" OR ")).toHaveLength(8);
    const longQuery = "AB ".repeat(3_000);
    expect(expandEmbeddingQuery(longQuery, glossary)).toBe(longQuery);
  });
});

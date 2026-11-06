import { describe, expect, it } from "vitest";

import { expandQuery, type Glossary } from "../search/synonym.js";

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

  it("distributes alternatives into whole websearch queries instead of using parentheses", () => {
    const glossary: Glossary = { ml: ["machine learning"] };
    expect(expandQuery("ml", glossary)).toBe('ml or "machine learning"');
    // websearch_to_tsquery has no grouping and `a b or c` is (a AND b) OR c: every alternative keeps "model".
    expect(expandQuery("ml model", glossary)).toBe('ml model or "machine learning" model');
  });

  it("combines several expansions and caps the number of alternative queries", () => {
    const glossary: Glossary = { ml: ["machine learning"], nn: ["neural network", "net"] };
    expect(expandQuery("ml nn", glossary)).toBe('ml nn or ml "neural network" or ml net or "machine learning" nn or "machine learning" "neural network" or "machine learning" net');
    const wide: Glossary = Object.fromEntries(["a", "b", "c", "d", "e"].map((key) => [key, [`${key}1`, `${key}2`]]));
    const expanded = expandQuery("a b c d e", wide);
    expect(expanded.split(" or ").length).toBeLessThanOrEqual(16);
    expect(expanded.startsWith("a b c d e")).toBe(true);
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

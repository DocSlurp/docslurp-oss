import { describe, expect, it } from "vitest";
import { parsePageLayoutFacts } from "../lib/page-layout-facts.js";

describe("page layout facts: invisible-layer evidence (council #340 C7)", () => {
  it("keeps a valid invisible word count and text-layer kind, drops anything else as unknown", () => {
    const facts = parsePageLayoutFacts({ version: "pdf-layout-facts@1", pages: [
      { pageNumber: 1, known: true, words: 40, invisibleWords: 40, textLayer: "invisible" },
      { pageNumber: 2, known: true, words: 0, invisibleWords: -1, textLayer: "weird" },
      { pageNumber: 3, known: true, words: 5, invisibleWords: 1.5, textLayer: "mixed" },
    ] });
    expect(facts.get(1)).toMatchObject({ words: 40, invisibleWords: 40, textLayer: "invisible" });
    expect(facts.get(2)).not.toHaveProperty("invisibleWords");
    expect(facts.get(2)).not.toHaveProperty("textLayer");
    expect(facts.get(3)).not.toHaveProperty("invisibleWords");
    expect(facts.get(3)?.textLayer).toBe("mixed");
  });
});

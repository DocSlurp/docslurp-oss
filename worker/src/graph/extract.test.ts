import { describe, expect, it } from "vitest";

import { buildExtractionWindows, parseGraphExtraction } from "./extract.js";

describe("buildExtractionWindows", () => {
  it("packs whole chunks into windows up to the size limit", () => {
    expect(buildExtractionWindows(["aaaa", "bbbb", "cccc"], 10, 5)).toEqual(["aaaa\n\nbbbb", "cccc"]);
  });

  it("samples evenly across long documents instead of keeping only the start", () => {
    const chunks = Array.from({ length: 10 }, (_, index) => `chunk-${index}`);
    expect(buildExtractionWindows(chunks, 7, 3)).toEqual(["chunk-0", "chunk-5", "chunk-9"]);
    expect(buildExtractionWindows(chunks, 7, 1)).toEqual(["chunk-0"]);
  });

  it("preserves the tail of oversized chunks and samples their full extent", () => {
    expect(buildExtractionWindows(["aaaabbbbcccc"], 4, 5)).toEqual(["aaaa", "bbbb", "cccc"]);
    expect(buildExtractionWindows(["aaaabbbbccccddddeeee"], 4, 3)).toEqual(["aaaa", "cccc", "eeee"]);
  });

  it("skips blank chunks and returns nothing for empty documents", () => {
    expect(buildExtractionWindows(["", "  "], 100, 4)).toEqual([]);
  });
});

describe("parseGraphExtraction", () => {
  it("keeps the workspace vocabulary and maps unknown types to concept", () => {
    const graph = parseGraphExtraction(
      JSON.stringify({
        entities: [
          { name: "Acme", type: "Supplier", confidence: 0.9 },
          { name: "Net 30", type: "payment term", confidence: 0.8 },
          { name: "Jane", type: "person", confidence: 0.7 },
        ],
        relationships: [{ subject: "Acme", predicate: "offers", object: "Net 30", confidence: 0.6 }],
      }),
      new Set(["supplier", "payment_term", "concept"]),
    );
    expect(graph.entities.map((entity: { type: string }) => entity.type)).toEqual(["supplier", "payment_term", "concept"]);
    expect(graph.relationships).toHaveLength(1);
  });
});

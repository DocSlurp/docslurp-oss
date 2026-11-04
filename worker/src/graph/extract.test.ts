import { describe, expect, it } from "vitest";

import { assembleDocumentGraph, buildExtractionWindows, extractEntitiesFromText, mentionsName, normalizeName, parseGraphExtraction } from "./extract.js";

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

describe("entity names", () => {
  it("keeps names from every script instead of dropping them", () => {
    expect(normalizeName("東京")).toBe("東京");
    expect(normalizeName("Москва")).toBe("москва");
    expect(normalizeName("Zürich")).toBe("zürich");
    expect(normalizeName("القاهرة")).toBe("القاهرة");
  });

  it("composes before comparing, so one name has one key", () => {
    expect(normalizeName("Müller GmbH")).toBe(normalizeName("Müller GmbH"));
    expect(normalizeName("ÉCOLE")).toBe("école");
  });

  it("keeps C, C++ and C# distinct and the dot of .NET and Node.js", () => {
    const keys = ["C", "C++", "C#", ".NET", "NET", "Node.js", "AT&T"].map(normalizeName);
    expect(keys).toEqual(["c", "c++", "c#", ".net", "net", "node.js", "at&t"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("ignores punctuation around a name and apostrophes inside it", () => {
    expect(normalizeName("(Acme, Inc.)")).toBe("acme inc");
    expect(normalizeName("O'Brien")).toBe("obrien");
    expect(normalizeName("Node.js.")).toBe("node.js");
  });
});

describe("mentionsName", () => {
  const fold = (text: string) => text.normalize("NFC").toLowerCase();

  it("matches whole tokens, not substrings", () => {
    expect(mentionsName(fold("The vendor said it would pay"), "AI")).toBe(false);
    expect(mentionsName(fold("Modern AI systems"), "AI")).toBe(true);
    expect(mentionsName(fold("a catalogue of items"), "cat")).toBe(false);
  });

  it("does not let C match C++ or C#", () => {
    expect(mentionsName(fold("We rewrote it in C++ last year"), "C")).toBe(false);
    expect(mentionsName(fold("We rewrote it in C# last year"), "C")).toBe(false);
    expect(mentionsName(fold("We rewrote it in C++ last year"), "C++")).toBe(true);
    expect(mentionsName(fold("Learn C, then C++."), "C")).toBe(true);
    expect(mentionsName(fold("Learn C, then C++."), "C++")).toBe(true);
  });

  it("does not find NET inside .NET or Node inside Node.js", () => {
    expect(mentionsName(fold("Built with ASP.NET Core"), "NET")).toBe(false);
    expect(mentionsName(fold("Built with ASP.NET Core"), "ASP.NET")).toBe(true);
    expect(mentionsName(fold("Runs on Node.js"), "Node")).toBe(false);
  });

  it("matches ideographic names where they appear, since the script has no spaces", () => {
    expect(mentionsName(fold("本社は東京にあります"), "東京")).toBe(true);
    expect(mentionsName(fold("Москва — столица России"), "Москва")).toBe(true);
    expect(mentionsName(fold("Москвариум"), "Москва")).toBe(false);
  });

  it("compares composed and decomposed forms alike", () => {
    expect(mentionsName(fold("Herr Müller zahlt"), "Müller")).toBe(true);
  });
});

describe("heuristic entities", () => {
  const allowed = new Set(["person", "organization", "date", "concept"]);

  it("does not turn every capitalized word into a concept", () => {
    const names = extractEntitiesFromText("The invoice was sent. Payment is due. Yesterday we met.", allowed).map((e) => e.name);
    expect(names).toEqual([]);
  });

  it("finds multi-word names and drops a sentence-initial article", () => {
    const names = extractEntitiesFromText("The Acme Holdings board met. They hired Jane Smith.", allowed).map((e) => e.name);
    expect(names).toContain("Acme Holdings");
    expect(names).toContain("Jane Smith");
    expect(names).not.toContain("The Acme Holdings");
  });

  it("finds organizations by legal form in several languages and Unicode capitals", () => {
    const names = extractEntitiesFromText("Verträge mit Müller Energie GmbH und Ñandú Trading Ltd wurden geprüft.", allowed).map((e) => e.name);
    expect(names).toContain("Müller Energie GmbH");
    expect(names).toContain("Ñandú Trading Ltd");
  });

  it("finds ISO and day-first dates", () => {
    const names = extractEntitiesFromText("Due 2026-04-13, signed 13 April 2026.", allowed).map((e) => e.name);
    expect(names).toContain("2026-04-13");
    expect(names).toContain("13 April 2026");
  });
});

describe("assembleDocumentGraph", () => {
  const allowed = new Set(["person", "location", "technology", "concept"]);
  const chunks = [
    { id: "c1", text: "本社は東京にあります。Москва is the capital. The team said hello." },
    { id: "c2", text: "We rewrote the service in C++ and kept a C helper." },
  ];

  it("keeps CJK and Cyrillic entities, matches whole tokens and keeps C and C++ apart", () => {
    const graph = assembleDocumentGraph({
      chunks,
      allowedTypes: allowed,
      chunkHeuristics: false,
      extraction: {
        entities: [
          { name: "東京", type: "location", confidence: 0.9 },
          { name: "Москва", type: "location", confidence: 0.9 },
          { name: "AI", type: "technology", confidence: 0.9 },
          { name: "C", type: "technology", confidence: 0.9 },
          { name: "C++", type: "technology", confidence: 0.9 },
        ],
        relationships: [{ subject: "東京", predicate: "near", object: "Москва", confidence: 0.7 }],
      },
    });
    expect(graph.nodes.map((node) => node.normalizedName).sort()).toEqual(["c", "c++", "ai", "москва", "東京"].sort());
    const nodeName = (key: string) => graph.nodes.find((node) => node.key === key)!.normalizedName;
    const byChunk = (id: string) => graph.chunkEntities.filter((e) => e.chunkId === id).map((e) => nodeName(e.nodeKey)).sort();
    expect(byChunk("c1")).toEqual(["москва", "東京"]);
    expect(byChunk("c2")).toEqual(["c", "c++"]);
    expect(graph.edges.some((edge) => edge.predicate === "near")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { SearchChunk } from "../services/search.js";
import { distinctEvidence, preserveCompoundEvidence, splitCompoundQuestion, weakerSubquestion } from "./compound-followup.js";

function hit(id: string, page: number | null, text: string): SearchChunk {
  return { id, documentId: "doc", pageNumber: page, pageNumbers: page === null ? [] : [page], score: 1, text } as SearchChunk;
}

describe("compound follow-up", () => {
  const parts: [string, string] = ["What causes glacier retreat", "What measures coastal erosion"];
  it("accepts two explicit parts and ignores a single question or three parts", () => {
    expect(splitCompoundQuestion("What causes glacier retreat, and what measures coastal erosion?")).toEqual([
      "What causes glacier retreat", "what measures coastal erosion",
    ]);
    expect(splitCompoundQuestion("What causes glacier retreat?")).toBeNull();
    expect(splitCompoundQuestion("What causes glacier retreat? What measures coastal erosion? What affects ocean temperatures?")).toBeNull();
  });

  it("replaces a redundant hit while keeping support for both branches", () => {
    const first = hit("a", 1, "Warming causes glacier retreat.");
    const noise = hit("b", 2, "The study began in March.");
    const weak = hit("c", 3, "Coastal erosion is documented.");
    const candidate = hit("d", 4, "A sediment survey measures coastal erosion.");
    expect(weakerSubquestion(parts, [first, noise, weak])).toBe(parts[1]);
    expect(preserveCompoundEvidence(parts, [first, weak, noise], candidate)?.map((chunk) => chunk.id)).toEqual(["a", "c", "d"]);
  });

  it("refuses swaps that lose a branch and excludes ambiguous or duplicate page spans", () => {
    const first = hit("a", 1, "Warming causes glacier retreat.");
    const second = hit("b", 2, "A sediment survey measures coastal erosion.");
    expect(preserveCompoundEvidence(parts, [first, second], hit("c", 3, "The glacier is large."))).toBeNull();
    expect(distinctEvidence(first, hit("d", 1, "Another excerpt."))).toBe(false);
    expect(distinctEvidence(first, hit("e", null, "An unlocated excerpt."))).toBe(false);
  });
});

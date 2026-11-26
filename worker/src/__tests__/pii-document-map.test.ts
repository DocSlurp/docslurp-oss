import { describe, expect, it } from "vitest";

import { documentTitleWithheld, scrubDocumentMap } from "../lib/pii-document-map.js";

const SSN = "123-45-6789";
const matches = (text: string) => text.includes(SSN);

describe("titles and the document map after a PII scan (M3)", () => {
  const map = {
    title: "Jane Roe intake",
    nodes: [
      { id: "n1", title: "Jane Roe intake", physicalStart: 2 },
      { id: "n2", title: "Benefits", physicalStart: 3 },
      { id: "n3", title: `Record ${SSN}`, physicalStart: 4 },
    ],
    terms: [
      { term: "dental", physicalPages: [2, 3] },
      { term: "payroll", physicalPages: [2] },
      { term: SSN, physicalPages: [5] },
    ],
  };

  it("drops nodes and terms from withheld pages or that match, clears the title, rebuilds the search text", () => {
    const out = scrubDocumentMap(map, new Set([2]), matches);
    expect(out.nodes.map((node) => node.id)).toEqual(["n2"]);
    expect(out.terms).toEqual([{ term: "dental", physicalPages: [3] }]);
    expect(out.title).toBeNull();
    expect(out.changed).toBe(true);
    expect(out.searchText).toBe("Benefits \ndental");
    expect(out.searchText).not.toContain(SSN);
  });

  it("a whole-document outcome drops everything; nothing withheld keeps a clean map unchanged", () => {
    expect(scrubDocumentMap(map, "all", matches)).toMatchObject({ nodes: [], terms: [], title: null });
    const clean = { title: "Benefits", nodes: [map.nodes[1]!], terms: [map.terms[0]!] };
    expect(scrubDocumentMap(clean, new Set(), matches).changed).toBe(false);
  });

  it("the derived document title is cleared when it matches or its first pages are withheld", () => {
    expect(documentTitleWithheld(`Claim ${SSN}`, "page-text", new Set(), matches)).toBe(true);
    expect(documentTitleWithheld("Quarterly report", "page-text", new Set([1]), matches)).toBe(true);
    expect(documentTitleWithheld("Quarterly report", "page-text", new Set([7]), matches)).toBe(false);
    expect(documentTitleWithheld("report.pdf", "filename", new Set([1]), matches)).toBe(false);
  });
});

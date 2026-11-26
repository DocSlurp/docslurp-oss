import { describe, expect, it } from "vitest";

import { PII_DETECTOR_VALIDATION, piiPatternTypeSchema } from "../pii.js";
import {
  describePiiCategories,
  isPiiWithheldPlaceholder,
  PII_CATEGORY_LABELS,
  piiCategoryIds,
  piiPlaceholderTypes,
  piiWithheldPageMessage,
  piiWithheldPageText,
  piiWithheldSummary,
  piiWithholding,
  withholdTextPages,
} from "../pii-withholding.js";

const doc = (pii: unknown, status = "completed") => ({ status, metadata: { pii } });

describe("PII categories: stable ids, plain labels", () => {
  it("labels every detector category, and none names a vendor", () => {
    for (const id of piiPatternTypeSchema.options) {
      expect(PII_CATEGORY_LABELS[id], id).toMatch(/^an? [a-zA-Z' ]+$/);
      expect(PII_CATEGORY_LABELS[id]).not.toMatch(/openai|anthropic|github|aws|amazon|stripe|slack|google/i);
      expect(PII_DETECTOR_VALIDATION[id], id).toMatch(/^(checksum|structure|context|format)$/);
    }
  });

  it("describes categories in a stable order, each label once", () => {
    expect(describePiiCategories(["email", "credit-card"])).toBe("a payment card number and an email address");
    expect(describePiiCategories(["openai-api-key", "stripe-api-key", "jwt", "ssn"])).toBe("a Social Security number, an API key and an access token");
    expect(describePiiCategories([])).toBeNull();
    expect(piiCategoryIds(["email", "not-a-category", 7, "email"])).toEqual(["email"]);
    expect(piiCategoryIds("email")).toEqual([]);
  });
});

describe("page placeholder names the kinds of PII, nothing else", () => {
  it("reads back its categories; the pre-types placeholder stays a placeholder", () => {
    const text = piiWithheldPageText(3, ["email", "credit-card"]);
    expect(text).toBe("[Page 3 withheld by the project's privacy policy: contains a payment card number and an email address]");
    expect(isPiiWithheldPlaceholder(text)).toBe(true);
    expect(piiPlaceholderTypes(text)).toEqual(["credit-card", "email"]);
    const legacy = "[Page 3 withheld by the project's privacy policy]";
    expect(piiWithheldPageText(3)).toBe(legacy);
    expect(isPiiWithheldPlaceholder(legacy)).toBe(true);
    expect(piiPlaceholderTypes(legacy)).toEqual([]);
  });

  it("text that only looks like a placeholder is not one (a rescan cannot be tricked into carrying a page)", () => {
    expect(isPiiWithheldPlaceholder("[Page 3 withheld by the project's privacy policy: contains a secret recipe]")).toBe(false);
    expect(piiPlaceholderTypes("[Page 3 withheld by the project's privacy policy: contains 555-0100]")).toBeNull();
    expect(piiPlaceholderTypes("Page 3 is fine")).toBeNull();
  });

  it("withholdTextPages names each page's own categories", () => {
    const out = withholdTextPages("a\fb\fc", new Set([2, 3]), new Map([[2, ["phone" as const]]]));
    expect(out.split("\f")).toEqual(["a", piiWithheldPageText(2, ["phone"]), piiWithheldPageText(3)]);
  });
});

describe("recorded types (documents.metadata.pii.withheldPageTypes)", () => {
  it("reads per-page types for withheld pages only; malformed type data never changes what is withheld", () => {
    const read = piiWithholding(doc({ scope: "pages", withheldPages: [3, 7], patternTypes: ["email", "ssn"], withheldPageTypes: { "3": ["email"], "7": ["ssn", "bogus"], "9": ["phone"], "x": ["email"] } }));
    expect(read).toEqual({ scope: "pages", pages: new Set([3, 7]), pageTypes: new Map([[3, ["email"]], [7, ["ssn"]]]), types: ["ssn", "email"] });
    for (const bad of [null, "email", ["email"], { "3": "email" }, { "3": [1, 2] }]) {
      const withholding = piiWithholding(doc({ scope: "pages", withheldPages: [3], withheldPageTypes: bad }));
      expect(withholding.scope).toBe("pages");
      expect(withholding.scope === "pages" && [...withholding.pages]).toEqual([3]);
      expect(piiWithheldSummary(withholding).pages).toEqual([{ page: 3, types: [], message: "Page 3 withheld for privacy." }]);
    }
  });

  it("a document processed before types were recorded reads with a generic reason", () => {
    const summary = piiWithheldSummary(piiWithholding(doc({ scope: "pages", withheldPages: [2] })));
    expect(summary).toEqual({
      scope: "pages", withheldPages: [2], withheldPageCount: 1, withheldSectionCount: 0, types: [],
      pages: [{ page: 2, types: [], message: "Page 2 withheld for privacy." }],
      message: "1 page withheld for privacy (page 2)",
    });
    const blocked = piiWithheldSummary(piiWithholding({ status: "pii_blocked", metadata: {} }), 2);
    expect(blocked.message).toBe("Document withheld for privacy");
    expect(blocked.types).toEqual([]);
  });

  it("summaries say why in category terms: page numbers and labels only", () => {
    const summary = piiWithheldSummary(piiWithholding(doc({
      scope: "pages", withheldPages: [3, 7], patternTypes: ["credit-card", "email"], withheldPageTypes: { "3": ["credit-card", "email"], "7": ["email"] },
    })));
    expect(summary.pages).toEqual([
      { page: 3, types: [{ id: "credit-card", label: "a payment card number" }, { id: "email", label: "an email address" }], message: "Page 3 withheld: contains a payment card number and an email address." },
      { page: 7, types: [{ id: "email", label: "an email address" }], message: "Page 7 withheld: contains an email address." },
    ]);
    expect(summary.message).toBe("2 pages withheld for privacy (pages 3, 7): contains a payment card number and an email address");
    expect(piiWithheldSummary(piiWithholding(doc({ blocked: true, patternTypes: ["ssn"] }, "pii_blocked")), 2).message)
      .toBe("Document withheld for privacy: contains a Social Security number");
    expect(piiWithheldSummary(piiWithholding(doc({ scope: "sections", withheldSectionCount: 1, patternTypes: ["phone"] }))).message)
      .toBe("1 section withheld for privacy: contains a phone number");
    expect(piiWithheldPageMessage(4, [])).toBe("Page 4 withheld for privacy.");
  });

  it("never carries a confidence, a basis, a match count or matched text into the summary", () => {
    const summary = piiWithheldSummary(piiWithholding(doc({
      scope: "pages", withheldPages: [3], matchCount: 5, patternTypes: ["ssn"], withheldPageTypes: { "3": ["ssn"] },
      // Not a field the worker writes; a summary must not pass it through even if it were present.
      findings: [{ pageNumber: 3, confidence: 0.91, validation: "structure" }],
    })));
    expect(JSON.stringify(summary)).not.toMatch(/confidence|validation|structure|matchCount|0\.91|"5"/);
  });
});

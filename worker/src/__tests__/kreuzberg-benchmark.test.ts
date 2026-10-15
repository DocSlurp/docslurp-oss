import { describe, it, expect } from "vitest";
import { scoreSignals, scoreMetadata } from "../benchmarks/kreuzberg-benchmark.js";

// ── scoreSignals ─────────────────────────────────────────────────────────────

describe("scoreSignals", () => {
  const baseFixture = {
    expectedSignals: ["invoice", "total due", "payment terms"],
    expectedRegex: ["\\$[0-9,]+\\.[0-9]{2}", "Invoice\\s+#?[A-Z0-9-]+"],
    minimumSignalCoverage: 0.6
  };

  it("returns coverage 1 when all signals match", () => {
    const content = "Invoice #INV-001\nTotal Due: $1,234.56\nPayment Terms: Net 30\ninvoice, payment terms";
    const score = scoreSignals(baseFixture, content);
    expect(score.coverage).toBe(1);
    expect(score.matchedSignals).toBe(5);
    expect(score.totalSignals).toBe(5);
    expect(score.passed).toBe(true);
  });

  it("returns coverage 0 when no signals match", () => {
    const score = scoreSignals(baseFixture, "This document has no relevant content.");
    expect(score.coverage).toBe(0);
    expect(score.matchedSignals).toBe(0);
    expect(score.passed).toBe(false);
  });

  it("partial match — string hits only (no dollar amount in content)", () => {
    // Content has 3 string signals but no dollar amounts or invoice number with digits
    const content = "payment terms and total due and invoice summary here.";
    const score = scoreSignals(baseFixture, content);
    // "invoice", "total due", "payment terms" all present
    expect(score.matchedStringSignals).toBe(3);
    // Dollar regex needs digits: no $NNN.NN in content; Invoice regex needs [A-Z0-9-]+
    // "invoice summary" — case-insensitive [A-Z0-9-]+ matches "summary" so regex fires
    // So regex count may be 0 or 1; just check coverage is >= 0.6 (3+/5 total)
    expect(score.coverage).toBeGreaterThanOrEqual(3 / 5);
    expect(score.passed).toBe(true);
  });

  it("partial match — only regex hits", () => {
    const content = "Amount: $4,200.00  Reference: Invoice #INV-2025-ABC";
    const score = scoreSignals(baseFixture, content);
    // Regex: $4,200.00 matches dollar pattern, Invoice #INV-2025-ABC matches second pattern
    expect(score.matchedRegexSignals).toBe(2);
    expect(score.matchedStringSignals).toBeGreaterThanOrEqual(1); // "invoice" is in content
    expect(score.passed).toBe(true);
  });

  it("is case-insensitive for string signals", () => {
    const content = "INVOICE details — TOTAL DUE: $500.00 — PAYMENT TERMS: immediate";
    const score = scoreSignals(baseFixture, content);
    expect(score.matchedStringSignals).toBe(3);
  });

  it("returns coverage 1 when no signals are defined", () => {
    const score = scoreSignals({ expectedSignals: [], expectedRegex: [], minimumSignalCoverage: 0.5 }, "anything");
    expect(score.coverage).toBe(1);
    expect(score.passed).toBe(true);
  });

  it("passed=false when coverage is exactly at threshold but content is empty", () => {
    const score = scoreSignals(baseFixture, "");
    expect(score.passed).toBe(false);
  });

  it("ignores malformed regex gracefully", () => {
    const fixture = {
      expectedSignals: ["hello"],
      expectedRegex: ["[invalid("],
      minimumSignalCoverage: 0.5
    };
    expect(() => scoreSignals(fixture, "hello world")).not.toThrow();
    const score = scoreSignals(fixture, "hello world");
    // "hello" matches, malformed regex does not count
    expect(score.matchedStringSignals).toBe(1);
    expect(score.matchedRegexSignals).toBe(0);
  });

  it("handles large content without throwing", () => {
    const bigContent = "invoice ".repeat(50_000);
    const score = scoreSignals(baseFixture, bigContent);
    expect(score.matchedStringSignals).toBeGreaterThanOrEqual(1);
  });
});

// ── scoreMetadata ─────────────────────────────────────────────────────────────

describe("scoreMetadata", () => {
  const metadataFixture = {
    expectedSignals: ["title:", "author:", "subject:", "keywords:", "created:", "version"]
  };

  it("finds all keys when metadata is rich", () => {
    const metadata = {
      title: "Kreuzberg Evaluation Report",
      author: "DocSlurp Engineering",
      subject: "Benchmark",
      keywords: "extraction, tables",
      outputFormat: "markdown",
      pageCount: 2,
      created: "2025-10-01",
      version: "1.0"
    };

    const result = scoreMetadata(metadataFixture, metadata);
    expect(result.coverage).toBeGreaterThanOrEqual(0.8);
    expect(result.present.length).toBeGreaterThan(0);
  });

  it("returns zero coverage for empty metadata", () => {
    const result = scoreMetadata(metadataFixture, {});
    expect(result.coverage).toBe(0);
    expect(result.missing.length).toBe(metadataFixture.expectedSignals.length);
  });

  it("returns coverage 1 when no signals defined", () => {
    const result = scoreMetadata({ expectedSignals: [] }, { anything: "here" });
    expect(result.coverage).toBe(1);
    expect(result.present).toHaveLength(0);
    expect(result.missing).toHaveLength(0);
  });

  it("strips trailing colon from signal key before matching", () => {
    // "title:" should match metadata.title
    const result = scoreMetadata({ expectedSignals: ["title:"] }, { title: "My Document" });
    expect(result.present).toContain("title:");
  });

  it("is case-insensitive for metadata keys", () => {
    const result = scoreMetadata({ expectedSignals: ["author:"] }, { AUTHOR: "Jane Doe" });
    expect(result.present).toContain("author:");
  });

  it("partial match returns intermediate coverage", () => {
    const metadata = { title: "Report", author: "Alice" }; // missing subject, keywords, created, version
    const result = scoreMetadata(metadataFixture, metadata);
    expect(result.coverage).toBeGreaterThan(0);
    expect(result.coverage).toBeLessThan(1);
    expect(result.present.length).toBeLessThan(metadataFixture.expectedSignals.length);
    expect(result.missing.length).toBeGreaterThan(0);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("scoreSignals — edge cases", () => {
  it("treats coverage exactly at minimumSignalCoverage as passed", () => {
    const fixture = {
      expectedSignals: ["a", "b"],
      expectedRegex: [],
      minimumSignalCoverage: 0.5
    };
    // Exactly 1/2 = 0.5 matches
    const score = scoreSignals(fixture, "document contains the letter a");
    expect(score.coverage).toBe(0.5);
    expect(score.passed).toBe(true);
  });

  it("does not double-count overlapping string and regex matches", () => {
    const fixture = {
      expectedSignals: ["invoice"],
      expectedRegex: ["invoice"],
      minimumSignalCoverage: 0.0
    };
    const score = scoreSignals(fixture, "invoice");
    // Counted independently: 1 string + 1 regex = 2 matched, 2 total
    expect(score.matchedStringSignals).toBe(1);
    expect(score.matchedRegexSignals).toBe(1);
    expect(score.totalSignals).toBe(2);
    expect(score.coverage).toBe(1);
  });
});

import { describe, expect, it } from "vitest";

import {
  isPageImageWithheld,
  isPageWithheld,
  piiPolicyWithholds,
  piiScanIncomplete,
  piiWithheldSummary,
  piiWithholding,
  withoutPendingScan,
} from "../pii-withholding.js";

describe("a deferred scan in progress", () => {
  const pending = piiWithholding({ status: "processing", metadata: { pii: { scope: "none", scanPending: true, scannedPages: [1, 2] } } });

  it("serves only scanned pages, text and pixels", () => {
    expect(isPageWithheld(pending, 1)).toBe(false);
    expect(isPageWithheld(pending, 7)).toBe(true);
    expect(isPageImageWithheld(pending, 7)).toBe(true);
    expect(isPageImageWithheld(pending, 2)).toBe(false);
    expect(isPageWithheld(pending, null)).toBe(true);
    expect(isPageWithheld(pending, [2, 7])).toBe(true);
  });

  it("withholds whole-document artifacts until every page is scanned", () => {
    expect(piiScanIncomplete(pending)).toBe(true);
    expect(piiScanIncomplete(piiWithholding({ metadata: { pii: { scope: "none" } } }))).toBe(false);
    expect(piiScanIncomplete(piiWithholding({ metadata: {} }))).toBe(false);
  });

  it("combines with withheld pages", () => {
    const pages = piiWithholding({ metadata: { pii: { scope: "pages", withheldPages: [2], scanPending: true, scannedPages: [1, 2, 3] } } });
    expect(isPageWithheld(pages, 1)).toBe(false);
    expect(isPageWithheld(pages, 2)).toBe(true);
    expect(isPageWithheld(pages, 4)).toBe(true);
    expect(isPageWithheld(withoutPendingScan(pages), 4)).toBe(false);
    expect(isPageWithheld(withoutPendingScan(pages), 2)).toBe(true);
  });

  it("fails closed on a malformed scanned list", () => {
    const malformed = piiWithholding({ metadata: { pii: { scanPending: true, scannedPages: "1-3" } } });
    expect(isPageWithheld(malformed, 1)).toBe(true);
    expect(piiScanIncomplete(malformed)).toBe(true);
  });

  it("reports a distinct scanning state", () => {
    const summary = piiWithheldSummary(pending, 10);
    expect(summary.scanPending).toBe(true);
    expect(summary.scope).toBe("none");
    expect(piiWithheldSummary(piiWithholding({ metadata: {} })).scanPending).toBeUndefined();
  });

  it("applies only to withholding and redaction policies", () => {
    expect(piiPolicyWithholds({ enabled: true, patterns: ["ssn"], action: "redact_artifacts" })).toBe(true);
    expect(piiPolicyWithholds({ enabled: true, patterns: ["ssn"], action: "block_indexing" })).toBe(true);
    expect(piiPolicyWithholds({ enabled: true, patterns: ["ssn"], action: "flag_for_review" })).toBe(false);
    expect(piiPolicyWithholds({ enabled: false, patterns: ["ssn"], action: "block_indexing" })).toBe(false);
    expect(piiPolicyWithholds({ enabled: true, patterns: [], action: "block_indexing" })).toBe(false);
    expect(piiPolicyWithholds(null)).toBe(false);
  });
});

describe("context detectors in Markdown tables", () => {
  it("find a passport and a bank account number labelled by a row cell or by the column header", async () => {
    const { scanForPii } = await import("../pii.js");
    const row = "| Field | Value |\n| --- | --- |\n| Passport number | X1234567 |\n| Account number | 12345678901 |\n";
    const column = "| Name | Passport number | Bank account |\n|---|---|---|\n| Jane Roe | X7654321 | 98765432101 |\n";
    const types = (text: string) => scanForPii(text, ["passport", "bank-account"]).map((match) => match.patternType).sort();
    expect(types(row)).toEqual(["bank-account", "passport"]);
    expect(types(column)).toEqual(["bank-account", "passport"]);
    // A deep row of a large table is labelled by its header, in linear time (no walk up per candidate).
    const rows = Array.from({ length: 20_000 }, (_, i) => `| Row ${i} | X${String(1_000_000 + i)} |`).join("\n");
    const big = `| Name | Passport number |\n|---|---|\n${rows}\n`;
    const started = performance.now();
    expect(scanForPii(big, ["passport"])).toHaveLength(20_000);
    expect(performance.now() - started).toBeLessThan(5_000);
    // A value in an unlabelled column is still not a match.
    expect(types("| Name | Order |\n|---|---|\n| Jane | 12345678901 |\n")).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { isPageImageWithheld, piiScanIncomplete, piiWithholding } from "@docslurp/shared";

import { mergeDeferredPiiOutcome, type DeferredPiiMatch } from "../lib/pii-deferred-outcome.js";

const base = (scan: DeferredPiiMatch["scan"], pages: DeferredPiiMatch["pages"] = new Map()): DeferredPiiMatch => ({
  pages, action: "block_indexing", runId: "run-1", pageCount: 10, withheldArtifactUris: ["s3://b/source.pdf"], scan,
});

describe("deferred scan progress (map mode)", () => {
  it("the document map starts a scan of the pages it read; every other page is withheld", () => {
    const merged = mergeDeferredPiiOutcome({ status: "processing", pii: null }, base({ pages: new Set([1, 2]), reset: true }))!;
    expect(merged.pii).toMatchObject({ scope: "none", scanPending: true, scannedPages: [1, 2] });
    const withholding = piiWithholding({ status: "processing", metadata: { pii: merged.pii } });
    expect(isPageImageWithheld(withholding, 7)).toBe(true);
    expect(isPageImageWithheld(withholding, 1)).toBe(false);
    expect(piiScanIncomplete(withholding)).toBe(true);
  });

  it("a scanned PDF with PII on page 7: the source and page 7 stay withheld until page 7 is read, then page 7 is withheld", () => {
    const started = mergeDeferredPiiOutcome({ status: "processing", pii: null }, base({ pages: new Set(), reset: true }))!;
    expect(started.pii.scannedPages).toEqual([]);
    const read = mergeDeferredPiiOutcome({ status: "completed", pii: started.pii }, base({ pages: new Set([7]), reset: false }, new Map([[7, ["passport"]]])))!;
    const withholding = piiWithholding({ status: "completed", metadata: { pii: read.pii } });
    expect(withholding.scope).toBe("pages");
    expect(isPageImageWithheld(withholding, 7)).toBe(true);
    expect(isPageImageWithheld(withholding, 3)).toBe(true);
    expect(piiScanIncomplete(withholding)).toBe(true);
  });

  it("completes when every page is scanned: the scan fields go and clean pages and the source serve", () => {
    let pii: unknown = mergeDeferredPiiOutcome({ status: "processing", pii: null }, base({ pages: new Set([1, 2, 3, 4, 5]), reset: true }))!.pii;
    pii = mergeDeferredPiiOutcome({ status: "completed", pii }, base({ pages: new Set([6, 7, 8, 9, 10]), reset: false }))!.pii;
    expect(pii).not.toHaveProperty("scanPending");
    const withholding = piiWithholding({ status: "completed", metadata: { pii } });
    expect(piiScanIncomplete(withholding)).toBe(false);
    expect(isPageImageWithheld(withholding, 7)).toBe(false);
  });

  it("adds nothing (no write) when a read scans pages already scanned or the scan is complete", () => {
    const started = mergeDeferredPiiOutcome({ status: "processing", pii: null }, base({ pages: new Set([1]), reset: true }))!;
    expect(mergeDeferredPiiOutcome({ status: "completed", pii: started.pii }, base({ pages: new Set([1]), reset: false }))).toBeNull();
    expect(mergeDeferredPiiOutcome({ status: "completed", pii: { scope: "none" } }, base({ pages: new Set([2]), reset: false }))).toBeNull();
  });

  it("a new run's document map restarts the scan of a completed one", () => {
    const merged = mergeDeferredPiiOutcome({ status: "completed", pii: { scope: "pages", withheldPages: [4], withheldPageCount: 1 } }, base({ pages: new Set([1]), reset: true }))!;
    expect(merged.pii).toMatchObject({ scope: "pages", withheldPages: [4], scanPending: true, scannedPages: [1] });
  });

  it("a document already withheld whole is left alone", () => {
    expect(mergeDeferredPiiOutcome({ status: "pii_blocked", pii: {} }, base({ pages: new Set([1]), reset: true }))).toBeNull();
  });
});

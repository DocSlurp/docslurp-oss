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

describe("a deferred match scrubs titles and the map and withdraws the summary tree (M2)", () => {
  it("every recordDeferredPiiMatch caller gets them", async () => {
    const { recordDeferredPiiMatch } = await import("../lib/pii-deferred-outcome.js");
    const queries: string[] = [];
    const fake = Object.assign(async (strings: TemplateStringsArray) => {
      const text = strings.join("?");
      queries.push(text);
      if (text.includes("for update of d")) return [{ status: "processing", pii: null, artifacts: {} }];
      if (text.includes("as has_map")) return [{ title: "Report for passport X1234567", title_source: "text", map_title: null, nodes: [{ title: "Page three", physicalStart: 3 }, { title: "Intro", physicalStart: 1 }], terms: [], has_map: true }];
      if (text.includes("select org_id, project_id from documents")) return [{ org_id: "o1", project_id: "p1" }];
      if (text.includes("update document_summary_trees")) return [{ document_id: "doc-1" }];
      return [];
    }, { json: (value: unknown) => value });
    await recordDeferredPiiMatch(fake as never, "doc-1", {
      pages: new Map([[3, ["passport"]]]), action: "block_indexing", runId: "run-1", pageCount: 10, sourceUri: "s3://b/src",
      matches: (text) => text.includes("X1234567"),
    });
    expect(queries.some((q) => q.includes("update documents set metadata = coalesce(metadata, '{}'::jsonb) -"))).toBe(true);
    expect(queries.some((q) => q.includes("update document_maps set nodes"))).toBe(true);
    expect(queries.some((q) => q.includes("update document_summary_trees"))).toBe(true);
  });
});

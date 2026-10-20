import { describe, expect, it } from "vitest";

import { parseFilters } from "../search/filters.js";

// ---------------------------------------------------------------------------
// parseFilters
// ---------------------------------------------------------------------------

describe("parseFilters", () => {
  it("returns an empty filters object for an empty query", () => {
    expect(parseFilters({})).toEqual({});
  });

  it("parses documentId", () => {
    const result = parseFilters({ documentId: "doc-123" });
    expect(result.documentId).toBe("doc-123");
  });

  it("parses runId", () => {
    const result = parseFilters({ runId: "run-456" });
    expect(result.runId).toBe("run-456");
  });

  it("parses workspaceId", () => {
    const result = parseFilters({ workspaceId: "ws-123" });
    expect(result.workspaceId).toBe("ws-123");
  });

  it("parses language", () => {
    const result = parseFilters({ language: "en" });
    expect(result.language).toBe("en");
  });

  it("parses heading by splitting on '/'", () => {
    const result = parseFilters({ heading: "Chapter/Section/Subsection" });
    expect(result.headingPath).toEqual(["Chapter", "Section", "Subsection"]);
  });

  it("filters empty segments from heading path", () => {
    // Leading/trailing slashes produce empty segments that should be removed
    const result = parseFilters({ heading: "/Chapter//Section/" });
    expect(result.headingPath).toEqual(["Chapter", "Section"]);
  });

  it("parses pageFrom and pageTo into a pageRange object", () => {
    const result = parseFilters({ pageFrom: "2", pageTo: "8" });
    expect(result.pageRange).toEqual({ from: 2, to: 8 });
  });

  it("parses pageFrom only", () => {
    const result = parseFilters({ pageFrom: "5" });
    expect(result.pageRange).toEqual({ from: 5, to: undefined });
  });

  it("parses pageTo only", () => {
    const result = parseFilters({ pageTo: "10" });
    expect(result.pageRange).toEqual({ from: undefined, to: 10 });
  });

  it("ignores non-numeric pageFrom", () => {
    const result = parseFilters({ pageFrom: "abc" });
    // NaN is not finite, so it should be omitted from pageRange.from
    expect(result.pageRange?.from).toBeUndefined();
  });

  it("parses dateFrom and dateTo into dateRange", () => {
    const result = parseFilters({ dateFrom: "2024-01-01", dateTo: "2024-12-31" });
    expect(result.dateRange).toEqual({ from: "2024-01-01", to: "2024-12-31" });
  });

  it("parses dateFrom only", () => {
    const result = parseFilters({ dateFrom: "2024-01-01" });
    expect(result.dateRange?.from).toBe("2024-01-01");
    expect(result.dateRange?.to).toBeUndefined();
  });

  it("does not set pageRange when neither pageFrom nor pageTo is present", () => {
    const result = parseFilters({ documentId: "x" });
    expect(result.pageRange).toBeUndefined();
  });

  it("does not set dateRange when neither dateFrom nor dateTo is present", () => {
    const result = parseFilters({ documentId: "x" });
    expect(result.dateRange).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------

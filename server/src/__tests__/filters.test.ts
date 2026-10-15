import { describe, expect, it } from "vitest";

import { buildWhereClause, parseFilters } from "../search/filters.js";

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
// buildWhereClause
// ---------------------------------------------------------------------------

describe("buildWhereClause", () => {
  it("returns '1=1' with no params for empty filters", () => {
    const { sql, params } = buildWhereClause({});
    expect(sql).toBe("1=1");
    expect(params).toEqual([]);
  });

  it("adds document_id condition for documentId filter", () => {
    const { sql, params } = buildWhereClause({ documentId: "doc-1" });
    expect(sql).toContain("document_id");
    expect(params).toContain("doc-1");
  });

  it("uses IN clause for documentIds array", () => {
    const { sql, params } = buildWhereClause({ documentIds: ["doc-1", "doc-2"] });
    expect(sql).toContain("IN");
    expect(params).toContain("doc-1");
    expect(params).toContain("doc-2");
  });

  it("prefers documentIds over documentId when both are provided", () => {
    const { sql, params } = buildWhereClause({
      documentIds: ["doc-a", "doc-b"],
      documentId: "doc-single",
    });
    expect(sql).toContain("IN");
    expect(params).not.toContain("doc-single");
  });

  it("adds run_id condition for runId filter", () => {
    const { sql, params } = buildWhereClause({ runId: "run-999" });
    expect(sql).toContain("run_id");
    expect(params).toContain("run-999");
  });

  it("adds workspace condition for workspaceId filter", () => {
    const { sql, params } = buildWhereClause({ workspaceId: "ws-1" });
    expect(sql).toContain("workspace_id");
    expect(params).toContain("ws-1");
  });

  it("adds BETWEEN condition for full pageRange (from + to)", () => {
    const { sql, params } = buildWhereClause({ pageRange: { from: 2, to: 8 } });
    expect(sql).toContain("BETWEEN");
    expect(params).toContain(2);
    expect(params).toContain(8);
  });

  it("adds >= condition for pageRange with from only", () => {
    const { sql, params } = buildWhereClause({ pageRange: { from: 3 } });
    expect(sql).toContain(">=");
    expect(params).toContain(3);
  });

  it("adds <= condition for pageRange with to only", () => {
    const { sql, params } = buildWhereClause({ pageRange: { to: 5 } });
    expect(sql).toContain("<=");
    expect(params).toContain(5);
  });

  it("adds language condition", () => {
    const { sql, params } = buildWhereClause({ language: "fr" });
    expect(sql).toContain("language");
    expect(params).toContain("fr");
  });

  it("adds headingPath condition using @> operator", () => {
    const { sql, params } = buildWhereClause({ headingPath: ["Chapter", "Section"] });
    expect(sql).toContain("@>");
    expect(params).toContainEqual(["Chapter", "Section"]);
  });

  it("adds BETWEEN condition for full dateRange", () => {
    const { sql, params } = buildWhereClause({
      dateRange: { from: "2024-01-01", to: "2024-12-31" },
    });
    expect(sql).toContain("BETWEEN");
    expect(params).toContain("2024-01-01");
    expect(params).toContain("2024-12-31");
  });

  it("combines multiple filters with AND", () => {
    const { sql } = buildWhereClause({
      documentId: "doc-1",
      language: "en",
    });
    expect(sql).toContain("AND");
  });

  it("uses sequential parameter placeholders ($1, $2, ...)", () => {
    const { sql, params } = buildWhereClause({
      documentId: "doc-1",
      runId: "run-1",
    });
    expect(params).toHaveLength(2);
    expect(sql).toContain("$1");
    expect(sql).toContain("$2");
  });

  it("parameter indices do not repeat or skip", () => {
    const { sql, params } = buildWhereClause({
      documentId: "doc-1",
      runId: "run-1",
      language: "de",
    });
    // Should reference $1, $2, $3 and params should have 3 entries
    expect(params).toHaveLength(3);
    expect(sql).toContain("$1");
    expect(sql).toContain("$2");
    expect(sql).toContain("$3");
  });
});

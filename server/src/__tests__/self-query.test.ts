import { describe, expect, it } from "vitest";

import { deriveSelfQueryFilters, narrowFilters } from "../search/self-query.js";

const base = { privacyMode: "standard" as const, usage: { record: () => undefined } };

describe("deriveSelfQueryFilters", () => {
  it("reads page numbers but guesses no filename or document type from wording", async () => {
    const plan = await deriveSelfQueryFilters({
      ...base,
      query: 'In the "Q4 board deck", what changed on slide 12?',
      baseFilters: { workspaceId: "ws-1" },
    });

    expect(plan.filters.workspaceId).toBe("ws-1");
    expect(plan.filters.pageRange).toEqual({ from: 12, to: 12 });
    expect(plan.filters.filenameContains).toBeUndefined();
    expect(plan.filters.mimeTypes).toBeUndefined();
    expect(plan.reasons.length).toBeGreaterThan(0);
  });

  it.each([
    "how does the image sensor handle low light",
    "what did the CEO say in the meeting",
    "the pdf export is slow, why",
    "explain the csv parser in the spreadsheet module",
    "Wie funktioniert das auf Deutsch, in german please",
  ])("derives no type, filename or language filter from the words of %j", async (query) => {
    const plan = await deriveSelfQueryFilters({ ...base, query, baseFilters: { workspaceId: "ws-1" } });
    expect(plan.filters).toEqual({ workspaceId: "ws-1" });
  });

  it("never replaces or widens what the caller restricted", async () => {
    const plan = await deriveSelfQueryFilters({
      ...base,
      query: 'what did the CEO say in the "board deck" about the spreadsheet on page 4',
      baseFilters: {
        workspaceId: "ws-1", filenameContains: "contract", mimeTypes: ["application/pdf"], documentIds: ["doc-1"],
        runId: "run-1", pageRange: { from: 1, to: 3 },
      },
    });
    expect(plan.filters).toMatchObject({
      workspaceId: "ws-1", filenameContains: "contract", mimeTypes: ["application/pdf"], documentIds: ["doc-1"], runId: "run-1",
    });
    // The derived page 4 lies outside the caller's 1-3: the caller's range stands.
    expect(plan.filters.pageRange).toEqual({ from: 1, to: 3 });
  });
});

describe("narrowFilters", () => {
  it("only narrows: mime types intersect, page ranges intersect, disjoint hints are dropped", () => {
    expect(narrowFilters({ mimeTypes: ["application/pdf", "text/csv"] }, { mimeTypes: ["text/csv", "image/png"] }).mimeTypes).toEqual(["text/csv"]);
    expect(narrowFilters({ mimeTypes: ["application/pdf"] }, { mimeTypes: ["image/png"] }).mimeTypes).toEqual(["application/pdf"]);
    expect(narrowFilters({ pageRange: { from: 2, to: 10 } }, { pageRange: { from: 5, to: 20 } }).pageRange).toEqual({ from: 5, to: 10 });
    expect(narrowFilters({ pageRange: { from: 2, to: 10 } }, { pageRange: { from: 20, to: 30 } }).pageRange).toEqual({ from: 2, to: 10 });
    expect(narrowFilters({ dateRange: { from: "2024-01-01", to: "2024-12-31" } }, { dateRange: { from: "2023-06-01", to: "2024-06-30" } }).dateRange)
      .toEqual({ from: "2024-01-01", to: "2024-06-30" });
  });

  it("keeps every caller scope key untouched", () => {
    const caller = { workspaceId: "ws-1", documentIds: ["a"], filenameEquals: "exact.pdf", tags: ["finance"] };
    const out = narrowFilters(caller, { filenameContains: "x", tags: ["other"], mimeTypes: ["image/png"] });
    expect(out).toMatchObject({ workspaceId: "ws-1", documentIds: ["a"], filenameEquals: "exact.pdf", tags: ["finance"] });
    expect(out.filenameContains).toBeUndefined();
  });

  it("never carries a language filter (nothing writes chunk language metadata, so it matched no rows)", async () => {
    const plan = await deriveSelfQueryFilters({ ...base, query: "terms in german" });
    expect(plan.filters.language).toBeUndefined();
  });
});

it("plans explicit tags without widening caller restrictions or inventing filename filters", async () => {
  const plan = await deriveSelfQueryFilters({ ...base, query: 'find budgets tag:"finance team" tag:FY26' });
  expect(plan.filters.tags).toEqual(["finance team", "FY26"]);
  expect(plan.filters.filenameContains).toBeUndefined();
  const restricted = await deriveSelfQueryFilters({ ...base, query: "find budgets tag:other", baseFilters: { tags: ["finance"] } });
  expect(restricted.filters.tags).toEqual(["finance"]);
});

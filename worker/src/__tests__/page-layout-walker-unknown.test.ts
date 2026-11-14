import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptSandboxedPdfResult, sandboxedPdfLayoutFacts, sandboxedPdfLayoutWalkerUnknown, type SandboxedPdfJob } from "../extractors/plugins.js";
import { pageLayoutWalkerUnknown } from "../lib/page-layout-facts.js";

const page = { pageNumber: 1, known: true, words: 3, tables: [], grids: null, tableCoverage: null, images: null };

describe("layout walker whole-file reasons (walkerUnknown)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads a fixed slug and a bounded page count, and counts any other slug as other", () => {
    for (const reason of ["page-tree-count", "page-tree-shared", "page-tree-kid", "encrypted", "time-budget"]) {
      expect(pageLayoutWalkerUnknown({ version: "pdf-layout-facts@1", pages: [], walkerUnknown: { reason, pages: 12 } }, 20)).toEqual({ reason, pages: 12 });
    }
    expect(pageLayoutWalkerUnknown({ version: "pdf-layout-facts@1", pages: [], walkerUnknown: { reason: "<script>alert(1)</script>", pages: 2 } }))
      .toEqual({ reason: "other", pages: 2 });
    expect(pageLayoutWalkerUnknown({ version: "pdf-layout-facts@1", pages: [], walkerUnknown: { reason: { a: 1 }, pages: 2 } })?.reason).toBe("other");
  });

  it("ignores a missing, malformed or out-of-bounds report", () => {
    const bad: unknown[] = [
      null, "x", { version: "pdf-layout-facts@2", pages: [], walkerUnknown: { reason: "page-tree-count", pages: 1 } },
      { version: "pdf-layout-facts@1", pages: [] },
      { version: "pdf-layout-facts@1", pages: [], walkerUnknown: null },
      { version: "pdf-layout-facts@1", pages: [], walkerUnknown: ["page-tree-count", 1] },
      ...[0, -1, 1.5, 21, "3", Number.NaN, 2 ** 60].map((pages) => ({ version: "pdf-layout-facts@1", pages: [], walkerUnknown: { reason: "page-tree-count", pages } })),
    ];
    for (const payload of bad) expect(pageLayoutWalkerUnknown(payload, 20)).toBeUndefined();
  });

  it("is logged and kept for the job when a provider result reports it, without changing the pages routing reads", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const job: SandboxedPdfJob = { input: "/a", output: "/b" };
    acceptSandboxedPdfResult(job, { exitCode: 0, stdout: "", stderr: "",
      layoutFacts: { version: "pdf-layout-facts@1", pages: [page], walkerUnknown: { reason: "page-tree-shared", pages: 3 } } }, 3);
    expect(sandboxedPdfLayoutWalkerUnknown(job)).toEqual({ reason: "page-tree-shared", pages: 3 });
    expect(sandboxedPdfLayoutFacts(job)?.get(1)).toMatchObject({ words: 3, tables: [] });
    expect(warn.mock.calls.flat().join("\n")).toContain("[vm-pdf] layout walker unknown reason=page-tree-shared pages=3");
    // A later result for the same job without one clears it; nothing from an earlier run leaks into a retry.
    acceptSandboxedPdfResult(job, { exitCode: 0, stdout: "", stderr: "", layoutFacts: { version: "pdf-layout-facts@1", pages: [page] } }, 3);
    expect(sandboxedPdfLayoutWalkerUnknown(job)).toBeUndefined();
  });

  it("never reports more pages than the job has", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const job: SandboxedPdfJob = { input: "/a", output: "/b" };
    acceptSandboxedPdfResult(job, { exitCode: 0, stdout: "", stderr: "",
      layoutFacts: { version: "pdf-layout-facts@1", pages: [page], walkerUnknown: { reason: "page-tree-kid", pages: 4 } } }, 3);
    expect(sandboxedPdfLayoutWalkerUnknown(job)).toBeUndefined();
  });
});

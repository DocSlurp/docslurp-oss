import { describe, expect, it } from "vitest";

import { MAX_LAYOUT_PAGES, collectPageLayoutFacts } from "./page-layout-evidence.js";

const plan = { binary: "true", args: [], available: true };

describe("collectPageLayoutFacts", () => {
  it("refuses a page count it cannot bound without running anything", async () => {
    const calls: string[] = [];
    const runner = new Proxy({}, { get: (_, name) => async () => { calls.push(String(name)); return plan; } }) as never;
    for (const pageCount of [0, -1, 1.5, Number.NaN, MAX_LAYOUT_PAGES + 1]) {
      expect(await collectPageLayoutFacts({ runner, sourcePath: "/x.pdf", pageCount, markdown: "" })).toBeNull();
    }
    expect(calls).toEqual([]);
  });

  it("is null, never invented, when a tool is missing or the walker prints garbage", async () => {
    const runner = (factsStdout: string, wordsAvailable = true) => ({
      listPdfImages: async () => plan,
      pdfWordBoxes: async () => ({ ...plan, available: wordsAvailable }),
      pdfLayoutFacts: async () => plan,
      run: async (p: unknown) => ({ stdout: p === plan ? factsStdout : "", stderr: "" }),
    });
    expect(await collectPageLayoutFacts({ runner: runner("{}", false), sourcePath: "/x.pdf", pageCount: 2, markdown: "" })).toBeNull();
    expect(await collectPageLayoutFacts({ runner: runner("not json"), sourcePath: "/x.pdf", pageCount: 2, markdown: "" })).toBeNull();
    expect(await collectPageLayoutFacts({ runner: runner('{"version":"other","pages":[]}'), sourcePath: "/x.pdf", pageCount: 2, markdown: "" })).toBeNull();
  });
});

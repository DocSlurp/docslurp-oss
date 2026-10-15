import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { splitTextIntoPages } from "@docslurp/shared";
import { buildTestPdf, proseLines, scannedImage } from "../test/make-pdf.js";

const scriptsDir = fileURLToPath(new URL("../../scripts/", import.meta.url));
type InsertPageMarkers = (markdown: string, nodes: unknown, pageCount: number) => string | null;
// The extractor script is plain ESM outside the TypeScript project; load it by path.
const modulePath = path.join(scriptsDir, "kreuzberg_page_markers.mjs");
const { insertPageMarkers } = (await import(modulePath)) as { insertPageMarkers: InsertPageMarkers };

const node = (page: number, text: string, nodeType = "paragraph") => ({ page, content: { node_type: nodeType, text } });

describe("insertPageMarkers", () => {
  it("splits at each page's first node and keeps pages without text as empty sections", () => {
    const markdown = "# Alpha heading text\n\nalpha body sentence here.\n\n# Gamma heading text\n\ngamma body sentence here.";
    const nodes = [
      { page: 1, content: { node_type: "group", heading_text: "Alpha heading text" } },
      node(1, "Alpha heading text", "heading"),
      node(1, "alpha body sentence here."),
      node(3, "Gamma heading text", "heading"),
      node(3, "gamma body sentence here."),
    ];
    const paged = insertPageMarkers(markdown, nodes, 4);
    expect(paged).not.toBeNull();
    expect(splitTextIntoPages(paged!, 4)).toEqual([
      "# Alpha heading text\n\nalpha body sentence here.",
      "",
      "# Gamma heading text\n\ngamma body sentence here.",
      "",
    ]);
  });

  it("starts a page at the line start, never mid-word, and tolerates Markdown escaping", () => {
    const markdown = "Intro line for page one.\n\n**Totals \\& notes** for page two";
    const paged = insertPageMarkers(markdown, [node(1, "Intro line for page one."), node(2, "Totals & notes for page two")], 2);
    expect(paged!.split("\f").map((page) => page.trim())).toEqual(["Intro line for page one.", "**Totals \\& notes** for page two"]);
  });

  it("does not let a text that recurs later pull an earlier page boundary forward", () => {
    const header = "Quarterly operations review";
    const markdown = [
      `${header}\n\nFirst page discusses harbor capacity.`,
      `${header}\n\nSecond page discusses granite supply.`,
      `${header}\n\nThird page discusses willow logistics.`,
    ].join("\n\n");
    const nodes = [1, 2, 3].flatMap((page) => [
      node(page, header),
      node(page, ["First page discusses harbor capacity.", "Second page discusses granite supply.", "Third page discusses willow logistics."][page - 1]!),
    ]);
    const pages = insertPageMarkers(markdown, nodes, 3)!.split("\f").map((page) => page.trim());
    expect(pages[1]).toBe(`${header}\n\nSecond page discusses granite supply.`);
    expect(pages[2]).toBe(`${header}\n\nThird page discusses willow logistics.`);
  });

  it("returns null when the structure does not describe the Markdown", () => {
    expect(insertPageMarkers("completely different text body", [node(1, "unrelated words entirely"), node(2, "more unrelated words")], 2)).toBeNull();
    expect(insertPageMarkers("single page", [node(1, "single page")], 1)).toBeNull();
    expect(insertPageMarkers("text", undefined, 3)).toBeNull();
  });
});

describe("kreuzberg_extract.mjs page boundaries", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("emits one form-feed section per PDF page, with empty sections for raster-only and blank pages", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kreuzberg-pages-"));
    dirs.push(dir);
    const input = path.join(dir, "mixed.pdf");
    const output = path.join(dir, "mixed.md");
    const textPage = (n: number) => ({ kind: "text" as const, heading: `Chapter ${n} overview of the harbor ledger`, lines: proseLines(40, n) });
    await writeFile(input, buildTestPdf([
      textPage(1),
      { kind: "image", images: [{ image: scannedImage() }] },
      textPage(3),
      { kind: "blank" },
      textPage(5),
    ]));
    await promisify(execFile)(process.execPath, [path.join(scriptsDir, "kreuzberg_extract.mjs"), "--input", input, "--output", output], { timeout: 60_000 });
    const pages = splitTextIntoPages(await readFile(output, "utf8"), 5);
    expect(pages).toHaveLength(5);
    expect(pages[0]).toMatch(/^# Chapter 1 overview of the harbor ledger/);
    expect(pages[1]).toBe("");
    expect(pages[2]).toMatch(/^# Chapter 3 overview of the harbor ledger/);
    expect(pages[3]).toBe("");
    expect(pages[4]).toMatch(/^# Chapter 5 overview of the harbor ledger/);
    // Every text line stays on its own page, whole.
    for (const [index, page] of [0, 2, 4].entries()) {
      const lines = proseLines(40, [1, 3, 5][index]!);
      expect(pages[page]!.replace(/\s+/g, " ")).toContain(lines[0]);
      expect(pages[page]!.replace(/\s+/g, " ")).toContain(lines[39]);
    }
  }, 90_000);
});

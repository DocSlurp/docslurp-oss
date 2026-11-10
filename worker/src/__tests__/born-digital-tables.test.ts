import { readFileSync } from "node:fs";
import path from "node:path";

import { repairMarkdownTables, tableReliability } from "@docslurp/shared";
import { describe, expect, it } from "vitest";

import { buildAdaptiveRoutingDecisionSurface, TABLE_UNRELIABLE_SIGNAL } from "../stages/classify-route.js";

/** Doppler's recorded Markdown (pinned commit) for a generated fixture, repaired as extract-markdown repairs it. */
const recorded = (name: string) => repairMarkdownTables(readFileSync(path.resolve("testdata/pdf-fixtures/doppler-md", `${name}.pdf.md`), "utf8"));
const rowsOf = (markdown: string) => markdown.split("\n").filter((line) => /^\|.*\|$/.test(line) && !/^\|\s*-{3}/.test(line))
  .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()));
const route = (text: string) => {
  const surface = buildAdaptiveRoutingDecisionSurface({
    documentId: "d", filename: "d.pdf", text, pageCount: 1, evidence: { source: "canonical-document", artifactUri: "s3://b/c.json" },
    pageImageEvidence: new Map([[1, { pageNumber: 1, wordCount: 120, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0 }]]), routingV2: true,
  });
  if (surface.status !== "ready") throw new Error("not ready");
  return surface.pages[0]!;
};

// Ground truth: what generate-routing-layout-fixtures.py draws (FINANCIAL and the regional table).
const FINANCIAL = [["Account", "2024", "2025", "Change"], ["Revenue", "48,210", "52,934", "+9.8%"], ["Cost of sales", "21,877", "23,015", "+5.2%"],
  ["Gross profit", "26,333", "29,919", "+13.6%"], ["Operating expenses", "15,012", "15,890", "+5.8%"], ["Operating income", "11,321", "14,029", "+23.9%"],
  ["Interest expense", "1,204", "1,187", "-1.4%"], ["Pre-tax income", "10,117", "12,842", "+26.9%"], ["Income tax", "2,529", "3,211", "+27.0%"]];

describe("born-digital tables are served from Doppler (owner policy 2026-11-05)", () => {
  it("a clean financial statement keeps every row and cell, and stays Fast", () => {
    const { markdown, repairs } = recorded("routing-table-clean-financial");
    expect(repairs).toEqual({ mergedHeaders: 0, listsRestored: 0 });
    expect(rowsOf(markdown)).toEqual(FINANCIAL); // 9 rows x 4 cells, all exact
    const page = route(markdown);
    expect(page.route).toBe("table-heavy");
    expect(page.ocrDecision?.authorized ?? false).toBe(false);
  });

  it("a two-line header is merged into one header row; every data cell is kept; it stays Fast", () => {
    const { markdown, repairs } = recorded("routing-table-two-line-header");
    expect(repairs.mergedHeaders).toBe(1);
    const rows = rowsOf(markdown);
    expect(rows[0]).toEqual(["Region", "Revenue Q1", "Revenue Q2", "Margin Q1", "Margin Q2"]);
    expect(rows.slice(1).map((cells) => cells[0])).toEqual(["North", "South", "East", "West", "Central", "Overseas"]);
    expect(rows.slice(1).every((cells) => cells.length === 5 && cells.every(Boolean))).toBe(true);
    expect(rows[1]).toEqual(["North", "1,200", "1,310", "18.0%", "19.2%"]);
    expect(route(markdown).ocrDecision?.authorized ?? false).toBe(false);
  });

  it("a bulleted agenda Doppler laid out as a table is rendered as a list and not escalated", () => {
    const { markdown, repairs } = recorded("routing-table-bullet-list");
    expect(repairs.listsRestored).toBe(1);
    expect(rowsOf(markdown)).toEqual([]);
    expect(markdown).toContain("- Approve the minutes of the last meeting — Chair — 5 min");
    expect(markdown.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(6);
    const page = route(markdown);
    expect(page.route).not.toBe("table-heavy");
    expect(page.ocrDecision?.authorized ?? false).toBe(false);
  });

  it("a table page that stays unreliable after repair is read by a model, with the reasons", () => {
    const broken = ["Quarterly figures", "", "| Region | Q1 | Q2 | Q3 |", "| --- | --- | --- | --- |", "| North | 1,200 |  |  |", "|  |  | 1,310 |  |",
      "| South |  |  | 1,401 |", "|  | 1,287 |  |  |", "| East |  |  |  |", "| West | 9 | 8 |"].join("\n");
    expect(tableReliability(broken).sort()).toEqual(["table:inconsistent-columns", "table:mostly-empty-cells"]);
    const page = route(broken);
    expect(page.route).toBe("table-heavy");
    expect(page.ocrDecision).toMatchObject({ authorized: true, signals: expect.arrayContaining([TABLE_UNRELIABLE_SIGNAL, "table:mostly-empty-cells"]) });
  });

  describe("the VM guest's HTML tables get the same repairs (real-Modal finding F3)", () => {
    /** The streaming converter's `--html` output (Doppler 705d2c7, the guest's mode) for the same fixtures, repaired. */
    const html = (name: string) => repairMarkdownTables(readFileSync(path.resolve("testdata/pdf-fixtures/doppler-md-html", `${name}.pdf.md`), "utf8"));
    const htmlRows = (markdown: string) => [...markdown.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
      .map((row) => [...row[1]!.matchAll(/<t[dh]>([\s\S]*?)<\/t[dh]>/g)].map((cell) => cell[1]!));

    it("a two-line HTML header is merged into one header row; every data cell is kept", () => {
      const { markdown, repairs } = html("routing-table-two-line-header");
      expect(repairs).toEqual({ mergedHeaders: 1, listsRestored: 0 });
      const rows = htmlRows(markdown);
      expect(rows[0]).toEqual(["Region", "Revenue Q1", "Revenue Q2", "Margin Q1", "Margin Q2"]);
      expect(markdown).toContain("<thead>\n<tr><th>Region</th><th>Revenue Q1</th>");
      expect(rows.slice(1).map((cells) => cells[0])).toEqual(["North", "South", "East", "West", "Central", "Overseas"]);
      expect(rows[1]).toEqual(["North", "1,200", "1,310", "18.0%", "19.2%"]);
      expect(tableReliability(markdown)).toEqual([]);
      expect(route(markdown).ocrDecision?.authorized ?? false).toBe(false);
    });

    it("a bulleted agenda laid out as an HTML table is rendered as a list", () => {
      const { markdown, repairs } = html("routing-table-bullet-list");
      expect(repairs).toEqual({ mergedHeaders: 0, listsRestored: 1 });
      expect(markdown).not.toContain("<table");
      expect(markdown).toContain("- Approve the minutes of the last meeting — Chair — 5 min");
      expect(markdown.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(6);
      expect(route(markdown).route).not.toBe("table-heavy");
    });

    it("a clean HTML financial statement is left exactly as extracted", () => {
      const source = readFileSync(path.resolve("testdata/pdf-fixtures/doppler-md-html/routing-table-clean-financial.pdf.md"), "utf8");
      const { markdown, repairs } = repairMarkdownTables(source);
      expect(repairs).toEqual({ mergedHeaders: 0, listsRestored: 0 });
      expect(markdown).toBe(source);
      expect(htmlRows(markdown)).toEqual(FINANCIAL);
      expect(route(markdown).route).toBe("table-heavy");
    });

    it("leaves spanning or marked-up HTML tables alone, escapes what it writes, and judges HTML reliability", () => {
      const spanning = "<table>\n<tr><td></td><td colspan=\"2\">Revenue</td></tr>\n<tr><td>Region</td><td>Q1</td><td>Q2</td></tr>\n<tr><td>North</td><td>1</td><td>2</td></tr>\n<tr><td>South</td><td>3</td><td>4</td></tr>\n</table>";
      expect(repairMarkdownTables(spanning)).toEqual({ markdown: spanning, repairs: { mergedHeaders: 0, listsRestored: 0 } });
      const escaped = "<table>\n<tr><td></td><td>R&amp;D</td><td></td></tr>\n<tr><td>Unit</td><td>Q1</td><td>Q2</td></tr>\n<tr><td>A&lt;B</td><td>1</td><td>2</td></tr>\n<tr><td>C</td><td>3</td><td>4</td></tr>\n</table>";
      const merged = repairMarkdownTables(escaped).markdown;
      expect(merged).toContain("<th>R&amp;D Q1</th><th>R&amp;D Q2</th>");
      expect(merged).toContain("<td>A&lt;B</td>");
      const empty = "<table><tr><td>Region</td><td>Q1</td><td>Q2</td></tr><tr><td>North</td><td></td><td></td></tr><tr><td>South</td><td></td><td></td></tr><tr><td>East</td><td>1</td></tr></table>";
      expect(tableReliability(empty).sort()).toEqual(["table:inconsistent-columns", "table:mostly-empty-cells"]);
      // Page slots stay: repairs work per form-feed page.
      expect(repairMarkdownTables(`a\f${escaped}\f`).markdown.split("\f")).toHaveLength(3);
    });
  });
});

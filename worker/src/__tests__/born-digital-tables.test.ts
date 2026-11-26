import { readFileSync } from "node:fs";
import path from "node:path";

import { repairMarkdownTables, tableLeakPageCap, tableReliability } from "@docslurp/shared";
import { describe, expect, it } from "vitest";

import { encodingRouteFromFlags } from "../lib/doppler-encoding-facts.js";
import { buildAdaptiveRoutingDecisionSurface, classifyAdaptivePage, encodingReadDecision, TABLE_LEAK_CAPPED_SIGNAL, TABLE_LEAK_ONLY_SIGNAL, TABLE_UNRELIABLE_SIGNAL } from "../stages/classify-route.js";
import { legacyPageHints } from "../stages/vision-extract.js";

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

// A bulleted agenda laid out as a table: Doppler's Markdown and streaming HTML for routing-table-bullet-list.pdf before
// d317bea (DocSlurp/doppler#51 keeps bullet lists out of tables). Kept inline so the list repair stays covered.
const AGENDA_ITEMS = [["Approve the minutes of the last meeting", "Chair", "5 min"], ["Review the quarterly survey results", "Planning", "20 min"],
  ["Agree the revised district schedule", "Committee", "15 min"], ["Archive the inspection notes", "Records", "5 min"],
  ["Confirm the next meeting date", "Secretary", "5 min"], ["Any other business", "All", "10 min"]];
const AGENDA_INTRO = "### Agenda\n\nThe committee reviewed the quarterly report and agreed the revised schedule for the district program. Members noted that the field survey was completed on time and that the archive copy\n\n";
const AGENDA_PIPE_TABLE = AGENDA_INTRO + AGENDA_ITEMS.map((cells, i) => `| - | ${cells.join(" | ")} |${i === 0 ? "\n| --- | --- | --- | --- |" : ""}`).join("\n");
const AGENDA_HTML_TABLE = `${AGENDA_INTRO}<table>\n<tbody>\n${AGENDA_ITEMS.map((cells) => `<tr><td>-</td>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("\n")}\n</tbody>\n</table>`;

// Ground truth: what generate-routing-layout-fixtures.py draws (FINANCIAL and the regional table).
const FINANCIAL = [["Account", "2024", "2025", "Change"], ["Revenue", "48,210", "52,934", "+9.8%"], ["Cost of sales", "21,877", "23,015", "+5.2%"],
  ["Gross profit", "26,333", "29,919", "+13.6%"], ["Operating expenses", "15,012", "15,890", "+5.8%"], ["Operating income", "11,321", "14,029", "+23.9%"],
  ["Interest expense", "1,204", "1,187", "-1.4%"], ["Pre-tax income", "10,117", "12,842", "+26.9%"], ["Income tax", "2,529", "3,211", "+27.0%"]];

const routeDocument = (pages: string[]) => {
  const surface = buildAdaptiveRoutingDecisionSurface({
    documentId: "d", filename: "d.pdf", text: pages.join("\f"), pageCount: pages.length, evidence: { source: "canonical-document", artifactUri: "s3://b/c.json" },
    pageImageEvidence: new Map(pages.map((_, i) => [i + 1, { pageNumber: i + 1, wordCount: 120, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0 }])), routingV2: true,
  });
  if (surface.status !== "ready") throw new Error("not ready");
  return surface.pages;
};
const LEAKED_ROWS = ["Bookings by segment", "", "Enterprise 412.5 18.2% 398.1 17.9%", "Mid-market 288.0 12.7% 251.3 11.3%", "Startups 190.4 8.4% 170.2 7.1%"].join("\n");

// Council #338 routing Mediums: leak signals cannot force every page of a document to a paid read.
describe("table-leak reads are capped per document", () => {
  it("a document whose every page carries leaked rows reads only tableLeakPageCap(pages) of them; the rest stay Fast", () => {
    const pages = Array.from({ length: 60 }, (_, i) => `${LEAKED_ROWS}\n\nPage ${i + 1} of the expansion plan.`);
    const routed = routeDocument(pages);
    const read = routed.filter((page) => page.ocrDecision?.authorized);
    expect(read).toHaveLength(tableLeakPageCap(60));
    expect(read.every((page) => page.ocrDecision!.signals.includes(TABLE_LEAK_ONLY_SIGNAL))).toBe(true);
    const capped = routed.filter((page) => !page.ocrDecision?.authorized);
    expect(capped).toHaveLength(60 - tableLeakPageCap(60));
    expect(capped.every((page) => page.signals.includes(TABLE_LEAK_CAPPED_SIGNAL))).toBe(true);
    // The pages read are budgeted by the guard's durable table-rescue purpose.
    expect([...legacyPageHints(routed).tableRescuePages!].sort((a, b) => a - b)).toEqual(read.map((page) => page.pageNumber));
  });

  it("clean prose, letterheads and chart axes stay free under auto", () => {
    const routed = routeDocument([
      "# Acme Expansion Partners\n\nPhone +1 415 555 0100\nFax +1 415 555 0101\nMain +1 415 555 0102\n\nWe are delighted to confirm the London office opening.",
      "Quarterly revenue grew every quarter.\n\nRevenue 0 20 40 60 80 100\nMargin 0 5 10 15 20 25\nGrowth 0 2.5 5.0 7.5 10.0",
      "In 2026, revenue rose 12% to $4.2 billion from $3.8 billion, and margins expanded 3.1 points to 24.5%.",
    ]);
    expect(routed.map((page) => page.ocrDecision?.authorized ?? false)).toEqual([false, false, false]);
  });
});

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

  it("Doppler writes a bulleted agenda as a list, not a table, and it is not escalated", () => {
    // Since d317bea (DocSlurp/doppler#51) the converter itself keeps bullet lists out of tables: nothing is left to repair.
    const { markdown, repairs } = recorded("routing-table-bullet-list");
    expect(repairs).toEqual({ mergedHeaders: 0, listsRestored: 0 });
    expect(rowsOf(markdown)).toEqual([]);
    expect(markdown).toContain("- Approve the minutes of the last meeting Chair 5 min");
    expect(markdown.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(6);
    const page = route(markdown);
    expect(page.route).not.toBe("table-heavy");
    expect(page.ocrDecision?.authorized ?? false).toBe(false);
  });

  it("a bulleted agenda laid out as a table is rendered as a list and not escalated", () => {
    // What Doppler wrote for the same fixture before d317bea; other converters can still write it.
    const { markdown, repairs } = repairMarkdownTables(AGENDA_PIPE_TABLE);
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

    const nativeOnly = buildAdaptiveRoutingDecisionSurface({
      documentId: "doc", filename: "table.pdf", text: broken, pageCount: 1,
      evidence: { source: "canonical-document", artifactUri: "test:table" },
      routingV2: true, tableRescue: false,
    }).pages[0];
    expect(nativeOnly?.route).toBe("table-heavy");
    expect(nativeOnly?.ocrDecision?.authorized ?? false).toBe(false);
  });

  describe("with Doppler's encodings (d317bea): a text-layer table bit is geometry, not the converter's verdict", () => {
    // The page facts describe the words' layout (columns of words aligned on a whitespace gutter), not what the converter
    // wrote: the bulleted agenda is written as a list, and with --math the stacked formulas are written as LaTeX, yet both
    // pages carry `whitespace`. On a prose page the bit adds the table path (a table-heavy route, no read); on a formula
    // page the text's own route wins. Neither ever asks for a read.
    const noRead = { authorized: false, confidence: 0.2, signals: [] };
    it("the bulleted agenda (a list in the Markdown) takes the table path on its whitespace bit, with no read", () => {
      const text = readFileSync(path.resolve("testdata/pdf-fixtures/doppler-md-html/routing-table-bullet-list.pdf.md"), "utf8");
      // The recorded facts for this page: tableBits 8 (whitespace), no math.
      const encodings = encodingRouteFromFlags([], ["whitespace"], false);
      expect(classifyAdaptivePage(1, text, { routingV2: true }).route).not.toBe("table-heavy");
      const page = classifyAdaptivePage(1, text, { routingV2: true, encodings });
      expect(page.route).toBe("table-heavy");
      expect(page.signals).toContain("encoding-table:whitespace");
      expect(encodingReadDecision(noRead, encodings).authorized).toBe(false);
    });
    it("the growth page (display formulas in aligned columns) stays a formula page; the bit is only a signal, with no read", () => {
      // pdftomarkdown --stream --html --math, encoding-tables-math.pdf page 2: formulas, no table.
      const text = ["## Growth model", "", "The quarterly growth rate follows from the ratio of consecutive revenues:", "",
        "$$g_{t}=\\frac{R_{t}-R_{t-1}}{R_{t-1}},\\bar{g}=\\frac{1}{n}\\sum_{t=1}^{n}g_{t},\\sigma^{2}=\\frac{1}{n-1}\\sum_{t=1}^{n}(g_{t}-\\bar{g})^{2}.$$", "",
        "Compounded over a year the rate is", "", "$$G=\\prod_{t=1}^{4}(1+g_{t})-1=\\exp(\\sum_{t=1}^{4}\\ln(1+g_{t}))-1.$$"].join("\n");
      expect(text).not.toContain("<table");
      // The recorded facts for this page: mathBits 3 (text-math, stacked-math), tableBits 8 (whitespace).
      const encodings = encodingRouteFromFlags(["text-math", "stacked-math"], ["whitespace"], true);
      expect(encodings).toMatchObject({ table: "text-layer", math: "text", mathGrid: false });
      const page = classifyAdaptivePage(2, text, { routingV2: true, encodings });
      // The LaTeX the math reader wrote wins over the whitespace bit: the route is the one the text gives without encodings.
      expect(page.route).toBe("formula-heavy");
      expect(page.route).toBe(classifyAdaptivePage(2, text, { routingV2: true }).route);
      expect(page.signals).toContain("encoding-math:text");
      expect(page.signals).not.toContain("encoding-table:whitespace");
      expect(encodingReadDecision(noRead, encodings).authorized).toBe(false);
    });
  });

  describe("the VM guest's HTML tables get the same repairs (real-Modal finding F3)", () => {
    /** The streaming converter's `--html` output (Doppler d317bea, the guest's mode) for the same fixtures, repaired. */
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

    it("the streaming converter writes the bulleted agenda as a list (d317bea): nothing to repair", () => {
      const { markdown, repairs } = html("routing-table-bullet-list");
      expect(repairs).toEqual({ mergedHeaders: 0, listsRestored: 0 });
      expect(markdown).not.toContain("<table");
      expect(markdown.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(6);
      expect(route(markdown).route).not.toBe("table-heavy");
    });

    it("a bulleted agenda laid out as an HTML table is rendered as a list", () => {
      // The streaming converter's HTML for the same fixture before d317bea.
      const { markdown, repairs } = repairMarkdownTables(AGENDA_HTML_TABLE);
      expect(repairs).toEqual({ mergedHeaders: 0, listsRestored: 1 });
      expect(markdown).not.toContain("<table");
      expect(markdown).toContain("- Approve the minutes of the last meeting — Chair — 5 min");
      expect(markdown.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(6);
      expect(route(markdown).route).not.toBe("table-heavy");
    });

    it("keeps all wrapped prose within its original HTML table cell", () => {
      // The VM guest streams HTML for a 3-column, 4-row grid with wrapped text in each cell.
      const source = readFileSync(path.resolve("testdata/pdf-fixtures/doppler-md-html/routing-table-large-coverage.pdf.md"), "utf8");
      const { markdown } = repairMarkdownTables(source);
      const sentence = "Survey area north of the harbour, measured in the spring and checked again in the autumn season by the field team on site. Records kept at the desk.";
      expect(htmlRows(markdown)).toEqual(
        [1, 2, 3, 4].map((row) => [1, 2, 3].map((column) => `Row ${row} column ${column} ${sentence}`)),
      );
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

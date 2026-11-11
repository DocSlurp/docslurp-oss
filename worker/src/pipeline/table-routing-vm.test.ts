import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import { markdownTables, repairMarkdownTables, scanPageTables, TABLE_HTML_UNSCANNED_SIGNAL, tableReliability } from "@docslurp/shared";

import { buildAdaptiveRoutingDecisionSurface } from "../stages/classify-route.js";
import { scanTableRoutingBatch } from "./table-routing-guest.js";
import { repairDocumentTables, scanDocumentTables, validateTableScan } from "./table-routing-vm.js";

/** Run `fn` as the VM guest does: outside the service profile (the guest process has no production host environment). */
function asGuest<T>(fn: () => T): T {
  const saved = { NODE_ENV: process.env.NODE_ENV, DOCSLURP_SERVICE_PROFILE: process.env.DOCSLURP_SERVICE_PROFILE };
  process.env.NODE_ENV = "test";
  delete process.env.DOCSLURP_SERVICE_PROFILE;
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A stand-in for the parser VM: runs the real guest on the job file, as the VM's node does. */
function vmRunner(transform?: (result: unknown[]) => unknown) {
  return {
    run: vi.fn(async (plan: { binary: string; args: string[] }) => {
      expect(plan.binary).toBe("node");
      expect(plan.args[0]).toMatch(/table-routing\.mjs$/);
      const pages = JSON.parse(await readFile(plan.args[1]!, "utf8"));
      const result = asGuest(() => scanTableRoutingBatch(pages));
      await writeFile(plan.args[2]!, JSON.stringify(transform ? transform(result) : result));
      return { stdout: "", stderr: "" };
    }),
  };
}

const production = () => { vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "service"); };
afterEach(() => vi.unstubAllEnvs());

const LIST_TABLE = "<table><tr><td>-</td><td>ALPHA</td></tr><tr><td>-</td><td>BETA</td></tr><tr><td>-</td><td>GAMMA</td></tr></table>";
const RAGGED = "<table><tr><td>A</td><td>B</td></tr><tr><td>X</td></tr></table>";
const SPLIT_HEADER = "<table><tr><th></th><th>Revenue</th><th></th></tr><tr><td>Region</td><td>Q1</td><td>Q2</td></tr><tr><td>North</td><td>1,200</td><td>1,310</td></tr><tr><td>South</td><td>1,287</td><td>&amp;1,401</td></tr></table>";

describe("council recheck H: no host HTML table scan in the service profile", () => {
  it("the shared scanner refuses on the host: repair, reliability and table counts throw rather than parse", () => {
    production();
    for (const call of [() => repairMarkdownTables(LIST_TABLE), () => tableReliability(RAGGED), () => markdownTables(LIST_TABLE), () => scanPageTables(LIST_TABLE)]) {
      expect(call).toThrow(/refusing to scan HTML tables on the host/);
    }
    vi.stubEnv("NODE_ENV", "test"); // service profile alone also refuses
    expect(() => tableReliability(RAGGED)).toThrow(/refusing/);
    // Pages without `<table` need no scan and work on the host.
    expect(tableReliability("Prose only.")).toEqual([]);
    expect(repairMarkdownTables("| - | a |\n| --- | --- |\n| - | b |\n| - | c |").repairs.listsRestored).toBe(1);
  });

  it("the VM scan gives the same repair and routing results the in-process scanner gives", async () => {
    const expected = { repair: repairMarkdownTables(`${LIST_TABLE}\f${SPLIT_HEADER}\fplain`), ragged: tableReliability(RAGGED) };
    production();
    const runner = vmRunner();
    const repaired = await repairDocumentTables(`${LIST_TABLE}\f${SPLIT_HEADER}\fplain`, runner);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect({ markdown: repaired.markdown, repairs: repaired.repairs }).toEqual(expected.repair);
    expect(repaired.markdown.split("\f")[0]).toBe("- ALPHA\n- BETA\n- GAMMA");
    expect(repaired.stats).toMatchObject({ pages: 2, unscanned: 0, vmCalls: 1 });
    const { scans } = await scanDocumentTables([RAGGED], runner);
    expect(tableReliability(RAGGED, undefined, scans[0])).toEqual(expected.ragged);
    expect(expected.ragged).toEqual(["table:inconsistent-columns"]);
  });

  it("sends every page of a document with `<table` to one VM job", async () => {
    production();
    const runner = vmRunner();
    const pages = Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? `Page ${i}\n\n${LIST_TABLE}` : `Page ${i} prose`));
    const { scans, stats } = await scanDocumentTables(pages, runner);
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({ pages: 100, unscanned: 0, vmCalls: 1 });
    expect(scans.filter((scan) => scan === undefined)).toHaveLength(200);
  });
});

describe("fail closed when the VM does not read a page", () => {
  it("unavailable or failing VM: no HTML repair, table:html-unscanned, no HTML table counted; never a host scan", async () => {
    production();
    const markdown = `${LIST_TABLE}\f| - | a |\n| --- | --- |\n| - | b |\n| - | c |`;
    for (const runner of [null, { run: vi.fn().mockRejectedValue(new Error("revoked key")) }, vmRunner((result) => result.slice(1))]) {
      const repaired = await repairDocumentTables(markdown, runner);
      expect(repaired.markdown.split("\f")[0]).toBe(LIST_TABLE);
      expect(repaired.repairs).toEqual({ mergedHeaders: 0, listsRestored: 1 }); // the pipe table only
      expect(repaired.stats.unscanned).toBe(1);
      const { scans } = await scanDocumentTables([RAGGED], runner);
      expect(scans[0]).toBeNull();
      expect(tableReliability(RAGGED, undefined, scans[0])).toEqual([TABLE_HTML_UNSCANNED_SIGNAL]);
      expect(markdownTables(RAGGED, scans[0])).toEqual([]);
    }
  });

  it("routing records the reason and treats an unread table-heavy page conservatively", () => {
    production();
    const heavy = `<table>${Array.from({ length: 8 }, (_, i) => `<tr><td>Region ${i}</td><td>${i}.5</td></tr>`).join("")}</table>`;
    const surface = buildAdaptiveRoutingDecisionSurface({
      documentId: "doc", filename: "report.pdf", text: heavy, pageCount: 1,
      evidence: { source: "markdown-manifest", artifactUri: "s3://bucket/doc.md" },
      tableScans: new Map([[heavy, null]]), routingV2: false,
    });
    expect(surface.status).toBe("ready");
    expect(surface.pages[0]!.signals).toContain(TABLE_HTML_UNSCANNED_SIGNAL);
  });
});

describe("host validation of the guest's scan (a compromised or buggy guest)", () => {
  const page = `Intro\n\n${RAGGED}\n\nOutro`;
  const good = asGuest(() => scanPageTables(page));
  const table = good.tables[0]!;
  const forged: Array<[string, unknown]> = [
    ["not an object", "x"],
    ["span outside the page", { ...good, tables: [{ ...table, end: page.length + 1 }] }],
    ["span not at <table", { ...good, tables: [{ ...table, start: 0 }] }],
    ["span not ending at </table>", { ...good, tables: [{ ...table, end: table.end - 1 }] }],
    ["overlapping spans", { ...good, tables: [table, table] }],
    ["cell text longer than its source", { ...good, tables: [{ ...table, rows: [["x".repeat(page.length)]] }] }],
    ["non-string cell", { ...good, tables: [{ ...table, rows: [[1]] }] }],
    ["simple not boolean", { ...good, tables: [{ ...table, simple: "yes" }] }],
    ["block count mismatch", { ...good, blocks: [] }],
    ["negative counts", { ...good, blocks: [{ rows: -1, columns: 2 }] }],
    // Council round 4 (correctness Low): counts the page's own tag starts cannot hold.
    ["zero block counts for a table with rows", { ...good, blocks: [{ rows: 0, columns: 0 }] }],
    ["inflated block rows", { ...good, blocks: [{ ...good.blocks[0]!, rows: 30 }] }],
    ["inflated block columns", { ...good, blocks: [{ ...good.blocks[0]!, columns: 30 }] }],
    ["more rows than <tr> starts", { ...good, tables: [{ ...table, rows: [...table.rows, ...table.rows] }] }],
    ["more cells than <td>/<th> starts", { ...good, tables: [{ ...table, rows: table.rows.map((row) => [...row, ...row]) }] }],
  ];
  it.each(forged)("refuses %s", async (_name, scan) => {
    expect(() => validateTableScan(page, scan)).toThrow();
    production();
    const { scans, stats } = await scanDocumentTables([page], vmRunner(() => [scan]));
    expect(scans[0]).toBeNull();
    expect(stats.unscanned).toBe(1);
  });
  it("accepts the guest's own scan", () => {
    expect(validateTableScan(page, JSON.parse(JSON.stringify(good)))).toEqual(good);
  });
  it("accepts the guest's own scan on ordinary, spanning, empty and multi-table pages (tag-start bounds hold)", () => {
    for (const text of [
      "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td></tr></table>",
      '<table>\n<tr><td colspan="3">wide</td></tr>\n<tr><td>a</td><td>b</td><td>c</td></tr>\n</table>\n\n<table><tr><td>x</td></tr></table>',
      "<table></table>",
      "<TABLE><TR><TD>x</TD></TR></TABLE>\n\n<table>\n<tr>\n<td>nested <table><tr><td>in</td></tr></table></td>\n</tr>\n</table>",
    ]) {
      const own = asGuest(() => scanPageTables(text));
      expect(validateTableScan(text, JSON.parse(JSON.stringify(own)))).toEqual(own);
    }
  });
  // Documented residual: the host cannot tell an omitted table from none without reading HTML. Under-reporting only
  // removes this page's own repair and reliability signals (fail-safe direction for spend; the uploader's own document).
  it("an under-reported tables list is accepted but cannot add rows, cells or signals", () => {
    expect(validateTableScan(page, { ...good, tables: [] })).toEqual({ ...good, tables: [] });
    expect(tableReliability(page, undefined, { ...good, tables: [] })).toEqual([]);
  });
});

describe("council round 3 L2/L3: guest cell text is escaped on every path into the stored Markdown", () => {
  const hostile = "<table><tr><td>-</td><td>&lt;img src=x onerror=alert(1)&gt;</td></tr><tr><td>-</td><td>[x](javascript:alert(1))</td></tr><tr><td>-</td><td>Z &amp; co</td></tr></table>";
  it("the honest guest: an entity-escaped cell restored as a list never becomes raw HTML or a live link", async () => {
    production();
    const repaired = await repairDocumentTables(`Intro\n\n${hostile}\n\nOutro`, vmRunner());
    expect(repaired.repairs.listsRestored).toBe(1);
    expect(repaired.markdown).not.toMatch(/<img|\]\(javascript/i);
    expect(repaired.markdown).toContain("- &lt;img src\\=x onerror\\=alert\\(1\\)&gt;");
    expect(repaired.markdown).toContain("- Z &amp; co");
  });
  it("a forged guest scan: cell text it fabricates is escaped too", async () => {
    production();
    const page = `Intro\n\n${LIST_TABLE}\n\nOutro`;
    const forge = (result: unknown[]) => (result as Array<{ tables: Array<{ rows: string[][] }> }>).map((scan) => ({
      ...scan, tables: scan.tables.map((table) => ({ ...table, rows: [["-", "FORGED<img src=x onerror=alert(1)>"], ["-", "[x](javascript:alert(1))"], ["-", "Z"]] })),
    }));
    const repaired = await repairDocumentTables(page, vmRunner(forge));
    expect(repaired.repairs.listsRestored).toBe(1);
    expect(repaired.markdown).not.toMatch(/<img|\]\(javascript/i);
    expect(repaired.markdown).toContain("FORGED&lt;img");
  });
});

describe("council round 3 L1: an unclosed <table never hides the prose after it from routing", () => {
  const ragged = "| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n| 3 | 4 | 5 |\n| 6 |\n| 7 | 8 | 9 |\n| x |";
  const code = "```python\ndef f(x):\n    return x * 2\nfor i in range(10):\n    print(f(i))\n```\n\n$$\\int_0^1 x^2 \\, dx = \\frac{1}{3}$$";
  const route = (text: string, scan: "vm" | "unread") => {
    const scans = new Map([[text, scan === "vm" ? asGuest(() => scanPageTables(text)) : null]]);
    const pageImageEvidence = new Map([[1, { wordCount: 60, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0, imagesKnown: true, textLayer: { verdict: "good" as const, reasons: [], source: "text-layer" as const } }]]);
    const surface = buildAdaptiveRoutingDecisionSurface({
      documentId: "d", filename: "r.pdf", text, pageCount: 1, evidence: { source: "markdown-manifest", artifactUri: "s3://bucket/d.md" },
      pageImageEvidence: pageImageEvidence as never, tableScans: scans, routingV2: true,
    });
    const page = surface.pages[0]!;
    return { route: page.route, read: page.ocrDecision?.authorized === true };
  };
  it.each(["vm", "unread"] as const)("routes the same with or without the unclosed tag (%s scan)", (scan) => {
    production();
    const baseline = route(`Notes\n\n${ragged}\n\n${code}`, scan);
    expect(baseline).toEqual({ route: "code-heavy", read: false });
    expect(route(`Notes see <table here\n\n${ragged}\n\n${code}`, scan)).toEqual(baseline);
    expect(route(`Notes see <table>x</table> here\n\n${ragged}\n\n${code}`, scan)).toEqual(baseline);
  });
});

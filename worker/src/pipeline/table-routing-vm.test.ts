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
});

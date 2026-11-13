// Production runs the chart-export guest as one bundled module (dist/chart-export/guest.bundle.mjs, built by
// scripts/bundle-chart-guest.mjs); every other test imports src/. This runs the real guest script on Office, SVG,
// embedded-spec and batch inputs and requires output byte-identical to in-process extraction from src/. CI builds the
// worker before the worker suites, so the bundle must exist there; a local run without a build skips.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractDeterministicVisuals } from "../index.js";
import { barPlot, chartXml, docx, genericBar, linePlot, matplotlibBar, MERMAID_FLOWCHART, pptx, vegaBar, xlsx } from "./fixtures.js";

const run = promisify(execFile);
const workerRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const guestScript = path.join(workerRoot, "scripts/chart-export-extract.mjs");
const built = existsSync(path.join(workerRoot, "dist/chart-export/guest.bundle.mjs"));

if (process.env.CI && !built) throw new Error("CI must build the worker (pnpm --filter @docslurp/worker build) before the worker tests: the chart guest bundle is missing");

const VL = "https://vega.github.io/schema/vega-lite/v5.json";
const vlSpec = { $schema: VL, title: "Sales", data: { values: [{ r: "N", s: 28 }, { r: "S", s: 55 }] }, mark: "bar", encoding: { x: { field: "r", type: "nominal" }, y: { field: "s", type: "quantitative" } } };
const Q = ["Q1", "Q2", "Q3"];

describe.skipIf(!built)("chart-export guest bundle (the production guest)", () => {
  let dir: string;
  beforeAll(async () => { dir = await mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), "chart-guest-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  async function guest(kind: string, files: Array<string | Uint8Array>, extra: Record<string, unknown> = {}): Promise<string> {
    const inputs: string[] = [];
    for (const [k, body] of files.entries()) {
      const file = path.join(dir, `${kind}-${inputs.length}-${k}-${Math.random().toString(36).slice(2)}`);
      await writeFile(file, body);
      inputs.push(file);
    }
    const request = path.join(dir, `request-${Math.random().toString(36).slice(2)}.json`);
    const output = path.join(dir, `output-${Math.random().toString(36).slice(2)}.json`);
    await writeFile(request, JSON.stringify({ kind, ...extra }));
    await run(process.execPath, [guestScript, inputs[0]!, request, output, ...inputs.slice(1)], { cwd: workerRoot });
    return readFile(output, "utf8");
  }

  it("extracts Office charts (XLSX, DOCX, PPTX) exactly as in process", async () => {
    const chart = chartXml({ title: "Revenue", plots: [barPlot([{ name: "A", cats: Q, vals: [1, 2, 3] }, { name: "B", cats: Q, vals: [3, 2, 1] }])] });
    const line = chartXml({ plots: [linePlot([{ name: "L", cats: Q, vals: [5, 6, 7] }])] });
    for (const bytes of [xlsx("S", [["q", "v"], ["Q1", 1], ["Q2", 2], ["Q3", 3]], chart), docx([chart, line]), pptx([[1, chart], [2, line]])]) {
      const got = await guest("office", [bytes]);
      expect(got).toBe(JSON.stringify(extractDeterministicVisuals({ kind: "office", bytes })));
      expect(JSON.parse(got).visuals.length).toBeGreaterThan(0);
    }
  });

  it("extracts SVG charts and diagrams exactly as in process, with and without diagrams", async () => {
    const svgs = [
      matplotlibBar({ categories: Q, series: [{ name: "R", values: [12, 15, 9], color: "#1f77b4" }] }, { vmax: 20, title: "Revenue" }),
      vegaBar(["a", "b", "c"], [1, 2, 3], 4),
      genericBar(["x", "y"], [3, 1], 4),
      MERMAID_FLOWCHART,
      "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>no chart</text></svg>",
      "<svg><unclosed>",
    ];
    // One process per diagrams setting (a batch), then the first SVG on its own (the single-input path).
    for (const diagrams of [true, false]) {
      const got = await guest("svg", svgs, { diagrams, batch: svgs.length });
      expect(got).toBe(JSON.stringify({ schemaVersion: "chart-export-deterministic-batch@v1", results: svgs.map((text) => extractDeterministicVisuals({ kind: "svg", text }, { diagrams })) }));
    }
    expect(await guest("svg", [svgs[0]!])).toBe(JSON.stringify(extractDeterministicVisuals({ kind: "svg", text: svgs[0]! })));
  });

  it("extracts embedded specs from HTML and JSON exactly as in process", async () => {
    const html = `<!doctype html><html><body><div id="vis"></div><script>var spec = ${JSON.stringify(vlSpec)};\nvegaEmbed('#vis', spec);</script>${genericBar(["p", "q"], [1, 2], 4)}</body></html>`;
    expect(await guest("html", [html])).toBe(JSON.stringify(extractDeterministicVisuals({ kind: "html", text: html })));
    const json = JSON.stringify(vlSpec);
    const got = await guest("json", [json]);
    expect(got).toBe(JSON.stringify(extractDeterministicVisuals({ kind: "json", text: json })));
    expect(JSON.parse(got).visuals[0].source).toBe("embedded-spec");
  });

  it("runs an SVG batch one input at a time, exactly as in process", async () => {
    const texts = [genericBar(["a", "b"], [1, 2], 4), "<svg><bad", vegaBar(["c", "d"], [3, 4], 5)];
    const got = await guest("svg", texts, { batch: texts.length });
    const want = texts.map((text) => {
      try {
        return extractDeterministicVisuals({ kind: "svg", text });
      } catch {
        return { schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [{ locator: "svg", reason: "extract-failed" }] };
      }
    });
    expect(got).toBe(JSON.stringify({ schemaVersion: "chart-export-deterministic-batch@v1", results: want }));
  });
});

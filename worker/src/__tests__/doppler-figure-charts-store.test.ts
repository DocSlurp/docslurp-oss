// Council r2 M-a: charts.json is taken out of the figure folder on every path that stores figures, whether or not the
// candidate carries the `charts` flag (#357's early-store and salvage builders do not), so the folder's strict check
// never sees it and the figures are stored with the charts beside them.
import { cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { genericBar } from "../chart-export/extractors/__tests__/fixtures.js";
import { extractDeterministicVisuals } from "../chart-export/extractors/index.js";
import { FIGURE_CHARTS_SCHEMA } from "../chart-export/figure-charts.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "doppler-figures");
const DOC = { id: "0b6f7e8c-3c1a-4f7e-9a51-2a1d3e4f5a6b", userId: "user-1", runId: "run-1", pageCount: 5, sourceSha256: null };
let work: string;
let dir: string;
beforeEach(async () => { work = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "figure-charts-store-")); dir = path.join(work, "figures"); await cp(FIXTURE, dir, { recursive: true }); });
afterEach(async () => { await rm(work, { recursive: true, force: true }); });

function stage() {
  const objects = new Map<string, unknown>();
  const storage = {
    bucket: "bucket",
    putBytes: async (key: string, data: Uint8Array) => { objects.set(key, Buffer.from(data)); },
    putJson: async (key: string, value: unknown) => { objects.set(key, structuredClone(value)); },
    getJson: async (key: string) => {
      const value = objects.get(key);
      return Buffer.isBuffer(value) ? JSON.parse(value.toString("utf8")) : structuredClone(value);
    },
    uri: (key: string) => `s3://bucket/${key}`,
    deleteKeys: async () => {},
  };
  return { objects, stage: new ExtractMarkdownStage({} as never, storage as never, {} as never) as unknown as {
    storeWinningDopplerFiguresOnly(args: unknown): Promise<{ figures: { slots: Array<{ slot: string; uri: string }>; stats: Record<string, unknown> } }>;
  } };
}

const chart = extractDeterministicVisuals({ kind: "svg", text: genericBar(["London", "Tokyo", "Austin"], [4, 6, 9], 10) });
const answer = { schemaVersion: FIGURE_CHARTS_SCHEMA, status: "ok", figures: ["p3.g2"], batch: { schemaVersion: "chart-export-deterministic-batch@v1", results: [chart] } };

describe("figure charts on every store path", () => {
  for (const flagged of [true, false]) {
    it(`stores the figures and the charts with the candidate's charts flag ${flagged ? "set" : "absent (early store, salvage)"}`, async () => {
      await writeFile(path.join(dir, "charts.json"), JSON.stringify(answer));
      const { stage: s, objects } = stage();
      const out = await s.storeWinningDopplerFiguresOnly({
        document: DOC, runId: "run-1", markdown: "", candidate: { figures: { dir, outcome: { status: "extracted" }, ...(flagged ? { charts: true } : {}) } },
      });
      expect(out.figures.stats.status).toBe("stored");
      expect(out.figures.stats.charts).toMatchObject({ status: "ok", figures: 1, visuals: 1 });
      const slot = out.figures.slots.find((x) => x.slot === "doppler-figure-charts");
      expect(slot?.uri).toMatch(/\.charts\.work\.json$/);
      expect([...objects.keys()].some((k) => k.endsWith(".charts.work.json"))).toBe(true);
      expect(await readdir(dir)).not.toContain("charts.json");
    });
  }

  it("a folder with no charts.json and no flag stores the figures and nothing else", async () => {
    const { stage: s } = stage();
    const out = await s.storeWinningDopplerFiguresOnly({ document: DOC, runId: "run-1", markdown: "", candidate: { figures: { dir, outcome: { status: "extracted" } } } });
    expect(out.figures.stats.status).toBe("stored");
    expect(out.figures.stats.charts).toBeUndefined();
    expect(out.figures.slots.some((x) => x.slot === "doppler-figure-charts")).toBe(false);
  });

  it("a malformed charts.json is a charts refusal; the figures stand", async () => {
    await writeFile(path.join(dir, "charts.json"), "{nope");
    const { stage: s } = stage();
    const out = await s.storeWinningDopplerFiguresOnly({ document: DOC, runId: "run-1", markdown: "", candidate: { figures: { dir, outcome: { status: "extracted" } } } });
    expect(out.figures.stats.status).toBe("stored");
    expect(out.figures.stats.charts).toEqual({ status: "refused", reason: "result-invalid" });
  });
});

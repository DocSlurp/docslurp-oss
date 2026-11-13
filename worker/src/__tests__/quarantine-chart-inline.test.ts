import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { defaultPipelineFeatures } from "@docslurp/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { genericBar } from "../chart-export/extractors/__tests__/fixtures.js";
import { extractDeterministicVisuals } from "../chart-export/extractors/index.js";
import type { Config } from "../config.js";
import type { Document, ProjectRun } from "../models.js";
import { type CheckpointStore, WorkflowState } from "../pipeline/pipeline.js";
import { sha256Bytes } from "../sandbox/source-integrity.js";
import { QuarantineStage } from "../stages/quarantine.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";

// Inline chart extraction in the real quarantine stage (in-process inspection, the development path): the answer is
// kept only on accepted documents, only when asked for, and an infected file's answer is dropped with its verdict.
const dirs: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const CHART = genericBar(["London", "Tokyo", "Austin"], [4, 6, 9], 10);
const INFECTED = CHART.replace("</svg>", "<!-- INFECTED --></svg>");

async function fixture(pipeline: Record<string, unknown>, extra: Array<[string, Buffer, string]> = []) {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "development");
  const dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), "quarantine-chart-inline-")); dirs.push(dir);
  const sources = new Map([["chart.svg", Buffer.from(CHART)], ["infected.svg", Buffer.from(INFECTED)], ["notes.pdf", Buffer.from("%PDF-1.7\nexpansion plan\n%%EOF\n")],
    ...extra.map(([name, bytes]) => [name, bytes] as [string, Buffer])]);
  const now = new Date();
  const documents: Document[] = [...sources].map(([filename, bytes]) => ({
    id: filename, userId: "u", runId: "run", filename, mimeType: extra.find(([n]) => n === filename)?.[2] ?? (filename.endsWith(".pdf") ? "application/pdf" : "image/svg+xml"), sourceKey: filename, sourceSha256: sha256Bytes(bytes),
    parseSourceDecision: "unscanned-allowed", status: "queued", extractionMode: "hybrid", pageCount: 1, createdAt: now, updatedAt: now,
    // A provisional intake record (the API's header glance): quarantine's own sniff decides the verified type.
    ...(extra.some(([n]) => n === filename) ? { fileFacts: { inspection: "header", declaredMimeType: extra.find(([n]) => n === filename)![2] } as never } : {}),
  }));
  const run: ProjectRun = { id: "run", orgId: "org-a", projectId: "project", userId: "u", kind: "bulk-upload", status: "processing", stage: "quarantine",
    totalDocuments: documents.length, processedDocuments: 0, pagesTotal: documents.length, pagesProcessed: 0, spentCents: 0,
    pipeline: { ...defaultPipelineFeatures, ...pipeline }, error: null, stats: {}, artifacts: {}, claimId: null, createdAt: now, updatedAt: now };
  const state = WorkflowState.create(run, documents);
  state.store = {
    startDocumentStage: vi.fn(async () => {}), completeDocumentStage: vi.fn(async () => {}), failDocumentStage: vi.fn(async () => {}),
    updateProgress: vi.fn(async () => {}), startRunStage: vi.fn(async () => {}), completeRunStage: vi.fn(async () => {}), failRunStage: vi.fn(async () => {}),
    appendEvent: vi.fn(async () => {}), setPageStageComplete: vi.fn(async () => {}), getCompletedPages: vi.fn(async () => new Set<number>()),
    setDocumentFileFacts: vi.fn(async () => {}), setDocumentParseSource: vi.fn(async () => true),
    // The org's free-VM cap grants every free-tier inline step here (council #387 M2; its refusal is tested in inline.test.ts).
    reserveChartExportFreeVmRun: vi.fn(async () => true),
  } as unknown as CheckpointStore;
  const artifacts = new Map<string, Record<string, unknown>>();
  let sequence = 0;
  const storage = {
    downloadSourceToTempFile: async (key: string) => { const p = join(await mkdtemp(join(dir, "doc-")), `${sequence++}-${key}`); await writeFile(p, sources.get(key)!); return p; },
    putArtifactJson: async (key: string, value: Record<string, unknown>) => { artifacts.set(key.split("/").pop()!.replace(".json", ""), structuredClone(value)); },
    putBytes: async () => {},
    uri: (key: string) => `s3://test/${key}`,
  } as unknown as ArtifactStore;
  const runner = {
    scanForMalware: vi.fn(async (p: string) => ({ status: (await readFile(p, "utf8")).includes("INFECTED") ? "infected" : "clean", engine: "clamdscan", signature: "Test-Signature", databaseStatus: "fresh", healthWarnings: [] })),
    withMalwareScanner: vi.fn(async (_tenant: unknown, fn: () => Promise<unknown>) => await fn()),
  } as unknown as CommandRunner;
  const config = { quarantineEnabled: true, quarantineFailOpenOnToolMissing: false, quarantineMaxArchiveEntries: 10, quarantineMaxArchiveDepth: 3,
    quarantineMaxTotalUncompressedBytes: 1 << 20, quarantineMaxSingleEntryBytes: 1 << 20, quarantineMaxExpansionRatio: 10 } as Config;
  return { state, stage: new QuarantineStage(runner, storage, config), artifacts };
}

describe("quarantine stage: inline chart extraction", () => {
  it("keeps the standalone-equivalent answer on an accepted SVG; nothing on the infected one or the PDF", async () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    vi.stubEnv("DOCSLURP_CHART_EXPORT_INLINE", "1");
    const f = await fixture({ chartExport: { tier: "free" } });
    await f.stage.run(f.state);
    expect(f.state.documentStage("chart.svg", "quarantine")?.status).toBe("completed");
    expect(f.state.documentStage("infected.svg", "quarantine")?.status).toBe("failed");
    const chart = f.artifacts.get("chart.svg")!.chartInline as { kind: string; status: string; result: unknown };
    expect(chart).toMatchObject({ kind: "svg", status: "ok" });
    expect(chart.result).toEqual(extractDeterministicVisuals({ kind: "svg", text: CHART }));
    expect(f.artifacts.get("infected.svg")?.chartInline).toBeUndefined();
    expect(f.artifacts.get("notes.pdf")?.chartInline).toBeUndefined();
    // The ledger signal later stages read without a fetch: only where there is something to export.
    expect(f.state.artifactLedger.readDocument("chart.svg", "chart-inline")).toMatch(/quarantine\/chart\.svg\.json#chart-inline=work$/);
    // Council L3: the inline time is a cost-only event in the run's ledger, scoped to the document, never billable.
    const events = f.state.usageLedger.snapshot().filter((e) => e.metric === "chart-export-vm");
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({ stage: "quarantine", documentId: "chart.svg", reason: "inline", outcome: "ok", billable: false });
    expect(f.state.artifactLedger.readDocument("infected.svg", "chart-inline")).toBeUndefined();
    expect(f.state.artifactLedger.readDocument("notes.pdf", "chart-inline")).toBeUndefined();
  });

  it("drops the answer when the verified type is not the kind it was read as (council r4 L2)", async () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    vi.stubEnv("DOCSLURP_CHART_EXPORT_INLINE", "1");
    // Declared SVG, verified HTML (a page that embeds the chart): the guest read it as `svg`; the stage keeps an answer
    // only for the verified kind.
    const f = await fixture({ chartExport: { tier: "free" } }, [["declared.html", Buffer.from(`<!doctype html><html><body><h1>Expansion</h1>${CHART}</body></html>`), "image/svg+xml"]]);
    await f.stage.run(f.state);
    expect(f.state.documentStage("declared.html", "quarantine")?.status).toBe("completed");
    expect(f.artifacts.get("declared.html")?.chartInline).toBeUndefined();
    expect(f.state.artifactLedger.readDocument("declared.html", "chart-inline")).toBeUndefined();
    const events = f.state.usageLedger.snapshot().filter((e) => e.metric === "chart-export-vm" && (e.metadata as { documentId?: string }).documentId === "declared.html");
    expect(events).toHaveLength(0);
  });

  it("rewrites a stale work slot from an earlier run to none when nothing is asked (council L4)", async () => {
    vi.stubEnv("DOCSLURP_CHART_EXPORT", "on");
    const f = await fixture({ chartExport: { tier: "free" } });
    f.state.artifactLedger.recordDocument("chart.svg", "chart-inline", "s3://test/old/quarantine/chart.svg.json#chart-inline=work");
    await f.stage.run(f.state);
    expect(f.state.artifactLedger.readDocument("chart.svg", "chart-inline")).toMatch(/#chart-inline=none$/);
  });

  it.each([
    ["flag off", { DOCSLURP_CHART_EXPORT: "on" }, { tier: "free" }],
    ["tier off", { DOCSLURP_CHART_EXPORT: "on", DOCSLURP_CHART_EXPORT_INLINE: "1" }, { tier: "off" }],
    ["switch off", { DOCSLURP_CHART_EXPORT: "off", DOCSLURP_CHART_EXPORT_INLINE: "1" }, { tier: "free" }],
  ])("asks for nothing with %s: the inspection runs as before", async (_label, env, chartExport) => {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const f = await fixture({ chartExport });
    await f.stage.run(f.state);
    expect(f.state.documentStage("chart.svg", "quarantine")?.status).toBe("completed");
    expect(f.artifacts.get("chart.svg")?.chartInline).toBeUndefined();
  });
});

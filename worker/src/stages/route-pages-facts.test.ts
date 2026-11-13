/**
 * The v2 page router on Doppler page facts: never opens, renders, clips or byte-scans the PDF on a sandboxed deployment,
 * and falls back to v3 routing (no plan) whenever the facts are missing, malformed or incomplete.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDecisionModelCatalog, defaultPageRouterConfig, routePlanSchema, type PageRouterConfig, type PageRouterMode } from "@docslurp/shared";

const native = vi.hoisted(() => ({
  loadNativePdfEngine: vi.fn(async () => ({ ok: false as const, reason: "test" })),
  loadNativePdfModule: vi.fn(() => ({ ok: false as const, reason: "test" })),
  renderClipNative: vi.fn(async () => ({ bytes: new Uint8Array() })),
  loadProbeBinding: vi.fn(() => ({ ok: false as const, reason: "test" })),
  looksEncrypted: vi.fn(async () => false),
}));
vi.mock("../native-pdf/loader.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadNativePdfEngine: native.loadNativePdfEngine,
  loadNativePdfModule: native.loadNativePdfModule,
}));
vi.mock("../native-pdf/render.js", async (importOriginal) => ({ ...(await importOriginal<object>()), renderClipNative: native.renderClipNative }));
vi.mock("../routing/probe/binding.js", async (importOriginal) => ({ ...(await importOriginal<object>()), loadProbeBinding: native.loadProbeBinding }));
vi.mock("../routing/probe/probe.js", async (importOriginal) => ({ ...(await importOriginal<object>()), looksEncrypted: native.looksEncrypted }));
vi.mock("../pipeline/checkpoints.js", () => ({
  runDocuments: async (documents: unknown[], _concurrency: number, run: (doc: unknown) => Promise<void>) => {
    for (const document of documents) await run(document);
  },
  runDocumentStage: async (...args: unknown[]) => {
    const result = await (args[5] as () => Promise<{ artifactUri?: string }>)();
    (args[0] as WorkflowState).artifactLedger.record(args[3] as string, result.artifactUri);
  },
  runSpentCents: (state: WorkflowState) => state.run.spentCents + state.usageLedger.pendingBillableCents,
  isCostCapExceeded: () => false,
}));

import { WorkflowState } from "../pipeline/pipeline.js";
import type { Config } from "../config.js";
import type { Document, ProjectRun } from "../models.js";
import type { PdfSourceCache } from "../pipeline/pdf-asset-cache.js";
import type { ArtifactStore } from "../tools/storage.js";
import { StorageObjectTooLargeError } from "../tools/storage.js";
import { testCatalog } from "../routing/testing.js";
import { pageInputFromProbeRow } from "../routing/page-input.js";
import { HostPdfRefusedError, sandboxedPdfDeploymentReason } from "../routing/host-pdf-guard.js";
import { ROUTING_PAGE_FACTS_SLOT, createDopplerFactsProbeRunner, routingPageFactsKey } from "../routing/probe/doppler-facts-runner.js";
import { docLine, figurePage, fullFixture, jsonl, runLine, scanPage, textPage } from "../test/doppler-page-facts-fixture.js";
import { RoutePagesStage, type RoutePagesDeps } from "./route-pages.js";

const SANDBOXED = { DOCSLURP_PDF_MODE: "vm", DOCSLURP_DOPPLER_PAGE_FACTS: "use" } as NodeJS.ProcessEnv;
const document = {
  id: "doc", userId: "user", filename: "a.pdf", mimeType: "application/pdf", pageCount: 3, pageCountSource: "counted", sourceKey: "a.pdf",
} as Document;
const FACTS_KEY = routingPageFactsKey("user/run", "doc");

const sources = { get: vi.fn(async () => ({ path: "/tmp/a.pdf", sha256: "x", sizeBytes: 1, cacheHit: true })) } as unknown as PdfSourceCache & {
  get: ReturnType<typeof vi.fn>;
};
const probe = vi.fn(async () => "");
const renderClip = vi.fn(async () => null);
const openNativePdf = vi.fn(async () => null);

function makeStorage(facts: string | Uint8Array | null | Error) {
  return {
    bucket: "bucket",
    putJson: vi.fn(async () => undefined),
    getJson: vi.fn(async () => null),
    getBytes: vi.fn(async (key: string, options?: { maxBytes?: number }) => {
      if (key !== FACTS_KEY || facts === null) throw new Error(`unexpected read ${key}`);
      if (facts instanceof Error) throw facts;
      const bytes = Buffer.from(facts);
      if (options?.maxBytes !== undefined && bytes.byteLength > options.maxBytes) throw new StorageObjectTooLargeError(key, bytes.byteLength, options.maxBytes);
      return bytes;
    }),
    uri: (key: string) => `s3://bucket/${key}`,
  } as unknown as ArtifactStore & { putJson: ReturnType<typeof vi.fn>; getBytes: ReturnType<typeof vi.fn> };
}

function makeState(options: { mode?: PageRouterMode; pageRouter?: Partial<PageRouterConfig>; factsKey?: string | null } = {}) {
  const state = WorkflowState.create({
    id: "run", orgId: "org", spentCents: 0, artifacts: {}, stats: {},
    pipeline: {
      quality: "auto", privacyMode: "standard", maxCostCents: null,
      pageRouter: { ...defaultPageRouterConfig, router: "baseline", marginFloor: 0, ...options.pageRouter, mode: options.mode ?? "shadow" },
    },
  } as unknown as ProjectRun, [document]);
  state.docConcurrency = 1;
  const factsKey = options.factsKey === undefined ? FACTS_KEY : options.factsKey;
  if (factsKey) state.artifactLedger.recordDocument("doc", ROUTING_PAGE_FACTS_SLOT, `s3://bucket/${factsKey}`);
  return state;
}

const decisionModels = buildDecisionModelCatalog({ env: { PERPLEXITYAI_API_KEY: true, OPENROUTER_API_KEY: true } }).models;
const catalog = () => ({ targets: testCatalog(), allTargets: testCatalog(), decisionModels });
const cfg = (mode: PageRouterMode = "shadow") => ({ pageRouterMode: mode }) as Config;

async function route(options: {
  facts: string | Uint8Array | null | Error;
  env?: NodeJS.ProcessEnv;
  mode?: PageRouterMode;
  pageRouter?: Partial<PageRouterConfig>;
  factsKey?: string | null;
  deps?: Partial<RoutePagesDeps>;
}) {
  const storage = makeStorage(options.facts);
  const state = makeState({ mode: options.mode, pageRouter: options.pageRouter, factsKey: options.factsKey });
  await new RoutePagesStage(storage, cfg(options.mode), sources, undefined, {
    probe, catalog, renderClip, openNativePdf, tableGate: "shadow", env: options.env ?? SANDBOXED, ...options.deps,
  }).run(state);
  const plan = storage.putJson.mock.calls[0] ? routePlanSchema.parse(storage.putJson.mock.calls[0][1]) : null;
  const metrics = (name: string) => state.pendingPerformance.filter((e) => e.metric === name);
  return { storage, state, plan, metrics };
}

function expectNoHostPdfAccess() {
  expect(native.loadNativePdfEngine).not.toHaveBeenCalled();
  expect(native.loadNativePdfModule).not.toHaveBeenCalled();
  expect(native.renderClipNative).not.toHaveBeenCalled();
  expect(native.loadProbeBinding).not.toHaveBeenCalled();
  expect(native.looksEncrypted).not.toHaveBeenCalled();
  expect(probe).not.toHaveBeenCalled();
  expect(renderClip).not.toHaveBeenCalled();
  expect(openNativePdf).not.toHaveBeenCalled();
  expect(sources.get).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("sandboxedPdfDeploymentReason", () => {
  it("matches extract-markdown's sandboxed-pdf-deployment and fails closed on an unreadable setting", () => {
    expect(sandboxedPdfDeploymentReason({ DOCSLURP_PDF_MODE: "vm" } as NodeJS.ProcessEnv)).toBe("sandboxed-pdf-deployment");
    expect(sandboxedPdfDeploymentReason({ DOCSLURP_PDF_EXTRACTOR: "vm-pdf" } as NodeJS.ProcessEnv)).toBe("sandboxed-pdf-deployment");
    expect(sandboxedPdfDeploymentReason({ DOCSLURP_VM_PDF_INSTALLED: "1" } as NodeJS.ProcessEnv)).toBe("sandboxed-pdf-deployment");
    expect(sandboxedPdfDeploymentReason({ DOCSLURP_PDF_MODE: "bogus" } as NodeJS.ProcessEnv)).toBe("pdf-setting-unreadable");
    expect(sandboxedPdfDeploymentReason({} as NodeJS.ProcessEnv)).toBeNull();
  });
});

describe("route-pages on a sandboxed deployment", () => {
  it("never loads, renders, clips or scans the PDF on the host, even with image decision models and the table gate on", async () => {
    const { plan, metrics, state } = await route({
      facts: fullFixture(),
      pageRouter: { router: "decision-model", decisionModel: "cloudflare/clef-flash", triageFormat: "per-page" },
    });
    expectNoHostPdfAccess();
    expect(plan).not.toBeNull();
    // The image model needs pixels the host may not render: skipped, the baseline router plans instead.
    expect(plan!.routerKind).not.toBe("decision-model");
    const chunk = metrics("page-route-chunk-estimate")[0]!.metadata as Record<string, unknown>;
    expect(String(chunk.routerNote)).toContain("decision-model-skipped:no-host-pixels:cloudflare/clef-flash");
    expect(chunk.probeSource).toBe("doppler-facts");
    expect(metrics("page-route-host-pdf-refused")).toEqual([]);
    expect(metrics("page-route-error")).toEqual([]);
    expect(state.usageLedger.pendingCount).toBe(0);
  });

  it("without facts mode `use`, writes no plan and never reaches the native probe (v3 routing)", async () => {
    const { plan, metrics } = await route({ facts: fullFixture(), env: { DOCSLURP_PDF_MODE: "vm" } as NodeJS.ProcessEnv });
    expectNoHostPdfAccess();
    expect(plan).toBeNull();
    expect(metrics("page-route-fallback")[0]!.metadata).toMatchObject({ reason: "facts-mode-store", probeSource: "native-probe", sandboxed: "sandboxed-pdf-deployment", fallback: "v3" });
  });

  it("refuses loudly when anything would hand the router a host path (a facts row carrying a thumbnail)", async () => {
    const thumbRunner = vi.fn(async () => ({
      status: "ok" as const, locked: false, pagesKnown: 1, pagesFailed: 0, linesDropped: 0,
      rows: [{ ...(await createDopplerFactsProbeRunner(async () => Buffer.from(fullFixture()))({ documentId: "doc", pageCount: 3 }) as { rows: object[] }).rows[0], thumbnail: "/etc/passwd" }],
    }));
    const { plan, metrics } = await route({ facts: fullFixture(), deps: { factsProbe: thumbRunner as never } });
    expectNoHostPdfAccess();
    expect(plan).toBeNull();
    expect(metrics("page-route-host-pdf-refused")[0]!.metadata).toMatchObject({ operation: "facts-thumbnail", reason: "sandboxed-pdf-deployment" });
    expect(String(metrics("page-route-error")[0]!.metadata!.reason)).toContain("host PDF access refused");
  });

  it("missing facts: no plan, v3 routing, nothing read or charged", async () => {
    const { plan, metrics, state, storage } = await route({ facts: null, factsKey: null });
    expectNoHostPdfAccess();
    expect(storage.getBytes).not.toHaveBeenCalled();
    expect(plan).toBeNull();
    expect(metrics("page-route-fallback")[0]!.metadata).toMatchObject({ reason: "facts-missing", probeSource: "doppler-facts", fallback: "v3" });
    expect(metrics("page-route-decision")).toEqual([]);
    expect(state.usageLedger.pendingCount).toBe(0);
  });

  it("a ledger entry pointing at another key is not read", async () => {
    const { plan, metrics, storage } = await route({ facts: fullFixture(), factsKey: "other-user/run/routing-page-facts/doc.jsonl" });
    expect(storage.getBytes).not.toHaveBeenCalled();
    expect(plan).toBeNull();
    expect(metrics("page-route-fallback")[0]!.metadata).toMatchObject({ reason: "facts-missing" });
  });

  it.each([
    ["no doc line", jsonl([textPage(1), runLine()]), "facts-refused:header"],
    ["garbage", "\u0000\u0001not json at all\n", "facts-refused:header"],
    ["not ASCII", `${JSON.stringify(docLine())}\n{"page":"ÿ"}\n`, "facts-incomplete"],
    ["missing pages", jsonl([docLine(), textPage(1), runLine()]), "facts-incomplete"],
    ["unreadable document", jsonl([docLine({ error: "damaged" })]), "facts-unreadable-document"],
    ["oversized", `${JSON.stringify(docLine())}\n${" ".repeat(400_000)}\n`, "facts-oversized"],
  ])("malformed facts (%s): no plan, v3 routing", async (_name, facts, reason) => {
    const { plan, metrics, state } = await route({ facts });
    expectNoHostPdfAccess();
    expect(plan).toBeNull();
    expect(metrics("page-route-fallback")[0]!.metadata).toMatchObject({ reason, fallback: "v3" });
    expect(state.usageLedger.pendingCount).toBe(0);
  });

  it("a project whose PDF order names vm-pdf is sandboxed even on a host-parsing deployment", async () => {
    const storage = makeStorage(fullFixture());
    const state = makeState();
    (state.run.pipeline as { documentExtraction?: unknown }).documentExtraction = { order: { pdf: ["vm-pdf"] } };
    await new RoutePagesStage(storage, cfg(), sources, undefined, { probe, catalog, renderClip, openNativePdf, tableGate: "shadow", env: {} as NodeJS.ProcessEnv }).run(state);
    expectNoHostPdfAccess();
    expect(storage.putJson).not.toHaveBeenCalled();
    expect(state.pendingPerformance.find((e) => e.metric === "page-route-fallback")!.metadata).toMatchObject({ sandboxed: "sandboxed-pdf-route", reason: "facts-mode-store" });
  });

  it("facts with every page failed are unavailable: v3 decides", async () => {
    const failed = (page: number) => ({ schema: "doppler-page-facts/1", type: "page", page, error: "failed", parseWarnings: [], unusualFeatures: [] });
    const { plan, metrics } = await route({ facts: jsonl([docLine(), failed(1), failed(2), failed(3), runLine()]) });
    expectNoHostPdfAccess();
    expect(plan).toBeNull();
    expect(metrics("page-route-fallback")[0]!.metadata).toMatchObject({ reason: "facts-all-pages-failed" });
  });

  it("active mode refuses a locked row that does not cover every host page", async () => {
    const { plan, metrics } = await route({ facts: jsonl([docLine({ locked: true })]), mode: "active" });
    expectNoHostPdfAccess();
    expect(plan).toBeNull();
    expect(metrics("page-route-fallback")[0]!.metadata).toMatchObject({ reason: "facts-incomplete-for-active", detail: "1/3" });
  });

  it("active mode plans from complete facts without touching the PDF", async () => {
    const { plan } = await route({ facts: fullFixture(), mode: "active" });
    expectNoHostPdfAccess();
    expect(plan).toMatchObject({ mode: "active" });
    expect(new Set(plan!.assignments.map((a) => a.pageNumber))).toEqual(new Set([1, 2, 3]));
  });

  it("a storage failure is unavailable, never an error that reaches the native probe", async () => {
    const { plan, metrics } = await route({ facts: new Error("boom") });
    expectNoHostPdfAccess();
    expect(plan).toBeNull();
    expect(metrics("page-route-fallback")[0]!.metadata).toMatchObject({ reason: "facts-read-failed" });
  });

  it("an assumed page count is not a bound for facts: unavailable", async () => {
    const runner = createDopplerFactsProbeRunner(async () => Buffer.from(fullFixture()));
    expect(await runner({ documentId: "doc", pageCount: null })).toEqual({ status: "unavailable", reason: "no-host-page-count" });
  });

  it.each([
    ["user-password-required", { encryption: "user-password-required" }],
    ["locked", { locked: true }],
  ])("encrypted doc line (%s): one locked row, no host byte scan", async (_name, extra) => {
    const facts = jsonl([docLine(extra), textPage(1), scanPage(2), figurePage(3), runLine()]);
    const runner = createDopplerFactsProbeRunner(async () => Buffer.from(facts));
    const result = await runner({ documentId: "doc", pageCount: 3 });
    expect(result).toMatchObject({ status: "ok", locked: true });
    const rows = (result as unknown as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ locked: true, needsAttention: true, textLayerStatus: "unknown", probeEngine: "doppler-facts" });
    expect(rows[0]!.unusualFeatures).toContain("encrypted-user-password");

    const { plan, metrics } = await route({ facts });
    expectNoHostPdfAccess();
    expect(plan).not.toBeNull();
    expect(metrics("page-route-decision").map((e) => e.pageNumber)).toEqual([1]);
  });
});

describe("golden decisions on fixture facts", () => {
  it("maps the three fixture pages to stable page inputs", async () => {
    const result = await createDopplerFactsProbeRunner(async () => Buffer.from(fullFixture()))({ documentId: "doc", pageCount: 3 });
    expect(result.status).toBe("ok");
    const pages = await Promise.all((result as { rows: Parameters<typeof pageInputFromProbeRow>[0][] }).rows.map((row) => pageInputFromProbeRow(row, null)));
    expect(pages.every((page) => page.features.provenance.probe === "doppler-facts")).toBe(true);
    expect(pages.map((page) => ({
      page: page.features.pageNumber,
      layer: page.textFacts.textLayerStatus,
      plausibility: page.features.native.plausibility,
      tableRuleScore: page.features.native.tableRuleScore,
      fullPageImage: page.features.raster.fullPageImage,
      vectors: page.features.raster.vectorDrawingCount,
      thumbnail: page.thumbnail ?? null,
    }))).toEqual([
      { page: 1, layer: "ok", plausibility: 1, tableRuleScore: 5, fullPageImage: false, vectors: 64, thumbnail: null },
      { page: 2, layer: "ocr-layer", plausibility: 0.3, tableRuleScore: 0, fullPageImage: true, vectors: 0, thumbnail: null },
      { page: 3, layer: "ok", plausibility: 1, tableRuleScore: 0, fullPageImage: false, vectors: 900, thumbnail: null },
    ]);
  });

  it.each(["heuristic", "baseline"] as const)("golden %s plan on the fixture facts", async (router) => {
    const { plan } = await route({ facts: fullFixture(), pageRouter: { router } });
    expectNoHostPdfAccess();
    const golden = [1, 2, 3].map((page) => plan!.assignments.filter((a) => a.pageNumber === page).map((a) => `${a.role}:${a.targetId}`).sort());
    expect({ router, golden }).toMatchSnapshot();
  });

  it("plans the fixture with the heuristic router and records the shadow comparison against v3", async () => {
    const { plan, metrics } = await route({ facts: fullFixture(), pageRouter: { router: "heuristic" } });
    expectNoHostPdfAccess();
    const roles = (page: number) => [...new Set(plan!.assignments.filter((a) => a.pageNumber === page).map((a) => a.role))].sort();
    expect({ 1: roles(1), 2: roles(2), 3: roles(3) }).toMatchInlineSnapshot(`
      {
        "1": [
          "accept-text",
        ],
        "2": [
          "accept-text",
        ],
        "3": [
          "accept-text",
        ],
      }
    `);
    const decisions = metrics("page-route-decision");
    expect(decisions.map((e) => e.pageNumber)).toEqual([1, 2, 3]);
    for (const decision of decisions) {
      expect(decision.metadata).toMatchObject({
        probeSource: "doppler-facts",
        shadowComparison: { probeSource: "doppler-facts", v3Route: null, v3NeedsPixels: null, agreesWithV3: null, routerNeedsPixels: expect.any(Boolean) },
      });
    }
    expect(metrics("page-route-chunk-estimate")[0]!.metadata).toMatchObject({
      probeSource: "doppler-facts",
      shadowComparison: { probeSource: "doppler-facts", pages: 3, compared: 0 },
    });
  });

  it("compares per page with the v3 classification when it ran", async () => {
    const storage = makeStorage(fullFixture());
    const classification = {
      status: "ready",
      pages: [1, 2, 3].map((pageNumber) => ({
        pageNumber, route: pageNumber === 2 ? "handwriting-or-degraded" : "straightforward-text", extractorHint: null, specializedContent: [], textDensityScore: 0.5,
      })),
    };
    const state = makeState();
    state.artifactLedger.recordDocument("doc", "classification", "s3://bucket/user/run/classification/doc.json");
    const stage = new RoutePagesStage(storage, cfg(), sources, undefined, { catalog, env: SANDBOXED });
    // The classification artifact reader validates its own schema; feed the parsed shape through the seam it uses.
    vi.spyOn(stage as unknown as { loadClassification: () => Promise<unknown> }, "loadClassification").mockResolvedValue(classification);
    await stage.run(state);
    expectNoHostPdfAccess();
    const decisions = state.pendingPerformance.filter((e) => e.metric === "page-route-decision");
    expect(decisions.map((e) => (e.metadata as { shadowComparison: { v3Route: string } }).shadowComparison.v3Route))
      .toEqual(["straightforward-text", "handwriting-or-degraded", "straightforward-text"]);
    const summary = (state.pendingPerformance.find((e) => e.metric === "page-route-chunk-estimate")!.metadata as { shadowComparison: Record<string, number> }).shadowComparison;
    expect(summary.compared).toBe(3);
    expect(summary.agree + summary.routerOnlyPixels + summary.v3OnlyPixels).toBe(3);
  });
});

describe("route-pages outside a sandbox", () => {
  it("facts mode `use` still never opens the PDF", async () => {
    const { plan } = await route({ facts: fullFixture(), env: { DOCSLURP_DOPPLER_PAGE_FACTS: "use" } as NodeJS.ProcessEnv });
    expectNoHostPdfAccess();
    expect(plan).not.toBeNull();
  });

  it("HostPdfRefusedError names the operation", () => {
    expect(new HostPdfRefusedError("inset-clip", "vm-only-parsing").message).toContain("inset-clip");
  });
});

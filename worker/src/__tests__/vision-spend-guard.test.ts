import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const visionRuntime = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../tools/vision-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools/vision-runtime.js")>();
  return { ...actual, executeVisionRuntime: visionRuntime.execute };
});

import { buildAdaptiveRoutingDecisionSurface, DRAWN_CONTENT_MIN_BYTES_PER_PAGE } from "../stages/classify-route.js";
import {
  legacyPageHints,
  shouldFailOpenVisionError,
  VisionExtractStage,
  VisionGuardStopError,
  type LegacyPageHints,
  type VisionPageSkip,
} from "../stages/vision-extract.js";
import { VisionOutputRejectedError } from "../tools/vision-stream.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { buildVisionPageFacts } from "../pipeline/page-facts.js";
import { drawnBytesPerPage, renderLooksBlank, totalEmbeddedImageBytes, type PageImageEvidence } from "../lib/page-image-evidence.js";
import {
  resetVisionGuardWarningsForTest,
  resolveVisionGuardConfig,
  VisionRunGuard,
  type VisionRunSpend,
} from "../lib/vision-spend-guard.js";
import type { UsageEvent, WorkspaceRun } from "../models.js";
import type { Config } from "../config.js";
import type { Document } from "../models.js";

const MODEL = "google/gemini-3.1-flash-lite";
const VISION = { target: "remote", modelUri: `llm://openrouter/${MODEL}`, maxPagesPerDocument: 1_000 } as const;
const CFG = { openAiBaseUrl: "https://api.openai.com/v1", costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.03 } as Config;
const NONE = { providerCostCents: 0, attemptedPages: 0, rejectedPages: 0, inFlightPages: 0 };

function rejectedEvent(pageNumber: number, providerCostCents: number): UsageEvent {
  return {
    provider: "openrouter", model: MODEL, metric: "page-analysis-attempt", amount: 1, unit: "attempt", costCents: 0,
    inputTokens: 2_000, outputTokens: 500,
    metadata: { outcome: "rejected", billable: false, providerCostCents, documentId: "doc", pageNumber },
  };
}

function readEvent(pageNumber: number, providerCostCents: number): UsageEvent {
  return { ...rejectedEvent(pageNumber, providerCostCents), metric: "page-analysis", unit: "page",
    metadata: { outcome: "completed", providerCostCents, documentId: "doc", pageNumber } };
}

function runState(pipeline: Record<string, unknown> = {}): WorkflowState {
  return WorkflowState.create({
    id: "run-1", orgId: "org-1", workspaceId: "ws-1", userId: "user-1", artifacts: {}, stats: {}, stage: "vision-extract",
    pipeline: { vision: VISION, privacyMode: "standard", visionFallback: true, ...pipeline },
  } as unknown as WorkspaceRun, []);
}

describe("vision guard config", () => {
  beforeEach(() => resetVisionGuardWarningsForTest());

  it("defaults, the run cost cap and malformed values", () => {
    expect(resolveVisionGuardConfig({ pipeline: {} }, {})).toEqual({
      budgetCents: 2_500, breakerMinRejectedPages: 10, breakerRejectedRate: 0.2,
    });
    expect(resolveVisionGuardConfig({ pipeline: { maxCostCents: 300 } }, {}).budgetCents).toBe(300);
    expect(resolveVisionGuardConfig({ pipeline: { maxCostCents: 9_000 } }, { VISION_RUN_PROVIDER_BUDGET_CENTS: "4000" }).budgetCents)
      .toBe(4_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // A typo never turns the guard off.
    expect(resolveVisionGuardConfig({ pipeline: {} }, {
      VISION_RUN_PROVIDER_BUDGET_CENTS: "off", VISION_REJECTION_BREAKER_MIN_PAGES: "0", VISION_REJECTION_BREAKER_RATE: "2",
    })).toEqual({ budgetCents: 2_500, breakerMinRejectedPages: 10, breakerRejectedRate: 0.2 });
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe("VisionRunGuard", () => {
  const config = { budgetCents: 100, breakerMinRejectedPages: 10, breakerRejectedRate: 0.2 };

  it("counts rejected (unbilled) attempts toward the provider budget", async () => {
    const pending = Array.from({ length: 5 }, (_, index) => rejectedEvent(index + 1, 19));
    const guard = new VisionRunGuard("run-1", config, () => pending);
    // 95 cents of rejected attempts + a 10 cent reservation passes 100.
    const admission = await guard.admit(10);
    expect(admission).toMatchObject({ admitted: false, stop: { reason: "provider-budget", providerCostCents: 95 } });
    // Sticky: no later call is admitted, even a free one.
    expect((await guard.admit(0)).admitted).toBe(false);
  });

  it("counts committed spend and other activities' in-flight calls", async () => {
    const source = vi.fn(async (): Promise<VisionRunSpend> => ({ ...NONE, providerCostCents: 40, inFlightPages: 5 }));
    const guard = new VisionRunGuard("run-1", config, () => [], source, { documentId: "doc", pageNumber: 3 });
    // 40 committed + (5 other tasks + this call) x 10 = 100: admitted at the limit.
    const first = await guard.admit(10);
    expect(first.admitted).toBe(true);
    expect(source).toHaveBeenCalledWith("run-1", { documentId: "doc", pageNumber: 3 });
    // A second concurrent call in this process adds its own reservation.
    expect(await guard.admit(10)).toMatchObject({ admitted: false, stop: { reason: "provider-budget", reservedCents: 70 } });
  });

  it("releases reservations and counts what the call actually cost", async () => {
    let now = 0;
    const guard = new VisionRunGuard("run-1", config, () => [], undefined, undefined, () => now);
    const first = await guard.admit(60);
    if (!first.admitted) throw new Error("expected admission");
    first.release();
    guard.observe(readEvent(1, 30));
    now += 10_000;
    // 30 spent + 60 reserved fits; 30 + 80 does not.
    const second = await guard.admit(60);
    expect(second.admitted).toBe(true);
    if (second.admitted) second.release();
    expect((await guard.admit(80)).admitted).toBe(false);
  });

  it("trips the rejection breaker at the minimum count and rate", async () => {
    const rejected = Array.from({ length: 10 }, (_, index) => rejectedEvent(index + 1, 0));
    // 10 rejected of 100 attempted (10%): below the rate, keep going.
    const reads = Array.from({ length: 90 }, (_, index) => readEvent(index + 11, 0));
    expect((await new VisionRunGuard("run-1", config, () => [...rejected, ...reads]).admit(0)).admitted).toBe(true);
    // 9 of 9: above the rate but below the minimum count.
    expect((await new VisionRunGuard("run-1", config, () => rejected.slice(0, 9)).admit(0)).admitted).toBe(true);
    // 10 of 10: stop.
    expect(await new VisionRunGuard("run-1", config, () => rejected).admit(0))
      .toMatchObject({ admitted: false, stop: { reason: "rejection-breaker", rejectedPages: 10, attemptedPages: 10 } });
    // Committed rejections from other activities count too.
    const source = async () => ({ ...NONE, attemptedPages: 12, rejectedPages: 10 });
    expect(await new VisionRunGuard("run-1", config, () => [], source).admit(0))
      .toMatchObject({ admitted: false, stop: { reason: "rejection-breaker" } });
  });
});

/** A stage whose pages all render as `render` and whose provider answers with `answer(page)`. */
async function pageStage(args: {
  pages: number;
  answer: (pageNumber: number) => { text: string } | Error;
  render?: { sizeBytes: number; widthPx: number | null; heightPx: number | null };
}) {
  const scratch = await mkdtemp(path.join(tmpdir(), "vision-guard-test-"));
  const rasters = {
    renderSelectedPages: vi.fn(async ({ pageNumbers }: { pageNumbers: number[] }) => pageNumbers.map((pageNumber) => ({
      pageNumber, artifactKey: `k/${pageNumber}`, artifactUri: `s3://bucket/k/${pageNumber}`, mimeType: "image/png",
      cacheHit: false, ...(args.render ?? { sizeBytes: 60_000, widthPx: 1275, heightPx: 1650 }),
    }))),
  };
  const storage = {
    downloadToTempFile: async () => {
      const dir = await mkdtemp(path.join(scratch, "page-"));
      const file = path.join(dir, "page.png");
      await writeFile(file, "png");
      return file;
    },
  };
  visionRuntime.execute.mockImplementation(async ({ imagePath }: { imagePath: string }) => {
    void imagePath;
    const pageNumber = Number(visionRuntime.execute.mock.calls.length);
    const answer = args.answer(pageNumber);
    if (answer instanceof Error) throw answer;
    return {
      runtime: "openai-compatible", model: MODEL, prompt: "p", text: answer.text, raw: "", costCents: 0.5,
      latencyMs: 1, inputTokens: 2_000, outputTokens: 400, usageSource: "provider", baseUrl: "https://openrouter.ai/api/v1",
      fallbackUsed: false, fallbackReason: null, provider: "openrouter",
    };
  });
  const stage = new VisionExtractStage({} as never, storage as never, CFG, rasters as never);
  const document = { id: "doc", userId: "user-1", filename: "upload.pdf", mimeType: "application/pdf", pageCount: args.pages } as Document;
  const extract = (stage as unknown as {
    extractVisionPagesFromCache(...a: unknown[]): Promise<Array<{ pageNumber: number; text: string }>>;
  }).extractVisionPagesFromCache.bind(stage);
  return {
    stage, document, rasters, scratch,
    run: (state: WorkflowState, hints: LegacyPageHints, skips: Map<number, VisionPageSkip>) =>
      extract(state, document, VISION, Array.from({ length: args.pages }, (_, index) => index + 1), undefined, undefined,
        undefined, false, { hints, skips }),
  };
}

function rejection(message = "degenerate output after 2 attempts", costCents = 1.5) {
  const error = new VisionOutputRejectedError(message, [], 2_400, 640, costCents);
  error.route = { model: MODEL, provider: "openrouter" };
  return error;
}

const noHints: LegacyPageHints = { inkCheckPages: new Set(), fallbackTextPages: new Set() };

describe("vision page loop under the guard", () => {
  let scratch: string | null = null;
  beforeEach(() => {
    visionRuntime.execute.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (scratch) await rm(scratch, { recursive: true, force: true });
    scratch = null;
  });

  it("stops repeated rejections at the breaker and keeps no model text", async () => {
    const harness = await pageStage({ pages: 40, answer: () => rejection() });
    scratch = harness.scratch;
    const state = runState();
    const skips = new Map<number, VisionPageSkip>();
    const outputs = await harness.run(state, noHints, skips);
    expect(outputs).toEqual([]);
    // Ten rejections trip the breaker; one more may already be in flight (two calls at a time).
    expect(visionRuntime.execute.mock.calls.length).toBeGreaterThanOrEqual(10);
    expect(visionRuntime.execute.mock.calls.length).toBeLessThanOrEqual(11);
    const outcomes = [...skips.values()];
    expect(outcomes.filter((skip) => skip.outcome === "rejected")).toHaveLength(visionRuntime.execute.mock.calls.length);
    expect(outcomes.filter((skip) => skip.outcome === "rejection-breaker").length)
      .toBe(40 - visionRuntime.execute.mock.calls.length);
    // Rejected spend is recorded for us (unbilled); nothing stored carries model text.
    const events = state.usageLedger.snapshot();
    expect(events.every((event) => event.metadata?.billable === false)).toBe(true);
    expect(JSON.stringify([...skips.values(), ...events])).not.toMatch(/"text"/);
  });

  it("stops at the provider budget, counting rejected attempts", async () => {
    vi.stubEnv("VISION_RUN_PROVIDER_BUDGET_CENTS", "20");
    vi.stubEnv("VISION_REJECTION_BREAKER_MIN_PAGES", "1000");
    const harness = await pageStage({ pages: 40, answer: () => rejection(undefined, 3) });
    scratch = harness.scratch;
    const state = runState();
    const skips = new Map<number, VisionPageSkip>();
    await harness.run(state, noHints, skips);
    const calls = visionRuntime.execute.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(40);
    expect([...skips.values()].filter((skip) => skip.outcome === "provider-budget")).toHaveLength(40 - calls);
    const spent = state.usageLedger.snapshot().reduce((sum, event) => sum + Number(event.metadata?.providerCostCents ?? 0), 0);
    expect(spent).toBe(calls * 3);
    expect(spent).toBeLessThanOrEqual(20);
  });

  it("a stopped guard renders nothing and calls nothing", async () => {
    const harness = await pageStage({ pages: 3, answer: () => ({ text: "x" }) });
    scratch = harness.scratch;
    const state = runState({ maxCostCents: 0.001 });
    const skips = new Map<number, VisionPageSkip>();
    await harness.run(state, noHints, skips);
    expect(visionRuntime.execute).not.toHaveBeenCalled();
    expect([...skips.values()].map((skip) => skip.outcome)).toEqual(["provider-budget", "provider-budget", "provider-budget"]);
    const again = new Map<number, VisionPageSkip>();
    await harness.run(state, noHints, again);
    expect(harness.rasters.renderSelectedPages).toHaveBeenCalledTimes(1);
    expect(again.size).toBe(3);
  });

  it("records mixed outcomes: read, rejected with text, rejected without text", async () => {
    const harness = await pageStage({
      pages: 3,
      answer: (call) => (call === 1 ? { text: "page one read by vision" } : rejection()),
    });
    scratch = harness.scratch;
    const state = runState();
    const skips = new Map<number, VisionPageSkip>();
    const outputs = await harness.run(state, { inkCheckPages: new Set(), fallbackTextPages: new Set([2]) }, skips);
    expect(outputs.map((page) => page.pageNumber)).toHaveLength(1);
    const facts = buildVisionPageFacts({
      documentId: "doc", runId: "run-1", pageCount: 3, selected: [1, 2, 3], processed: outputs, cap: 3, outcomes: skips,
    });
    const statuses = facts.map((fact) => fact.visionStatus);
    expect(statuses.filter((status) => status === "extracted")).toHaveLength(1);
    // A rejected page with usable text keeps it (`rejected`); without any it is an explicit failure.
    const rejectedPage = [...skips.values()].find((skip) => skip.fallbackText)!;
    const lostPage = [...skips.values()].find((skip) => !skip.fallbackText)!;
    expect(facts[rejectedPage.pageNumber - 1]!.visionStatus).toBe("rejected");
    expect(facts[lostPage.pageNumber - 1]!.visionStatus).toBe("failed");
    expect(facts[rejectedPage.pageNumber - 1]!.visionTextBytes).toBeNull();
  });

  it("a page task stores the skip, not model text", async () => {
    const harness = await pageStage({ pages: 1, answer: () => rejection() });
    scratch = harness.scratch;
    const state = runState();
    state.documents.push(harness.document);
    const result = await harness.stage.runPageTask(state, {
      runId: "run-1", documentId: "doc", pageNumber: 1, pageCount: 1, vision: VISION as never, fallbackText: true,
    });
    expect(result).toEqual({ pageNumber: 1, outcome: "rejected", fallbackText: true });
    // The stage pass that assembles the document reads the stored outcome back.
    const assembled = runState();
    assembled.distributedVisionPages.set("doc:1", result);
    const skips = new Map<number, VisionPageSkip>();
    expect(await harness.run(assembled, noHints, skips)).toEqual([]);
    expect(skips.get(1)).toEqual({ pageNumber: 1, outcome: "rejected", fallbackText: true });
  });

  it("fails open on a guard stop", () => {
    const stop = { reason: "rejection-breaker" as const, providerCostCents: 1, reservedCents: 0, budgetCents: 10, attemptedPages: 10, rejectedPages: 10 };
    expect(shouldFailOpenVisionError(new VisionGuardStopError(stop))).toBe(true);
    expect(shouldFailOpenVisionError(new Error("routed", { cause: new VisionGuardStopError(stop) }))).toBe(true);
  });
});

describe("fallback text and drawn-content hints", () => {
  const empty: PageImageEvidence = { pageNumber: 1, wordCount: 0, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0 };
  const surface = (text: string, pageCount: number, evidence: PageImageEvidence[], drawn: number | null = null) => {
    const result = buildAdaptiveRoutingDecisionSurface({
      documentId: "doc", filename: "upload.pdf", text, pageCount,
      evidence: { source: "canonical-document", artifactUri: "s3://bucket/canonical.json" },
      pageImageEvidence: new Map(evidence.map((page) => [page.pageNumber, page])),
      drawnBytesPerPage: drawn, routingV2: true,
    });
    if (result.status !== "ready") throw new Error("expected a ready surface");
    return result;
  };

  it("an empty document has no fallback text; drawn-content pages need an ink check", () => {
    const hints = legacyPageHints(surface("", 1, [empty], DRAWN_CONTENT_MIN_BYTES_PER_PAGE * 4).pages);
    expect([...hints.inkCheckPages]).toEqual([1]);
    expect([...hints.fallbackTextPages]).toEqual([]);
  });

  it("garbled text is not usable fallback; readable text is", () => {
    const garbled = Array.from({ length: 20 }, () => "6FDOLQJDWWHQWLRQZLWKRXWORVLQJVLJQDO").join(" ");
    const prose = "A readable paragraph of native text that stays searchable when vision gives nothing back.";
    const hints = legacyPageHints(surface(`${garbled}\f${prose}`, 2, []).pages);
    expect([...hints.fallbackTextPages]).toEqual([2]);
  });
});

const PDFTOPPM = (() => {
  try {
    execFileSync("pdftoppm", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function minimalPdf(content: string, trailer = ""): Buffer {
  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R" +
      "/Resources<</Font<</F1<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>>>>>>>",
    `<</Length ${Buffer.byteLength(content)}>>stream\n${content}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj${object}endobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.concat([Buffer.from(body), Buffer.from(trailer)]);
}

async function render(pdf: Buffer, dir: string, name: string) {
  const source = path.join(dir, `${name}.pdf`);
  await writeFile(source, pdf);
  execFileSync("pdftoppm", ["-r", "150", "-png", "-singlefile", source, path.join(dir, name)], { stdio: "ignore" });
  const png = await readFile(path.join(dir, `${name}.png`));
  return {
    fileBytes: (await stat(source)).size,
    raster: { sizeBytes: png.byteLength, widthPx: png.readUInt32BE(16), heightPx: png.readUInt32BE(20), mimeType: "image/png" },
  };
}

describe.skipIf(!PDFTOPPM)("padded blank PDFs", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "padded-pdf-"));
    visionRuntime.execute.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("a padded blank page is nominated by bytes but never sent to vision", async () => {
    // 400 KB of padding after %%EOF: no text, no images, nothing drawn.
    const padded = await render(minimalPdf("", `%${"x".repeat(400 * 1024)}\n`), dir, "padded");
    const drawn = drawnBytesPerPage(padded.fileBytes, totalEmbeddedImageBytes(""), 1);
    expect(drawn).toBeGreaterThan(DRAWN_CONTENT_MIN_BYTES_PER_PAGE);
    expect(renderLooksBlank(padded.raster)).toBe(true);

    const harness = await pageStage({ pages: 1, answer: () => ({ text: "should not be called" }), render: padded.raster });
    const skips = new Map<number, VisionPageSkip>();
    const outputs = await harness.run(runState(), { inkCheckPages: new Set([1]), fallbackTextPages: new Set() }, skips);
    await rm(harness.scratch, { recursive: true, force: true });
    expect(outputs).toEqual([]);
    expect(visionRuntime.execute).not.toHaveBeenCalled();
    expect(skips.get(1)?.outcome).toBe("blank-render");
    expect(buildVisionPageFacts({ documentId: "doc", runId: "run-1", pageCount: 1, selected: [1], processed: [], cap: 1, outcomes: skips })[0]!
      .visionStatus).toBe("not-selected");
  });

  it("a page of drawn strokes renders with ink", async () => {
    const strokes = Array.from({ length: 40 }, (_, row) =>
      Array.from({ length: 30 }, (_, column) => `${60 + column * 16} ${740 - row * 16} ${4 + ((row * column) % 9)} 6 re`).join(" "),
    ).join("\n") + "\nf";
    const drawn = await render(minimalPdf(strokes), dir, "drawn");
    expect(renderLooksBlank(drawn.raster)).toBe(false);
    // One short line of text is still ink.
    const line = await render(minimalPdf("BT /F1 11 Tf 50 740 Td (Hello world) Tj ET"), dir, "line");
    expect(renderLooksBlank(line.raster)).toBe(false);
  });
});

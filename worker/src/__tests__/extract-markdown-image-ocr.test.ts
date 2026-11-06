import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures, pageCredits, pricing, PUBLIC_ERROR_MESSAGES, publicDocumentError } from "@docslurp/shared";

import { enforceRunSpendForCharge, SpendCheckUnavailableError, setSpendCheckConfig } from "../db/spend-check.js";
import { pushUsageEvent } from "../lib/perf-context.js";

import { documentExtractorRegistry } from "../extractors/registry.js";
import type { SandboxedOcrJob } from "../extractors/plugins.js";
import type { Document, ProjectRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { ExtractMarkdownStage, OCR_MAX_CONSECUTIVE_FAILED_BATCHES, OCR_PDF_BATCH_PAGES } from "../stages/extract-markdown.js";
import { fakeOcrRunner, ocrResultFor, type FakeFrame } from "../test/fake-ocr.js";
import type { CommandRunner } from "../tools/runner.js";

/*
 * Images are read only by the OCR engine (the `ocr` extractor, in the configured boundary), and scanned PDF pages are
 * filled by it. A refused or failed OCR read fails the document: hosted vision is never a stand-in, and Fast never OCRs.
 */

function createRun(pipeline: Record<string, unknown> = {}, pagesTotal = 1): ProjectRun {
  return {
    id: "run-1", orgId: "org-1", userId: "user-1", kind: "bulk-upload", status: "processing", stage: "extract-markdown",
    totalDocuments: 1, processedDocuments: 0, pagesTotal, pagesProcessed: 0, spentCents: 0,
    pipeline: { ...defaultPipelineFeatures, markdownExtraction: true, ...pipeline },
    error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date(),
  } as ProjectRun;
}

function createDocument(filename: string, mimeType: string, pageCount: number): Document {
  return {
    id: "doc-1", userId: "user-1", runId: "run-1", filename, mimeType,
    sourceKey: `raw/${filename}`, status: "processing", extractionMode: "hybrid", pageCount,
    createdAt: new Date(), updatedAt: new Date(),
  } as Document;
}

/** What a provider throws when the CLI refused the job or its input: deterministic, the page fails without a retry. */
const refused = (message = "vm ocr: input refused (decode-failed)") => Object.assign(new Error(message), { ocrRefused: true });

/** Labels whose real executor runs (the in-process stand-in, and the OCR extractor against the fake boundary). */
const REAL_EXECUTORS = new Set(["image-textless", "ocr"]);

/** The stage's real control flow, with storage in memory, a fake OCR boundary, and other extractors replaced by `extract`. */
async function harness(args: {
  format: "image" | "pdf";
  /** Overrides the document MIME type (default image/png or application/pdf by format). */
  mimeType?: string;
  filename?: string;
  pageCount?: number;
  pipeline?: Record<string, unknown>;
  extract?: (label: string) => Promise<{ text: string }>;
  /** What the fake OCR boundary reads for a job. */
  frames?: (job: SandboxedOcrJob) => FakeFrame[];
  /** The whole result the fake boundary writes, when a case needs more than its frames. */
  result?: (job: SandboxedOcrJob) => unknown;
  /** Doppler's converter is installed (its separator-style output wins); default: not installed. */
  doppler?: boolean;
  /** Storage writes fail with this error while it returns one for the key (a transient reset on a write). */
  putFails?: (key: string) => Error | null;
}) {
  const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-image-ocr-test-"));
  const attempted: string[] = [];
  const configs: Record<string, string | undefined> = {};
  const objects = new Map<string, Buffer>();
  const manifests = new Map<string, any>();
  const storage = {
    uri: (key: string) => `s3://test/${key}`,
    putBytes: async (key: string, data: Uint8Array) => {
      const failure = args.putFails?.(key);
      if (failure) throw failure;
      objects.set(key, Buffer.from(data));
    },
    putJson: async (key: string, value: unknown) => { manifests.set(key, value); },
    streamText: async (key: string, text: string) => { objects.set(key, Buffer.from(text)); },
    createMultipartUploadStream: (key: string) => {
      const chunks: Buffer[] = [];
      let resolveDone!: () => void;
      const done = new Promise<void>((resolve) => { resolveDone = resolve; });
      return {
        writable: new Writable({
          write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
          final(callback) { objects.set(key, Buffer.concat(chunks)); resolveDone(); callback(); },
        }),
        done,
      };
    },
  };
  const ocr = fakeOcrRunner(args.frames ?? ((job) => (job.pages ?? [1]).map((frame) => ({ frame, text: `OCR page ${frame}` }))), args.result ? { result: args.result } : {});
  const runner = {
    ...ocr.runner,
    sandboxedPdfMarkdown: async () => ({ binary: "test-vm", args: [], available: true }),
    dolphinMarkdown: async (_source: string, _output: string, configJson?: string) => {
      configs.dolphin = configJson;
      return { binary: "python", args: [], available: true };
    },
    dopplerMarkdown: async () => ({ binary: "pdftomarkdown", args: [], available: args.doppler === true }),
    extractText: async () => ({ binary: "pdftotext", args: [], available: true }),
  } as unknown as CommandRunner & typeof ocr.runner;
  const stage = new ExtractMarkdownStage(runner, storage as any, {} as any);
  const internals = stage as any;
  const filename = args.filename ?? (args.format === "image" ? "scanned-memo.png" : "scan.pdf");
  const sourcePath = path.join(scratch, filename);
  await writeFile(sourcePath, "bytes");
  internals.sources = { get: async () => ({ path: sourcePath, sha256: "sha-doc-1" }) };
  internals.recordSourcePageFacts = async () => undefined;
  internals.buildParserArtifacts = async () => [];
  internals.recordPageImageEvidence = async () => null;
  internals.enrichOfficeStructure = async ({ document }: { document: unknown }) => document;
  const realExtractCandidate = internals.extractCandidate.bind(stage);
  internals.extractCandidate = async (extractor: { label: string }, textKey: string, ...rest: unknown[]) => {
    attempted.push(extractor.label);
    if (REAL_EXECUTORS.has(extractor.label)) return await realExtractCandidate(extractor, textKey, ...rest);
    const { text } = await (args.extract ?? (async () => { throw new Error("no text-layer extractor expected"); }))(extractor.label);
    const tempTextPath = path.join(scratch, `${extractor.label}.md`);
    await writeFile(tempTextPath, text);
    return { label: extractor.label, plan: (extractor as any).plan, textKey, textUri: `s3://test/${textKey}`, tempTextPath };
  };
  const pageCount = args.pageCount ?? 1;
  const mimeType = args.mimeType ?? (args.format === "image" ? "image/png" : "application/pdf");
  const document = createDocument(filename, mimeType, pageCount);
  const state = WorkflowState.create(createRun(args.pipeline, pageCount), [document]);
  state.usageLedger.runId = "run-1";
  state.artifactLedger.recordDocument("doc-1", "normalizedFormat", args.format);
  const richEvents = () => state.usageLedger.snapshot().filter((event) => event.metric === "ingest-page-rich");
  return {
    stage, state, attempted, configs, objects, manifests, runner, jobs: ocr.jobs, richEvents,
    richIds: () => richEvents().map((event) => event.id),
    checkpoint: () => state.documentStage("doc-1", "extract-markdown"),
    text: () => [...objects.entries()].filter(([key]) => key.endsWith(".md")).map(([, bytes]) => bytes.toString("utf8")),
    cleanup: () => rm(scratch, { recursive: true, force: true }),
  };
}

beforeEach(() => {
  // Escalation is a separate concern (ocr/__tests__); these cases read with the recogniser alone.
  vi.stubEnv("DOCSLURP_OCR_ESCALATION", "off");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("image documents are read by the OCR extractor", () => {
  it("routes an image to the ocr extractor and bills page-ocr once for the frame with words", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const h = await harness({ format: "image", frames: () => [{ frame: 1, text: "Invoice total 4200" }] });
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(h.attempted).toEqual(["ocr"]);
      expect(h.jobs).toHaveLength(1);
      expect(h.jobs[0]).toMatchObject({ kind: "image", recognisers: expect.any(Array) });
      expect(h.jobs[0]!.pages).toBeUndefined();
      expect(h.text()).toContain("Invoice total 4200");
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:1"]);
      expect(h.richEvents()[0]?.metadata).toMatchObject({ readBy: "page-ocr" });
    } finally { await h.cleanup(); }
  });

  it("yields one page per frame of a multi-frame TIFF, makes the frames its page count and charges every frame", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    // Intake counts every image as one page; the engine reads three frames.
    const h = await harness({
      format: "image", filename: "fax.tiff", mimeType: "image/tiff", pageCount: 1,
      frames: () => [{ frame: 1, text: "Cover sheet" }, { frame: 2, text: "   " }, { frame: 3, text: "Signed by Ada" }],
    });
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(h.jobs).toHaveLength(1);
      expect(h.text()).toContain("Cover sheet\f   \fSigned by Ada");
      // The page basis is the frames read, so the Markdown's three pages, page rows and the bill agree.
      expect(h.state.documents[0]!.pageCount).toBe(3);
      // An uploaded image bills Rich per frame read, words or not (0.75 credits; 0.5 under the earlier words rule).
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:1", "rich:run-1:doc-1:2", "rich:run-1:doc-1:3"]);
    } finally { await h.cleanup(); }
  });

  /** A store that persists page counts, reports the run's counted TIFFs and pauses the run past `balance` credits. */
  function spendStore(balance: number) {
    const calls = { pageCounts: [] as number[], checks: [] as number[], events: [] as Array<Record<string, unknown>> };
    const known: Record<string, unknown> = {
      getCompletedPages: async () => new Set<number>(),
      setDocumentPageCount: async (_run: string, _doc: string, pages: number) => { calls.pageCounts.push(pages); return true; },
      countedImageFrames: async () => calls.pageCounts.length ? [{ documentId: "doc-1", pageCount: calls.pageCounts.at(-1)!, chargedPages: 0 }] : [],
      enforceSpendForCharge: async (_run: unknown, credits: number) => { calls.checks.push(credits); return { paused: credits > balance }; },
      appendEvent: async (event: Record<string, unknown>) => { calls.events.push(event); },
    };
    const store = new Proxy(known, { get: (target, key: string) => target[key] ?? (async () => undefined) });
    return { store, calls };
  }

  it("checks the balance for a TIFF's counted frames before charging any: a low balance pauses the run and refuses it", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const frames = Array.from({ length: 40 }, (_, index) => ({ frame: index + 1, text: `Page ${index + 1}` }));
    const h = await harness({ format: "image", filename: "deposition.tiff", mimeType: "image/tiff", pageCount: 1, frames: () => frames });
    const { store, calls } = spendStore(1);
    (h.state as any).store = store;
    try {
      await h.stage.run(h.state);
      const checkpoint = h.checkpoint();
      expect(checkpoint?.status).toBe("failed");
      expect(publicDocumentError(checkpoint?.error)).toBe(PUBLIC_ERROR_MESSAGES.imageFramesUnfunded);
      // 39 frames beyond intake's one page, Rich: 9.75 credits checked against a 1-credit balance, and nothing charged.
      expect(calls.pageCounts).toEqual([40]);
      // Two checks: the pre-read one for the first Rich page (0.25, fits), then the counted frames.
      expect(calls.checks).toHaveLength(2);
      expect(calls.checks[0]).toBeCloseTo(0.25);
      expect(calls.checks[1]).toBeGreaterThanOrEqual(9.75);
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("bounds the VM read to the frames the balance covers before it starts, then refuses the TIFF with nothing charged", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const all = Array.from({ length: 40 }, (_, index) => ({ frame: index + 1, text: `Page ${index + 1}` }));
    const h = await harness({ format: "image", filename: "deposition.tiff", mimeType: "image/tiff", pageCount: 1,
      frames: (job) => all.slice(0, job.maxFrames),
      result: (job) => ocrResultFor(job, all.slice(0, job.maxFrames), { truncatedFrames: all.length > job.maxFrames }) });
    const { store, calls } = spendStore(1);
    const sized: number[] = [];
    // The balance covers 5 frames (the read-only sizing query); the run is not paused by asking.
    (store as any).largestFundedCharge = async (_run: unknown, max: number) => { sized.push(max); return 5; };
    (h.state as any).store = store;
    try {
      await h.stage.run(h.state);
      expect(sized).toEqual([64]);
      expect(h.jobs).toHaveLength(1);
      expect(h.jobs[0]!.maxFrames).toBe(5); // the VM read no more than the run could pay for
      expect(publicDocumentError(h.checkpoint()?.error)).toBe(PUBLIC_ERROR_MESSAGES.imageFramesUnfunded);
      expect(calls.pageCounts).toEqual([6]); // one past the budget: the frame check pauses the run
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("a retry after a failed frame check re-authorizes the recorded frames from the durable intake, and charges nothing", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const frames = Array.from({ length: 40 }, (_, index) => ({ frame: index + 1, text: `Page ${index + 1}` }));
    const h = await harness({ format: "image", filename: "deposition.tiff", mimeType: "image/tiff", pageCount: 1, frames: () => frames });
    const { store, calls } = spendStore(1);
    const sized: number[] = [];
    (store as any).largestFundedCharge = async (_run: unknown, max: number, creditsFor: (n: number) => number) => { sized.push(creditsFor(max)); return max; };
    // Attempt 1: the frame check's balance read fails after the frames were recorded as the page count.
    const real = (store as any).enforceSpendForCharge;
    let checks = 0;
    (store as any).enforceSpendForCharge = async (run: unknown, credits: number) => {
      checks += 1;
      if (checks === 2) throw new SpendCheckUnavailableError("connection terminated");
      return await real(run, credits);
    };
    (h.state as any).store = store;
    try {
      await expect(h.stage.run(h.state)).rejects.toMatchObject({ name: "SpendCheckUnavailableError" });
      expect(h.checkpoint()?.status).not.toBe("failed");
      expect(calls.pageCounts).toEqual([40]);
      // Attempt 2, as a retried activity loads it: the persisted page count is the 40 recorded frames, intake stays 1.
      const document = h.state.documents[0]!;
      expect(document.pageCount).toBe(40);
      document.intakePageCount = 1;
      (store as any).enforceSpendForCharge = real;
      await h.stage.run(h.state);
      // The read was sized against intake (39 unpriced Rich frames), not against the recorded 40...
      expect(sized).toHaveLength(2);
      expect(sized[1]).toBeGreaterThan(0);
      expect(sized[1]).toBeCloseTo(sized[0]!);
      // ...and the frame check ran again and refused the image: run paused, nothing charged.
      expect(calls.checks.at(-1)).toBeGreaterThanOrEqual(9.75);
      expect(h.checkpoint()?.status).toBe("failed");
      expect(publicDocumentError(h.checkpoint()?.error)).toBe(PUBLIC_ERROR_MESSAGES.imageFramesUnfunded);
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  describe("the balance changes between sizing the read and the frame check", () => {
    // Sizing funds 5 frames of a 40-frame TIFF; by the frame check the balance covers it (a top-up in between).
    async function changedBalance(pause: ((run: unknown, reason: string) => Promise<{ paused: boolean; blocked: boolean }>) | null) {
      vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const all = Array.from({ length: 40 }, (_, index) => ({ frame: index + 1, text: `Page ${index + 1}` }));
      const h = await harness({ format: "image", filename: "deposition.tiff", mimeType: "image/tiff", pageCount: 1,
        frames: (job) => all.slice(0, job.maxFrames),
        result: (job) => ocrResultFor(job, all.slice(0, job.maxFrames), { truncatedFrames: all.length > job.maxFrames }) });
      const { store, calls } = spendStore(1_000_000);
      (store as any).largestFundedCharge = async () => 5;
      const pauses: string[] = [];
      (store as any).pauseRunForSpend = pause ? async (run: unknown, reason: string) => { pauses.push(reason); return await pause(run, reason); } : undefined;
      (h.state as any).store = store;
      const outcomes = () => warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("image-frames-unfunded"));
      return { h, calls, pauses, outcomes };
    }

    it("pauses the run anyway and refuses the image as spend-paused: the reported outcome matches the run", async () => {
      const { h, calls, pauses, outcomes } = await changedBalance(async () => ({ paused: true, blocked: true }));
      try {
        await h.stage.run(h.state);
        expect(h.jobs[0]!.maxFrames).toBe(5);
        // The frame check passed (the balance now covers one past the budget), so the refusal paused the run itself.
        expect(calls.checks.at(-1)).toBeGreaterThan(0);
        expect(pauses).toEqual(["credit_exhausted"]);
        expect(h.checkpoint()?.status).toBe("failed");
        expect(publicDocumentError(h.checkpoint()?.error)).toBe(PUBLIC_ERROR_MESSAGES.imageFramesUnfunded);
        expect(outcomes()).toHaveLength(1);
        expect(outcomes()[0]).toContain("outcome=spend-paused");
        expect(h.richIds()).toEqual([]);
      } finally { await h.cleanup(); }
    });

    it("reports spend-blocked, never spend-paused, when the run was already paused or stopped by something else", async () => {
      const { h, pauses, outcomes } = await changedBalance(async () => ({ paused: false, blocked: true }));
      try {
        await h.stage.run(h.state);
        expect(pauses).toEqual(["credit_exhausted"]);
        expect(h.checkpoint()?.status).toBe("failed");
        expect(outcomes()[0]).toContain("outcome=spend-blocked");
        expect(outcomes().some((line) => line.includes("spend-paused"))).toBe(false);
        expect(h.richIds()).toEqual([]);
      } finally { await h.cleanup(); }
    });

    it("fails closed (retryable, document not failed) when the run cannot be paused", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      // The store's pause write failed (Store.pauseRunForSpend throws SpendCheckUnavailableError on pauseFailed).
      const { h, outcomes } = await changedBalance(async () => { throw new SpendCheckUnavailableError("could not pause run"); });
      try {
        await expect(h.stage.run(h.state)).rejects.toMatchObject({ name: "SpendCheckUnavailableError" });
        expect(h.checkpoint()?.status).not.toBe("failed");
        expect(outcomes()).toEqual([]);
        expect(h.richIds()).toEqual([]);
      } finally { await h.cleanup(); }
    });
  });

  it("charges and reports every counted frame when the balance covers them", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const frames = Array.from({ length: 40 }, (_, index) => ({ frame: index + 1, text: `Page ${index + 1}` }));
    const h = await harness({ format: "image", filename: "deposition.tiff", mimeType: "image/tiff", pageCount: 1, frames: () => frames });
    const { store, calls } = spendStore(1_000);
    (h.state as any).store = store;
    try {
      await h.stage.run(h.state);
      const checkpoint = h.checkpoint();
      expect(checkpoint?.status).toBe("completed");
      expect(h.richIds()).toHaveLength(40);
      // Progress and stage stats count the 40 frames, not intake's one page.
      expect(checkpoint?.stats).toMatchObject({ processedPages: 40, pageCount: 40 });
      const progress = [...h.state.pageProgress.values()].filter((entry) => entry.documentId === "doc-1");
      expect(progress.filter((entry) => entry.status === "completed").map((entry) => entry.pageNumber)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
      expect(progress.every((entry) => entry.pageCount === 40)).toBe(true);
      expect(h.state.run.pagesTotal).toBe(40);
      expect(JSON.stringify(calls.events)).toContain('"pageCount":40');
    } finally { await h.cleanup(); }
  });

  /** The OCR VM's own provider-cost event, as the VM provider reports it through the runner (2 cores, at the sandbox rate). */
  const VM_SECONDS = 33.7;
  const vmCostCents = pricing().internalCost.sandboxCostCents({ provider: "modal", cores: 2, memoryGib: 2, seconds: VM_SECONDS });
  function withVmUsage(h: Awaited<ReturnType<typeof harness>>) {
    const served = h.runner.run.getMockImplementation()!;
    h.runner.run.mockImplementation(async (...args: Parameters<typeof served>) => {
      const result = await served(...args);
      pushUsageEvent({ provider: "modal", model: "ocr-vm", metric: "sandbox_compute", amount: vmCostCents, unit: "cent", costCents: vmCostCents,
        metadata: { costRole: "provider", costSource: "estimate", billable: false, physicalCores: 2, memoryGiB: 2, wallSeconds: VM_SECONDS } });
      return result;
    });
  }
  const vmEvents = (h: Awaited<ReturnType<typeof harness>>) => h.state.usageLedger.snapshot().filter((event) => event.metric === "sandbox_compute");
  const noCustomerCharge = (h: Awaited<ReturnType<typeof harness>>) => {
    expect(h.richIds()).toEqual([]);
    expect(h.state.usageLedger.pendingBillableCents).toBe(0);
    expect(h.state.usageLedger.snapshot().filter((event) => ["page-ocr", "ocr-escalation", "ocr-compute"].includes(event.metric))).toEqual([]);
  };
  /** Low-confidence frames with boundary PNGs, so escalation would run if anything reached it. */
  const escalatableFrames = (count: number) => Array.from({ length: count }, (_, index) => ({ frame: index + 1, text: `Page ${index + 1}`, meanConfidence: 0.2, image: true }));

  it("records the VM's provider cost at the sandbox rate and charges the customer nothing for a TIFF refused over 64 frames", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const frames = Array.from({ length: 64 }, (_, index) => ({ frame: index + 1, text: `Page ${index + 1}` }));
    const h = await harness({ format: "image", filename: "archive.tiff", mimeType: "image/tiff", pageCount: 1, frames: () => frames,
      result: (job) => ocrResultFor(job, frames, { truncatedFrames: true }) });
    withVmUsage(h);
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("failed");
      noCustomerCharge(h);
      expect(vmEvents(h)).toHaveLength(1);
      expect(vmEvents(h)[0]!.costCents).toBeCloseTo(vmCostCents, 12);
    } finally { await h.cleanup(); }
  });

  it("records the VM's provider cost and charges nothing for an unfunded TIFF, and never escalates it", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.stubEnv("DOCSLURP_OCR_ESCALATION", "on");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
    const h = await harness({ format: "image", filename: "deposition.tiff", mimeType: "image/tiff", pageCount: 1, frames: () => escalatableFrames(40) });
    withVmUsage(h);
    const { store } = spendStore(1);
    (h.state as any).store = store;
    try {
      await h.stage.run(h.state);
      expect(publicDocumentError(h.checkpoint()?.error)).toBe(PUBLIC_ERROR_MESSAGES.imageFramesUnfunded);
      noCustomerCharge(h);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(vmEvents(h).map((event) => event.costCents)).toEqual([vmCostCents]);
    } finally { await h.cleanup(); }
  });

  it("fails closed when the spend check's database errors after the frame count: retryable, nothing charged, no escalation", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.stubEnv("DOCSLURP_OCR_ESCALATION", "on");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const h = await harness({ format: "image", filename: "deposition.tiff", mimeType: "image/tiff", pageCount: 1, frames: () => escalatableFrames(40) });
    withVmUsage(h);
    const { store } = spendStore(1_000);
    // The real charge check over a client whose queries fail, but only after the pre-read check has passed.
    let reads = 0;
    const failing = (async () => { throw Object.assign(new Error("connection terminated unexpectedly"), { name: "PostgresError", code: "08006" }); }) as any;
    const healthy = (async () => [{ funded: true, available: 1_000, project_budget_paused: false, org_budget_paused: false, project_in_org: true }]) as any;
    (store as any).enforceSpendForCharge = async (run: any, credits: number) => {
      reads += 1;
      const result = await enforceRunSpendForCharge(reads === 1 ? healthy : failing, run, credits);
      return { paused: result.paused, blocked: result.blocked };
    };
    (h.state as any).store = store;
    try {
      await expect(h.stage.run(h.state)).rejects.toMatchObject({ name: "SpendCheckUnavailableError" });
      // Not a verdict on the document: its checkpoint is not failed, so the retried activity reads it again.
      expect(h.checkpoint()?.status).not.toBe("failed");
      noCustomerCharge(h);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(vmEvents(h).map((event) => event.costCents)).toEqual([vmCostCents]);
    } finally {
      setSpendCheckConfig(null);
      await h.cleanup();
    }
  });

  it("authorizes the first VM read before any VM cost: a reached cost cap or an unfunded run starts no VM", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Cost cap already reached.
    const capped = await harness({ format: "image", pipeline: { maxCostCents: 1 } });
    capped.state.run.spentCents = 5;
    withVmUsage(capped);
    try {
      await expect(capped.stage.run(capped.state)).rejects.toMatchObject({ name: "RunPolicyError" });
      expect(capped.runner.run).not.toHaveBeenCalled();
      expect(capped.jobs).toEqual([]);
      expect(vmEvents(capped)).toEqual([]);
      noCustomerCharge(capped);
    } finally { await capped.cleanup(); }
    // A balance that cannot cover the image's Rich page: the run pauses before the VM.
    const unfunded = await harness({ format: "image", filename: "fax.tiff", mimeType: "image/tiff" });
    withVmUsage(unfunded);
    const { store, calls } = spendStore(0.1);
    (unfunded.state as any).store = store;
    try {
      await expect(unfunded.stage.run(unfunded.state)).rejects.toMatchObject({ name: "RunPolicyError" });
      expect(calls.checks).toEqual([0.25]);
      expect(unfunded.runner.run).not.toHaveBeenCalled();
      expect(vmEvents(unfunded)).toEqual([]);
      expect(unfunded.checkpoint()?.status).not.toBe("failed");
    } finally { await unfunded.cleanup(); }
    // A pre-read check whose database errors: retryable, no VM.
    setSpendCheckConfig({ enabled: true, pages: 25, credits: 10 });
    const broken = await harness({ format: "image" });
    const brokenStore = spendStore(1_000).store as any;
    brokenStore.enforceSpendForCharge = async (run: any, credits: number) =>
      enforceRunSpendForCharge((async () => { throw new Error("connection reset"); }) as any, run, credits);
    (broken.state as any).store = brokenStore;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(broken.stage.run(broken.state)).rejects.toMatchObject({ name: "SpendCheckUnavailableError" });
      expect(broken.runner.run).not.toHaveBeenCalled();
    } finally {
      setSpendCheckConfig(null);
      await broken.cleanup();
    }
  });

  it("refuses a TIFF with more frames than one file may hold, publishing nothing and charging nothing", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const frames = Array.from({ length: 64 }, (_, index) => ({ frame: index + 1, text: `Page ${index + 1}` }));
    const h = await harness({
      format: "image", filename: "archive.tiff", mimeType: "image/tiff", pageCount: 1,
      frames: () => frames,
      result: (job) => ocrResultFor(job, frames, { truncatedFrames: true }),
    });
    try {
      await h.stage.run(h.state);
      const checkpoint = h.checkpoint();
      expect(checkpoint?.status).toBe("failed");
      expect(publicDocumentError(checkpoint?.error)).toBe(PUBLIC_ERROR_MESSAGES.imageTooManyFrames);
      // No charge of any kind: no Rich page, no billable credits, no OCR read recorded as billed.
      expect(h.richIds()).toEqual([]);
      expect(h.state.usageLedger.pendingBillableCents).toBe(0);
      expect(h.state.usageLedger.snapshot().filter((event) => event.metric === "page-ocr" || event.metric === "ocr-escalation")).toEqual([]);
      expect(h.state.documents[0]!.pageCount).toBe(1);
    } finally { await h.cleanup(); }
  });

  it("fails an image when OCR is off instead of routing it to vision", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "off");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await harness({ format: "image" });
    try {
      await h.stage.run(h.state);
      const checkpoint = h.checkpoint();
      expect(checkpoint?.status).toBe("failed");
      expect(checkpoint?.error).toMatch(/no untried extractor remains for image/);
      expect(h.attempted).not.toContain("image-textless");
      expect(h.runner.run).not.toHaveBeenCalled();
      expect(h.runner.sandboxedOcrRead).not.toHaveBeenCalled();
      expect([...h.manifests.values()].some((value) => value?.needsVision === true)).toBe(false);
      expect(error.mock.calls.flat().join(" ")).toMatch(/\[ocr\] image-unread document=doc-1 mode=off/);
      // The stored diagnostic never reaches users.
      expect(publicDocumentError(checkpoint?.error)).toBe(PUBLIC_ERROR_MESSAGES.processing);
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("fails an image when the VM read fails, with no vision stand-in and nothing billed", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const h = await harness({ format: "image" });
    h.runner.run.mockRejectedValue(refused());
    try {
      await h.stage.run(h.state);
      const checkpoint = h.checkpoint();
      expect(checkpoint?.status).toBe("failed");
      expect(checkpoint?.error).toMatch(/no extractor produced output|no untried extractor remains/);
      expect(h.attempted.every((label) => label === "ocr")).toBe(true);
      expect(h.attempted).not.toContain("image-textless");
      expect([...h.manifests.values()].some((value) => value?.needsVision === true)).toBe(false);
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("fails the activity retryably when the image's OCR boundary cannot run, instead of failing the document", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await harness({ format: "image" });
    h.runner.run.mockRejectedValue(new Error("vm create failed: capacity"));
    try {
      await expect(h.stage.run(h.state)).rejects.toMatchObject({ name: "OcrInfrastructureError" });
      expect(h.checkpoint()?.status).not.toBe("failed");
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); error.mockRestore(); }
  });

  it("fails an image whose OCR result is malformed", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const h = await harness({ format: "image" });
    h.runner.run.mockImplementation(async (plan: any) => {
      await writeFile(plan.sandboxedOcr.output, "{not json");
      return { stdout: "", stderr: "" };
    });
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("failed");
      expect(h.attempted).not.toContain("image-textless");
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("reads an image order that still names a retired parser with the ocr extractor", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(documentExtractorRegistry.resolve("image", ["kreuzberg"])).toEqual(["ocr"]);
    expect(documentExtractorRegistry.resolve("image", ["liteparse", "ocr"])).toEqual(["ocr"]);
    await expect(documentExtractorRegistry.prepare("kreuzberg", {} as CommandRunner, "/scratch/scan.png")).rejects.toThrow(/unknown extractor/);
  });

  it("makes the ocr extractor unavailable when OCR is off", async () => {
    const off = await documentExtractorRegistry.prepare("ocr", {} as CommandRunner, "/scratch/scan.png", undefined, { format: "image", env: { DOCSLURP_OCR_MODE: "off" } } as any);
    expect(off.plan.available).toBe(false);
    const vm = await documentExtractorRegistry.prepare("ocr", {} as CommandRunner, "/scratch/scan.png", undefined, { format: "image", env: { DOCSLURP_OCR_MODE: "vm" } } as any);
    expect(vm.plan.available).toBe(true);
  });
});

describe("scanned PDF pages are filled by the OCR engine", () => {
  it("reads exactly the empty pages in one pdf job and bills each once", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const h = await harness({
      format: "pdf", pageCount: 4,
      extract: async () => ({ text: "Native text layer page\f\fThird page native\f\f" }),
      frames: (job) => job.pages!.map((frame) => ({ frame, text: `Scanned words ${frame}` })),
    });
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(h.jobs).toHaveLength(1);
      expect(h.jobs[0]).toMatchObject({ kind: "pdf", pages: [2, 4] });
      expect(h.text().some((text) => text === "Native text layer page\fScanned words 2\fThird page native\fScanned words 4")).toBe(true);
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:2", "rich:run-1:doc-1:4"]);
      expect(new Set(h.richEvents().map((event) => event.metadata?.readBy))).toEqual(new Set(["page-ocr"]));
    } finally { await h.cleanup(); }
  });

  it("a separating extractor's blank last page is OCR'd and billed: a 30-page image-only scan bills 30 (F1)", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    // Doppler / vm-pdf output: 30 page slots, 29 separators, no terminator; text on page 1 only, pages 2-30 scans.
    const h = await harness({
      format: "pdf", pageCount: 30, doppler: true,
      extract: async (label) => {
        if (label !== "doppler-md") throw new Error(`only Doppler's converter is expected, not ${label}`);
        return { text: `Cover page native text${"\f".repeat(29)}` };
      },
      frames: (job) => job.pages!.map((frame) => ({ frame, text: `Scan ${frame}` })),
    });
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(h.jobs.flatMap((job) => job.pages)).toEqual(Array.from({ length: 29 }, (_, i) => i + 2));
      expect(h.richIds()).toHaveLength(29);
      expect(h.richIds()).toContain("rich:run-1:doc-1:30");
      const text = h.text().find((value) => value.startsWith("Cover page native text"))!;
      expect(text.split("\f")).toHaveLength(30);
      expect(text.split("\f")[29]).toBe("Scan 30");
    } finally { await h.cleanup(); }
  });

  it("a storage reset on the OCR'd Markdown write is retried, never a failed document, and the retry bills each page once (F7)", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let failures = 1;
    const h = await harness({
      format: "pdf", pageCount: 3,
      extract: async () => ({ text: "Native page\f\f\f" }),
      frames: (job) => job.pages!.map((frame) => ({ frame, text: `Scan ${frame}` })),
      putFails: (key) => (key.endsWith(".ocr.md") && failures-- > 0 ? Object.assign(new Error("write ECONNRESET"), { code: "ECONNRESET" }) : null),
    });
    try {
      const error = await h.stage.run(h.state).then(() => null, (caught: unknown) => caught as Error & { code?: string });
      expect(error).toMatchObject({ code: "ECONNRESET" });
      expect(error?.name).not.toBe("DocumentStageError");
      expect(h.checkpoint()?.status).not.toBe("failed");
      const firstIds = h.richIds();
      expect(firstIds).toEqual(["rich:run-1:doc-1:2", "rich:run-1:doc-1:3"]);
      // The activity's retry: the same document again, the same pages read, the same charge ids (the ledger keeps one each).
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(new Set(h.richIds())).toEqual(new Set(firstIds));
      expect(h.text().some((text) => text === "Native page\fScan 2\fScan 3")).toBe(true);
    } finally { await h.cleanup(); }
  });

  it(`reads a long scan in batches of ${OCR_PDF_BATCH_PAGES} pages`, async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const pageCount = 41;
    // Page 1 has a text layer; pages 2..41 (40 pages) are scans.
    const h = await harness({
      format: "pdf", pageCount,
      extract: async () => ({ text: ["Native page", ...Array.from({ length: pageCount - 1 }, () => "")].join("\f") + "\f" }),
      frames: (job) => job.pages!.map((frame) => ({ frame, text: `Scan ${frame}` })),
    });
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(h.jobs.map((job) => job.pages)).toEqual([
        Array.from({ length: 32 }, (_, i) => i + 2),
        Array.from({ length: 8 }, (_, i) => i + 34),
      ]);
      expect(h.jobs.every((job) => job.kind === "pdf")).toBe(true);
      const ids = h.richIds();
      expect(ids).toHaveLength(40);
      expect(new Set(ids).size).toBe(40);
      expect(ids).not.toContain("rich:run-1:doc-1:1");
    } finally { await h.cleanup(); }
  });

  it("authorizes each batch's Rich pages before its VM starts: a 2,000-page scan stops after the funded batch (council E #3)", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const pageCount = 2_000;
    const scan = async () => ({ text: Array.from({ length: pageCount }, () => "").join("\f") + "\f" });
    const store = (balance: number) => {
      const checks: number[] = [];
      const known: Record<string, unknown> = {
        getCompletedPages: async () => new Set<number>(),
        enforceSpendForCharge: async (_run: unknown, credits: number) => { checks.push(credits); return { paused: credits > balance }; },
      };
      return { store: new Proxy(known, { get: (target, key: string) => target[key] ?? (async () => undefined) }), checks };
    };
    const batchCredits = pageCredits("rich", OCR_PDF_BATCH_PAGES);
    // A 1-credit balance covers no batch: the run pauses before any VM starts, nothing is read or charged.
    const poor = await harness({ format: "pdf", pageCount, extract: scan });
    const unfunded = store(1);
    (poor.state as any).store = unfunded.store;
    try {
      await expect(poor.stage.run(poor.state)).rejects.toMatchObject({ name: "RunPolicyError" });
      expect(poor.jobs).toEqual([]);
      expect(poor.richEvents()).toEqual([]);
      expect(unfunded.checks).toEqual([batchCredits]);
    } finally { await poor.cleanup(); }
    // A balance that funds exactly one batch: that batch is read (and stays ledgered), the second is refused before its VM.
    const one = await harness({ format: "pdf", pageCount, extract: scan });
    const funded = store(batchCredits + 0.01);
    (one.state as any).store = funded.store;
    try {
      await expect(one.stage.run(one.state)).rejects.toMatchObject({ name: "RunPolicyError" });
      expect(one.jobs).toHaveLength(1);
      expect(one.jobs[0]!.pages).toHaveLength(OCR_PDF_BATCH_PAGES);
      expect(one.richEvents()).toHaveLength(OCR_PDF_BATCH_PAGES);
      expect(funded.checks).toHaveLength(2);
      expect(funded.checks[1]!).toBeGreaterThan(batchCredits + 0.01);
    } finally { await one.cleanup(); }
  });

  it("fails only the scanned pages, loudly, when the VM read fails during scan fill; the text pages stand", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await harness({ format: "pdf", pageCount: 2, extract: async () => ({ text: "Native\f\f" }) });
    h.runner.run.mockRejectedValue(refused());
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(error.mock.calls.flat().join(" ")).toMatch(/\[ocr\] scanned-pages-failed document=doc-1 pages=2/);
      // Recorded so vision never reads the failed page in OCR's place.
      expect(h.state.artifactLedger.readDocument("doc-1", "ocr-failed-pages")).toBe("[2]");
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); error.mockRestore(); }
  });

  it("fails a refused batch without an in-process retry", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await harness({ format: "pdf", pageCount: 2, extract: async () => ({ text: "Native\f\f" }) });
    h.runner.run.mockRejectedValue(refused());
    try {
      await h.stage.run(h.state);
      expect(h.runner.run).toHaveBeenCalledTimes(1);
      expect(h.state.artifactLedger.readDocument("doc-1", "ocr-failed-pages")).toBe("[2]");
    } finally { await h.cleanup(); error.mockRestore(); }
  });

  it("fails a batch whose result fails validation without an in-process retry", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await harness({ format: "pdf", pageCount: 2, extract: async () => ({ text: "Native\f\f" }) });
    h.runner.run.mockImplementation(async (plan: any) => {
      await writeFile(plan.sandboxedOcr.output, "{not json");
      return { stdout: "", stderr: "" };
    });
    try {
      await h.stage.run(h.state);
      expect(h.runner.run).toHaveBeenCalledTimes(1);
      expect(h.state.artifactLedger.readDocument("doc-1", "ocr-failed-pages")).toBe("[2]");
    } finally { await h.cleanup(); error.mockRestore(); }
  });

  for (const [name, failure] of [
    ["VM creation", new Error("vm create failed: capacity")],
    ["a deadline", Object.assign(new Error("Document VM deadline exceeded"), { name: "SandboxRunError" })],
  ] as const) {
    it(`fails the activity retryably on an infrastructure failure (${name}) instead of failing the pages`, async () => {
      vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const h = await harness({ format: "pdf", pageCount: 2, extract: async () => ({ text: "Native\f\f" }) });
      h.runner.run.mockRejectedValue(failure);
      try {
        await expect(h.stage.run(h.state)).rejects.toMatchObject({ name: "OcrInfrastructureError" });
        expect(h.runner.run).toHaveBeenCalledTimes(1);
        expect(h.state.artifactLedger.readDocument("doc-1", "ocr-failed-pages")).toBeFalsy();
        expect(h.checkpoint()?.status).not.toBe("completed");
      } finally { await h.cleanup(); error.mockRestore(); }
    });
  }

  it(`stops after ${OCR_MAX_CONSECUTIVE_FAILED_BATCHES} consecutive refused batches and fails the remaining pages unread`, async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const pageCount = OCR_PDF_BATCH_PAGES * 5 + 1;
    const h = await harness({
      format: "pdf", pageCount,
      extract: async () => ({ text: ["Native page", ...Array.from({ length: pageCount - 1 }, () => "")].join("\f") + "\f" }),
    });
    h.runner.run.mockRejectedValue(refused());
    try {
      await h.stage.run(h.state);
      expect(h.runner.run).toHaveBeenCalledTimes(OCR_MAX_CONSECUTIVE_FAILED_BATCHES);
      const failed = JSON.parse(h.state.artifactLedger.readDocument("doc-1", "ocr-failed-pages") ?? "[]");
      expect(failed).toEqual(Array.from({ length: pageCount - 1 }, (_, i) => i + 2));
      expect(error.mock.calls.flat().join(" ")).toMatch(/scanned-pages-stopped document=doc-1/);
      expect(h.checkpoint()?.stats).toMatchObject({ ocrFailedPages: pageCount - 1, scanFilledPages: 0 });
    } finally { await h.cleanup(); error.mockRestore(); }
  });

  it("reports scan-filled pages in ocrReadPages, ocrReadSource and scanFilledPages", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const h = await harness({
      format: "pdf", pageCount: 3,
      extract: async () => ({ text: "Native\f\f\f" }),
      frames: (job) => job.pages!.map((frame) => ({ frame, text: frame === 3 ? "" : `Scan ${frame}`, ...(frame === 3 ? { recogniser: null, meanConfidence: null } : {}) })),
    });
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("completed");
      // Page 3 is blank: read (no failure), no words, no Rich charge.
      expect(h.checkpoint()?.stats).toMatchObject({ ocrReadPages: 1, ocrReadSource: "scan-fill", scanFilledPages: 1, ocrFailedPages: 0 });
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:2"]);
    } finally { await h.cleanup(); }
  });

  it("fails the document when every page is a scan and the VM read fails", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    const h = await harness({ format: "pdf", pageCount: 2, extract: async () => ({ text: "" }) });
    h.runner.run.mockRejectedValue(refused());
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("failed");
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  for (const mode of ["off", "hosted"] as const) {
    it(`leaves scanned pages unread with an error log and no OCR call when DOCSLURP_OCR_MODE=${mode}`, async () => {
      vi.stubEnv("DOCSLURP_OCR_MODE", mode);
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const h = await harness({ format: "pdf", pageCount: 3, extract: async () => ({ text: "Native\f\f\f" }) });
      try {
        await h.stage.run(h.state);
        expect(h.checkpoint()?.status).toBe("completed");
        expect(h.attempted).toEqual(["poppler-text"]);
        expect(h.runner.run).not.toHaveBeenCalled();
        expect(h.runner.sandboxedOcrRead).not.toHaveBeenCalled();
        expect(h.runner.localOcrRead).not.toHaveBeenCalled();
        expect(error.mock.calls.flat().join(" ")).toMatch(new RegExp(`\\[ocr\\] scanned-pages-unread document=doc-1 pages=2 mode=${mode}`));
        expect(h.richIds()).toEqual([]);
      } finally { await h.cleanup(); }
    });
  }

  it("keeps an empty VM PDF scan healthy and skips implicit native enrichment", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    vi.stubEnv("DOCSLURP_PDF_ENGINE", "shadow");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = await harness({ format: "pdf", extract: async () => ({ text: "" }) });
    const internals = h.stage as any;
    const payload = vi.fn(async () => { throw new Error("must not parse on host"); });
    internals.buildParserArtifacts = payload;
    try {
      await h.stage.run(h.state);
      expect(h.attempted).toEqual(["vm-pdf"]);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(h.state.documents[0]?.status).not.toBe("failed");
      expect(payload).not.toHaveBeenCalled();
      const manifest = [...h.manifests.values()].find(v => v?.needsVision !== undefined);
      expect(manifest).toBeDefined();
    } finally { await h.cleanup(); }
  });

  it("still reports other extractor failures for formats that have a text layer", async () => {
    const h = await harness({ format: "pdf", extract: async () => { throw new Error("pdftotext: unreadable cross-reference table"); } });
    try {
      await h.stage.run(h.state);
      const checkpoint = h.checkpoint();
      expect(checkpoint?.status).toBe("failed");
      expect(checkpoint?.error).toMatch(/no extractor produced output|no untried extractor remains/);
      expect(h.runner.run).not.toHaveBeenCalled();
    } finally { await h.cleanup(); }
  });
});

describe("quality fast extraction is text-layer only", () => {
  it("keeps an image unread and never calls OCR", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = await harness({ format: "image", pipeline: { quality: "fast" } });
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(h.attempted).toEqual(["image-textless"]);
      expect(h.runner.sandboxedOcrRead).not.toHaveBeenCalled();
      expect(h.runner.run).not.toHaveBeenCalled();
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("never fills scanned PDF pages with OCR", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = await harness({ format: "pdf", pageCount: 2, pipeline: { quality: "fast" }, extract: async () => ({ text: "Native\f\f" }) });
    try {
      await h.stage.run(h.state);
      expect(h.checkpoint()?.status).toBe("completed");
      expect(h.runner.run).not.toHaveBeenCalled();
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("drops request OCR options, model extractors and retired extractors", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = await harness({
      format: "pdf",
      pipeline: {
        quality: "fast",
        documentExtraction: {
          ...defaultPipelineFeatures.documentExtraction,
          order: { pdf: ["dolphin", "graph-local", "kreuzberg"] },
          options: { kreuzberg: { forceOcr: true, ocr: { backend: "paddleocr" } }, dolphin: { mode: "layout" } },
        },
      },
      extract: async () => ({ text: "Born-digital text." }),
    });
    try {
      await h.stage.run(h.state);
      expect(h.attempted).toEqual(["poppler-text"]);
      expect(h.configs.dolphin).toBeUndefined();
    } finally {
      await h.cleanup();
    }
  });

  // An image/* MIME the format map does not know falls back to the filename: "scan.pdf" uploaded as image/gif
  // detects as pdf. Billing and render-images treat it as an image, so extraction must keep it unread too.
  it("keeps an image/* MIME the format map does not know unread instead of OCRing it", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = await harness({ format: "pdf", mimeType: "image/gif", pipeline: { quality: "fast" }, extract: async () => ({ text: "OCR TEXT" }) });
    try {
      await h.stage.run(h.state);
      expect(h.attempted).toEqual(["image-textless"]);
      expect(h.runner.run).not.toHaveBeenCalled();
      expect(h.checkpoint()?.status).toBe("completed");
    } finally {
      await h.cleanup();
    }
  });

  it("still extracts that MIME under auto", async () => {
    const h = await harness({ format: "pdf", mimeType: "image/gif", extract: async () => ({ text: "OCR TEXT" }) });
    try {
      await h.stage.run(h.state);
      expect(h.attempted.length).toBeGreaterThan(0);
    } finally {
      await h.cleanup();
    }
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defaultPipelineFeatures, normalizeStoredPipelineFeatures } from "@docslurp/shared";

import { acceptSandboxedPdfResult, type SandboxedPdfJob } from "../extractors/plugins.js";
import { VISION_ROUTING_VERSION_SLOT } from "../lib/vision-routing-v2.js";
import type { Document, ProjectRun } from "../models.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import type { CommandPlan, CommandRunner } from "../tools/runner.js";
import { PRODUCER_MARKER, docLine, fullFixture, jsonl, runLine, textPage } from "../test/doppler-page-facts-fixture.js";
import { DOPPLER_PAGE_FACTS_SLOT } from "../extractors/doppler-figures.js";
import { dopplerPageFactsJsonl, parseDopplerPageFacts } from "../lib/doppler-page-facts.js";

function parseFacts(raw: string, pageCount: number) {
  const parsed = parseDopplerPageFacts(raw, { pageCount });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.facts;
}

/**
 * A PDF routed to the sandboxed provider is never parsed on the worker host: the stage's real control flow (page facts,
 * extraction, page-image evidence, the OCR ledger) runs against a runner spy that records every method call and every
 * command it is asked to run. Only the provider's job may run; no host `pdf*` tool may even be planned.
 */
function run(documentExtraction: Record<string, unknown> = {}): ProjectRun {
  return {
    id: "run-1", orgId: "org-1", userId: "user-1", kind: "bulk-upload", status: "processing", stage: "extract-markdown",
    totalDocuments: 1, processedDocuments: 0, pagesTotal: 3, pagesProcessed: 0, spentCents: 0,
    pipeline: { ...defaultPipelineFeatures, markdownExtraction: true, visionFallback: true,
      documentExtraction: { ...defaultPipelineFeatures.documentExtraction, ...documentExtraction } },
    error: null, stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date(),
  } as ProjectRun;
}

async function harness(providerResult: { ocrPages?: unknown; layoutFacts?: unknown; pageFacts?: unknown; markdown: string }, documentExtraction: Record<string, unknown> = {}, documentOverrides: Partial<Document> = {}) {
  const scratch = await mkdtemp(path.join(tmpdir(), "docslurp-vm-pdf-host-test-"));
  const calls: string[] = [];
  const commands: CommandPlan[] = [];
  const json = new Map<string, unknown>();
  const bytes = new Map<string, Buffer>();
  let failPutBytes = false;
  const plan = (binary: string): CommandPlan => ({ binary, args: [], available: true });
  const target: Record<string, unknown> = {
    sandboxedPdfMarkdown: async (input: string, output: string) =>
      ({ binary: "test-vm", args: [], available: true, sandboxedPdf: { input, output } }),
    run: async (command: CommandPlan) => {
      commands.push(command);
      if (!command.sandboxedPdf) throw new Error(`host command refused in test: ${command.binary}`);
      // What the runner does for a provider job: the provider writes Markdown, the host validates its result.
      await writeFile(command.sandboxedPdf.output, providerResult.markdown);
      acceptSandboxedPdfResult(command.sandboxedPdf as SandboxedPdfJob,
        { exitCode: 0, stdout: "", stderr: "", ...(providerResult.ocrPages !== undefined ? { ocrPages: providerResult.ocrPages as number[] } : {}),
          ...(providerResult.layoutFacts !== undefined ? { layoutFacts: providerResult.layoutFacts } : {}),
          ...(providerResult.pageFacts !== undefined ? { pageFacts: providerResult.pageFacts } : {}) }, 3);
      return { stdout: "", stderr: "" };
    },
  };
  // Every other runner method (pageText, pdfImagesList, extractText, ...) is a host tool: record it, plan a refusal.
  const runner = new Proxy(target, {
    get(object, key) {
      if (typeof key !== "string") return undefined;
      if (key === "then") return undefined;
      calls.push(key);
      return object[key] ?? (async () => plan(`host:${key}`));
    },
  }) as unknown as CommandRunner;
  const storage = {
    uri: (key: string) => `s3://test/${key}`,
    putBytes: async (key: string, data: Uint8Array) => { if (failPutBytes) throw new Error("storage down"); bytes.set(key, Buffer.from(data)); },
    putJson: async (key: string, value: unknown) => { json.set(key, value); },
    streamText: async () => undefined,
    createMultipartUploadStream: () => ({ writable: new Writable({ write(_chunk, _encoding, done) { done(); } }), done: Promise.resolve() }),
  };
  const stage = new ExtractMarkdownStage(runner, storage as never, {} as never);
  const internals = stage as any;
  const sourcePath = path.join(scratch, "scan.pdf");
  await writeFile(sourcePath, "%PDF-1.7 bytes");
  internals.sources = { get: async () => ({ path: sourcePath, sha256: "sha-doc-1" }) };
  internals.enrichOfficeStructure = async ({ document }: { document: unknown }) => document;
  const document = {
    id: "doc-1", userId: "user-1", runId: "run-1", filename: "scan.pdf", mimeType: "application/pdf", sourceKey: "raw/scan",
    status: "processing", extractionMode: "hybrid", pageCount: 3, createdAt: new Date(), updatedAt: new Date(), ...documentOverrides,
  } as Document;
  const state = WorkflowState.create(run(documentExtraction), [document]);
  state.usageLedger.runId = "run-1";
  state.artifactLedger.recordDocument("doc-1", "normalizedFormat", "pdf");
  const upsertPageFacts = vi.fn(async (_rows: unknown) => undefined);
  // A store that accepts every write, so page facts would be recorded if the stage probed for them.
  (state as { store?: unknown }).store = new Proxy({ upsertPageFacts, getCompletedPages: async () => new Set<number>() } as Record<string, unknown>, {
    get: (object, key) => (typeof key !== "string" || key === "then" ? undefined : object[key] ?? (async () => undefined)),
  });
  const richIds = () => state.usageLedger.snapshot().filter((event) => event.metric === "ingest-page-rich").map((event) => event.id);
  const hostPdf = () => [
    ...calls.filter((name) => /^pdf|pageText|extractText|ocrPdf|images|info|render|rasteri[sz]e/i.test(name)),
    ...commands.filter((command) => !command.sandboxedPdf).map((command) => command.binary),
  ];
  return { stage, state, calls, commands, json, bytes, failBytes: () => { failPutBytes = true; }, hostPdf, richIds, upsertPageFacts, cleanup: () => rm(scratch, { recursive: true, force: true }) };
}

describe("the sandboxed PDF route on the worker host", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("starts no host pdf* command, skips host page facts and image evidence, and bills the provider's OCR pages", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    vi.stubEnv("WORKER_PAGE_FACTS", "true");
    const h = await harness({ markdown: "Born digital\fScanned page read by OCR\f\f", ocrPages: [2] });
    try {
      await h.stage.run(h.state);
      const checkpoint = h.state.documentStage("doc-1", "extract-markdown");
      expect(checkpoint?.status).toBe("completed");
      expect(h.commands.map((command) => command.binary)).toEqual(["test-vm"]);
      expect(h.hostPdf()).toEqual([]);
      expect(h.upsertPageFacts).not.toHaveBeenCalled();
      expect(h.richIds()).toEqual(["rich:run-1:doc-1:2"]);
      expect(checkpoint?.stats).toMatchObject({ extractor: "vm-pdf", hostPdfProbes: "skipped-sandboxed-route", ocrReadPages: 1, ocrReadSource: "extractor-reported" });
    } finally { await h.cleanup(); }
  });

  it.each([
    ["DOCSLURP_PDF_EXTRACTOR", "vm-pdf", { order: { pdf: ["poppler-text"] } }],
    ["DOCSLURP_PDF_EXTRACTOR", "vm-pdf", { order: { pdf: ["native-pdf"] } }],
    ["DOCSLURP_VM_PDF_INSTALLED", "1", { order: { pdf: ["poppler-text", "native-pdf"] } }],
    ["DOCSLURP_PDF_EXTRACTOR", "vm-pdf", { enrich: ["poppler-text"] }],
  ])("under %s=%s refuses a run whose project override names a host parser (%j), without touching the host", async (name, value, override) => {
    vi.stubEnv(name, value);
    vi.stubEnv("WORKER_PAGE_FACTS", "true");
    const h = await harness({ markdown: "text\f\f\f" }, override);
    try {
      await h.stage.run(h.state).catch(() => undefined);
      const checkpoint = h.state.documentStage("doc-1", "extract-markdown");
      expect(checkpoint?.status).not.toBe("completed");
      expect(JSON.stringify(checkpoint ?? {})).toMatch(/refused for pdf/);
      expect(h.commands).toEqual([]);
      expect(h.hostPdf()).toEqual([]);
      expect(h.upsertPageFacts).not.toHaveBeenCalled();
    } finally { await h.cleanup(); }
  });

  it.each([
    ["DOCSLURP_PDF_EXTRACTOR", "vm-pdf"],
    ["DOCSLURP_VM_PDF_INSTALLED", "1"],
  ])("under %s=%s runs a stored config emptied of host parsers in vm-pdf alone, never a default host parser", async (name, value) => {
    vi.stubEnv(name, value);
    vi.stubEnv("WORKER_PAGE_FACTS", "true");
    vi.spyOn(console, "error").mockImplementation(() => {});
    // What the worker's store hands the stage for a run whose stored pipeline named only host parsers.
    const stored = { ...defaultPipelineFeatures, documentExtraction: { ...defaultPipelineFeatures.documentExtraction,
      order: { pdf: ["poppler-text", "native-pdf"] }, pages: ["ocr"], enrich: ["poppler-text"], voting: { enabled: true, secondary: "poppler-text" } } };
    const extraction = normalizeStoredPipelineFeatures(stored as never, "run run-1").documentExtraction;
    const h = await harness({ markdown: "Text\f\f\f" }, extraction as never);
    try {
      await h.stage.run(h.state);
      const checkpoint = h.state.documentStage("doc-1", "extract-markdown");
      expect(checkpoint?.status).toBe("completed");
      expect(checkpoint?.stats).toMatchObject({ extractor: "vm-pdf" });
      expect(h.commands.map((command) => command.binary)).toEqual(["test-vm"]);
      expect(h.hostPdf()).toEqual([]);
      expect(h.upsertPageFacts).not.toHaveBeenCalled();
    } finally { await h.cleanup(); vi.restoreAllMocks(); }
  });

  it("bills nothing when the provider does not report OCR pages, still without probing the host", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    const h = await harness({ markdown: "\fScanned words\f\f" });
    try {
      await h.stage.run(h.state);
      expect(h.state.documentStage("doc-1", "extract-markdown")?.status).toBe("completed");
      expect(h.hostPdf()).toEqual([]);
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("stores the VM's layout facts for routing without probing the host; drops pages outside the document", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    const scan = { bbox: [72, 200, 540, 600], coverage: 0.4, widthPx: 1700, heightPx: 1450, bitsPerComponent: 1, colorSpace: "gray",
      encoding: "ccitt", ppi: [260, 260], bytesPerPixel: null, repeated: false, wordsInside: 0 };
    const layoutFacts = { version: "pdf-layout-facts@1", pages: [
      { pageNumber: 2, known: true, words: 90, images: [scan], tables: [], grids: [], tableCoverage: 0 },
      { pageNumber: 9, known: true, words: 90, images: [scan] },
    ] };
    const h = await harness({ markdown: "OneTwo with a scan beside itThree", layoutFacts });
    h.state.artifactLedger.record(VISION_ROUTING_VERSION_SLOT, "v3");
    try {
      await h.stage.run(h.state);
      expect(h.state.documentStage("doc-1", "extract-markdown")?.status).toBe("completed");
      expect(h.hostPdf()).toEqual([]);
      const uri = h.state.artifactLedger.readDocument("doc-1", "page-layout-facts");
      expect(uri).toMatch(/page-layout-facts\/doc-1\.json$/);
      const stored = [...h.json.entries()].find(([key]) => key.includes("page-layout-facts/"))![1] as { source: string; pages: Array<{ pageNumber: number }> };
      expect(stored.source).toBe("vm-pdf");
      expect(stored.pages.map((page) => page.pageNumber)).toEqual([2]);
    } finally { await h.cleanup(); }
  });

  it("ignores malformed VM layout facts: no artifact, the run completes", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const layoutFacts of [{ version: "pdf-layout-facts@9", pages: [] }, "garbage", { version: "pdf-layout-facts@1", pages: [{ pageNumber: 99, known: true }] }]) {
      const h = await harness({ markdown: "OneTwoThree", layoutFacts });
      h.state.artifactLedger.record(VISION_ROUTING_VERSION_SLOT, "v3");
      try {
        await h.stage.run(h.state);
        expect(h.state.documentStage("doc-1", "extract-markdown")?.status).toBe("completed");
        expect(h.state.artifactLedger.readDocument("doc-1", "page-layout-facts")).toBeUndefined();
      } finally { await h.cleanup(); }
    }
    vi.restoreAllMocks();
  });

  it("records the VM's Doppler page facts as per-page routing facts, without the document's strings, and bills nothing from them", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    // The facts claim more pages than the host counted (3): the extra page and the facts' own count are never used.
    const pageFacts = jsonl([docLine({ pageCount: 50 }), textPage(1), textPage(2), textPage(3), textPage(4), runLine()]);
    const h = await harness({ markdown: "One\fTwo\fThree", pageFacts: Buffer.from(pageFacts) });
    h.state.artifactLedger.record(VISION_ROUTING_VERSION_SLOT, "v3");
    try {
      await h.stage.run(h.state);
      expect(h.state.documentStage("doc-1", "extract-markdown")?.status).toBe("completed");
      expect(h.hostPdf()).toEqual([]);
      expect(h.richIds()).toEqual([]);
      // One routing row per page the host counted (page 4 is past it): closed enums only.
      const rows = h.upsertPageFacts.mock.calls.flatMap((call) => call[0] as Array<Record<string, unknown>>).filter((row) => row.scanClass !== undefined);
      expect(rows).toEqual([1, 2, 3].map((pageNumber) => ({ documentId: "doc-1", runId: "run-1", pageNumber, textLayer: "visible", scanClass: "none" })));
      const everything = JSON.stringify([...h.json.values(), ...h.upsertPageFacts.mock.calls]);
      expect(everything).not.toContain("PRODUCER-MARKER");
      expect(everything).not.toContain(PRODUCER_MARKER.slice(0, 10));
      expect([...h.json.keys()].some((key) => key.includes("/page-facts/"))).toBe(false);
      // store (the default): the facts never stand in for layout facts.
      expect(h.state.artifactLedger.readDocument("doc-1", "page-layout-facts")).toBeUndefined();
    } finally { await h.cleanup(); }
  });

  it("uploads the page facts as canonical lines under the document's own Doppler folder; a raw producer string never reaches storage", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    // The raw stream carries the document's strings, an unknown field and a page past the host's count.
    const raw = jsonl([docLine({ lang: "en-US", title: PRODUCER_MARKER }), textPage(1, { note: PRODUCER_MARKER }), textPage(2), textPage(3), textPage(4), runLine()]);
    for (const mode of ["store", "use"]) {
      vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", mode);
      const h = await harness({ markdown: "One\fTwo\fThree", pageFacts: Buffer.from(raw) });
      try {
        await h.stage.run(h.state);
        const uri = h.state.artifactLedger.readDocument("doc-1", DOPPLER_PAGE_FACTS_SLOT)!;
        expect(uri).toBe("s3://test/user-1/run-1/doppler/doc-1/images/page-facts.jsonl");
        const stored = h.bytes.get("user-1/run-1/doppler/doc-1/images/page-facts.jsonl")!.toString("utf8");
        expect(stored).toBe(dopplerPageFactsJsonl(parseFacts(raw, 3)));
        expect(stored.split("\n").filter(Boolean).map((line) => JSON.parse(line).type)).toEqual(["doc", "page", "page", "page", "run"]);
        const everything = [...h.bytes.values()].map((b) => b.toString("latin1")).join("") + JSON.stringify([...h.json.values()]);
        for (const leaked of ["PRODUCER-MARKER", PRODUCER_MARKER.slice(0, 10), "producer", "creator", "\"lang\"", "en-US", "\"note\""]) expect(everything).not.toContain(leaked);
      } finally { await h.cleanup(); }
    }
  });

  it("writes the page-facts file with figures off, before extract-markdown commits its checkpoint (what route-pages reads, #367)", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    vi.stubEnv("DOCSLURP_DOPPLER_IMAGE_EXTRACT", "0");
    for (const mode of ["store", "use"]) {
      vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", mode);
      const h = await harness({ markdown: "One\fTwo\fThree", pageFacts: fullFixture() });
      // The stage's checkpoint commit: route-pages runs only after it, so the file must already be there.
      const atCommit: boolean[] = [];
      (h.state.store as unknown as Record<string, unknown>).completeDocumentStage = vi.fn(async (_state: unknown, documentId: string, stageName: string) => {
        if (documentId === "doc-1" && stageName === "extract-markdown") atCommit.push(h.bytes.has("user-1/run-1/doppler/doc-1/images/page-facts.jsonl"));
      });
      try {
        await h.stage.run(h.state);
        expect(h.state.documentStage("doc-1", "extract-markdown")?.status).toBe("completed");
        expect(h.commands.every((command) => !command.sandboxedPdf?.figures)).toBe(true);
        expect(atCommit).toEqual([true]);
        expect(h.state.artifactLedger.readDocument("doc-1", DOPPLER_PAGE_FACTS_SLOT)).toBe("s3://test/user-1/run-1/doppler/doc-1/images/page-facts.jsonl");
      } finally { await h.cleanup(); }
    }
  });

  it("writes no page-facts object for malformed, refused or off-mode facts, or when the write fails", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cases: Array<[string, unknown, boolean]> = [
      ["store", "garbage\n", false], ["store", jsonl([textPage(1), docLine()]), false], ["store", 42, false],
      ["store", "x".repeat(2 * 1024 * 1024), false], ["off", fullFixture(), false], ["nonsense", fullFixture(), false], ["store", fullFixture(), true],
    ];
    for (const [mode, pageFacts, failWrite] of cases) {
      vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", mode);
      const h = await harness({ markdown: "One\fTwo\fThree", pageFacts });
      if (failWrite) h.failBytes();
      try {
        await h.stage.run(h.state);
        expect(h.state.documentStage("doc-1", "extract-markdown")?.status, `${mode} ${String(pageFacts).slice(0, 20)}`).toBe("completed");
        expect([...h.bytes.keys()].filter((key) => key.endsWith("page-facts.jsonl"))).toEqual([]);
        expect(h.state.artifactLedger.readDocument("doc-1", DOPPLER_PAGE_FACTS_SLOT)).toBeUndefined();
      } finally { await h.cleanup(); }
    }
    vi.restoreAllMocks();
  });

  it("keys the page-facts object under the document's own artifact root, never another tenant's", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    for (const [overrides, prefix] of [
      [{ userId: "user-1" }, "user-1/run-1/doppler/doc-1/"],
      [{ userId: "user-2" }, "user-2/run-1/doppler/doc-1/"],
      [{ artifactRoot: "extracts/org-9/ex-1" }, "extracts/org-9/ex-1/doppler/doc-1/"],
    ] as const) {
      const h = await harness({ markdown: "One\fTwo\fThree", pageFacts: fullFixture() }, {}, overrides as Partial<Document>);
      try {
        await h.stage.run(h.state);
        const keys = [...h.bytes.keys()].filter((key) => key.endsWith("page-facts.jsonl"));
        expect(keys).toEqual([`${prefix}images/page-facts.jsonl`]);
        expect(h.state.artifactLedger.readDocument("doc-1", DOPPLER_PAGE_FACTS_SLOT)).toBe(`s3://test/${keys[0]}`);
      } finally { await h.cleanup(); }
    }
  });

  it("with DOCSLURP_DOPPLER_PAGE_FACTS=use, stores layout facts mapped from page facts when the provider sent none", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", "use");
    const h = await harness({ markdown: "OneTwoThree", pageFacts: fullFixture() });
    h.state.artifactLedger.record(VISION_ROUTING_VERSION_SLOT, "v3");
    try {
      await h.stage.run(h.state);
      const stored = [...h.json.entries()].find(([key]) => key.includes("page-layout-facts/"))![1] as { source: string; pages: Array<{ pageNumber: number; words: number }> };
      expect(stored.source).toBe("vm-pdf-facts");
      expect(stored.pages.map((page) => [page.pageNumber, page.words])).toEqual([[1, 410], [2, 300], [3, 8]]);
      expect(h.richIds()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it("never sizes a charge from page facts in use mode; the walker's own page sizes still do (council #358 M1)", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", "use");
    const huge = { widthPt: 14_000, heightPt: 14_000, rotation: 0, userUnit: 1 };
    const pageFacts = jsonl([docLine(), textPage(1, { geometry: huge }), textPage(2, { geometry: huge }), textPage(3, { geometry: huge }), runLine()]);
    const walker = { version: "pdf-layout-facts@1", pages: [1, 2, 3].map((pageNumber) => ({ pageNumber, known: true, words: 1, widthPt: 14_000, heightPt: 14_000 })) };
    for (const [provider, billed] of [[{ pageFacts }, false], [{ pageFacts, layoutFacts: walker }, true]] as const) {
      const h = await harness({ markdown: "OneTwoThree", ...provider });
      h.state.artifactLedger.record(VISION_ROUTING_VERSION_SLOT, "v3");
      const recordPageEquivalents = vi.fn(async () => 3);
      (h.state.store as unknown as Record<string, unknown>).recordPageEquivalents = recordPageEquivalents;
      try {
        await h.stage.run(h.state);
        expect(h.state.documentStage("doc-1", "extract-markdown")?.status).toBe("completed");
        expect(recordPageEquivalents.mock.calls.length > 0, JSON.stringify(Object.keys(provider))).toBe(billed);
      } finally { await h.cleanup(); }
    }
  });

  it("keeps the provider's own layout facts over page facts in use mode, and stores nothing with page facts off or malformed", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", "use");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const layoutFacts = { version: "pdf-layout-facts@1", pages: [{ pageNumber: 2, known: true, words: 90, images: [], tables: [], grids: [], tableCoverage: 0 }] };
    let h = await harness({ markdown: "OneTwoThree", pageFacts: fullFixture(), layoutFacts });
    h.state.artifactLedger.record(VISION_ROUTING_VERSION_SLOT, "v3");
    try {
      await h.stage.run(h.state);
      const stored = [...h.json.entries()].find(([key]) => key.includes("page-layout-facts/"))![1] as { source: string };
      expect(stored.source).toBe("vm-pdf");
    } finally { await h.cleanup(); }
    for (const [mode, pageFacts] of [["off", fullFixture()], ["use", "garbage\n"], ["use", 42], ["use", "x".repeat(9 * 1024 * 1024)]] as const) {
      vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", mode);
      h = await harness({ markdown: "Born digital\fScanned page read by OCR\f\f", pageFacts, ocrPages: [2] });
      h.state.artifactLedger.record(VISION_ROUTING_VERSION_SLOT, "v3");
      try {
        await h.stage.run(h.state);
        expect(h.state.documentStage("doc-1", "extract-markdown")?.status).toBe("completed");
        // No routing row came from the facts (they carry the only scan class).
        expect(h.upsertPageFacts.mock.calls.flat(2).some((row) => (row as { scanClass?: unknown }).scanClass !== undefined)).toBe(false);
        expect(h.state.artifactLedger.readDocument("doc-1", "page-layout-facts")).toBeUndefined();
        // Billing evidence is the provider's ocrPages alone, whatever happened to the facts.
        expect(h.richIds()).toEqual(["rich:run-1:doc-1:2"]);
      } finally { await h.cleanup(); }
    }
    vi.restoreAllMocks();
  });

  it("refuses a provider result whose ocrPages fall outside the page count or repeat", () => {
    const job = { input: "/a", output: "/b" };
    for (const ocrPages of [[0], [4], [1, 1], [1.5], ["1"], "1"]) {
      expect(() => acceptSandboxedPdfResult(job, { exitCode: 0, stdout: "", stderr: "", ocrPages: ocrPages as number[] }, 3)).toThrow("invalid ocrPages");
    }
    expect(acceptSandboxedPdfResult(job, { exitCode: 0, stdout: "", stderr: "", ocrPages: [3, 1] }, 3).ocrPages).toEqual([1, 3]);
  });
});

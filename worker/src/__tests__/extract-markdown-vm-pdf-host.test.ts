import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memoryCheckpointStore } from "../pipeline/checkpoint-store-memory.js";

import { defaultPipelineFeatures, normalizeStoredPipelineFeatures, type AdaptiveRoutingDecisionSurface } from "@docslurp/shared";

import { acceptSandboxedPdfResult, type SandboxedPdfJob } from "../extractors/plugins.js";
import { VISION_ROUTING_VERSION_SLOT } from "../lib/vision-routing-v2.js";
import type { Document, ProjectRun } from "../models.js";
import { MemoryPageBasisLedger } from "../pipeline/page-basis-memory.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { ClassifyRouteStage, ENCODING_MATH_READ_SIGNAL, selectLegacyVisionPages } from "../stages/classify-route.js";
import { ExtractMarkdownStage } from "../stages/extract-markdown.js";
import type { CommandPlan, CommandRunner } from "../tools/runner.js";
import { PRODUCER_MARKER, docLine, figurePage, fullFixture, jsonl, runLine, scanPage, textPage } from "../test/doppler-page-facts-fixture.js";
import { OCR_PAGE_CLASS_SLOT } from "../pipeline/ocr-page-class.js";
import { PAGE_BILLING_RULES_SLOT } from "../db/page-base-fee.js";
import { DOPPLER_PAGE_FACTS_SLOT } from "../extractors/doppler-figures.js";
import { DOPPLER_MATH_FLAGS, dopplerFlagBit } from "../lib/doppler-encoding-facts.js";
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
    bucket: "test",
    getJson: async (key: string) => json.get(key),
    getBytes: async (key: string) => bytes.get(key) ?? Buffer.alloc(0),
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
  internals.sources = { acquire: async () => ({ path: sourcePath, release: async () => {}, sha256: "sha-doc-1" }) };
  internals.enrichOfficeStructure = async ({ document }: { document: unknown }) => document;
  const document = {
    id: "doc-1", userId: "user-1", runId: "run-1", filename: "scan.pdf", mimeType: "application/pdf", sourceKey: "raw/scan",
    status: "processing", extractionMode: "hybrid", pageCount: 3, createdAt: new Date(), updatedAt: new Date(), ...documentOverrides,
  } as Document;
  const state = WorkflowState.create(run(documentExtraction), [document]);
  state.usageLedger.runId = "run-1";
  state.artifactLedger.recordDocument("doc-1", "normalizedFormat", "pdf");
  const upsertPageFacts = vi.fn(async (_scope: unknown, _rows: unknown) => undefined);
  // An in-memory store, so page facts would be recorded if the stage wrote them.
  // Its page basis is an in-memory ledger over the run's documents (a funded run).
  const ledger = new MemoryPageBasisLedger().seed([document]);
  const store = memoryCheckpointStore({ pageBasisLedger: ledger });
  store.content.upsertPageFacts = upsertPageFacts;
  state.bindStore(store);
  const richIds = () => state.usageLedger.snapshot().filter((event) => event.metric === "ingest-page-ocr").map((event) => event.id);
  const hostPdf = () => [
    ...calls.filter((name) => /^pdf|pageText|extractText|ocrPdf|images|info|render|rasteri[sz]e/i.test(name)),
    ...commands.filter((command) => !command.sandboxedPdf).map((command) => command.binary),
  ];
  return { stage, state, ledger, calls, commands, json, bytes, storage, failBytes: () => { failPutBytes = true; }, hostPdf, richIds, upsertPageFacts, cleanup: () => rm(scratch, { recursive: true, force: true }) };
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
      expect(h.richIds()).toEqual(["ocr:run-1:doc-1:2"]);
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
      const rows = h.upsertPageFacts.mock.calls.flatMap((call) => call[1] as Array<Record<string, unknown>>).filter((row) => row.scanClass !== undefined);
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
      const recordPageEquivalents = vi.spyOn(h.ledger, "recordPageEquivalents");
      try {
        await h.stage.run(h.state);
        expect(h.state.documentStage("doc-1", "extract-markdown")?.status).toBe("completed");
        expect(recordPageEquivalents.mock.calls.length > 0, JSON.stringify(Object.keys(provider))).toBe(billed);
      } finally { await h.cleanup(); }
    }
  });

  it("never sizes a charge from page facts' grids, words inside or bytes per pixel either (doppler #42 fields)", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", "use");
    const huge = { widthPt: 14_000, heightPt: 14_000, rotation: 0, userUnit: 1 };
    const page = (n: number) => {
      const base = textPage(n, { geometry: huge });
      const images = base.images as { items: Array<Record<string, unknown>> } & Record<string, unknown>;
      return {
        ...base,
        images: { ...images, items: images.items.map((item) => ({ ...item, bbox: [0, 0, 14_000, 14_000], coverage: 1, px: [60_000, 60_000], visibleWordsInside: 0, invisibleWordsInside: 0, bytesPerPixel: 1e9 })) },
        vectors: { ...(base.vectors as object), hRules: 1_000_000, vRules: 1_000_000, grids: Array.from({ length: 64 }, () => ({ bbox: [0, 0, 14_000, 14_000], rows: 8_192, columns: 8_192, coverage: 1 })), gridsTruncated: false },
      };
    };
    const pageFacts = jsonl([docLine(), page(1), page(2), page(3), runLine()]);
    const h = await harness({ markdown: "OneTwoThree", pageFacts });
    h.state.artifactLedger.record(VISION_ROUTING_VERSION_SLOT, "v3");
    const recordPageEquivalents = vi.spyOn(h.ledger, "recordPageEquivalents");
    try {
      await h.stage.run(h.state);
      expect(h.state.documentStage("doc-1", "extract-markdown")?.status).toBe("completed");
      // The facts were used for layout (so the new fields reached the mapper) and still sized nothing.
      const stored = [...h.json.entries()].find(([key]) => key.includes("page-layout-facts/"))![1] as { source: string; pages: Array<{ images: Array<{ bytesPerPixel: number | null }> | null }> };
      expect(stored.source).toBe("vm-pdf-facts");
      expect(stored.pages.every((p) => p.images?.[0]?.bytesPerPixel === 1e9)).toBe(true);
      expect(recordPageEquivalents).not.toHaveBeenCalled();
    } finally { await h.cleanup(); }
  });

  it("never sizes a charge from walker-parity grids or centred words inside either (doppler #44 fields)", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", "use");
    const huge = { widthPt: 14_000, heightPt: 14_000, rotation: 0, userUnit: 1 };
    const page = (n: number) => {
      const base = textPage(n, { geometry: huge });
      const images = base.images as { items: Array<Record<string, unknown>> } & Record<string, unknown>;
      const grid = { bbox: [0, 0, 14_000, 14_000], rows: 8_192, columns: 8_192, coverage: 1, hRules: 4_096, vRules: 4_096, outerSides: 4, connected: true };
      return {
        ...base,
        images: { ...images, items: images.items.map((item) => ({ ...item, bbox: [0, 0, 14_000, 14_000], coverage: 1, px: [60_000, 60_000], visibleWordsCentredInside: 410, invisibleWordsCentredInside: 0 })) },
        vectors: { ...(base.vectors as object), hRules: 1_000_000, vRules: 1_000_000, grids: Array.from({ length: 64 }, () => grid), gridsTruncated: false, unlistedRuledGrids: 0 },
      };
    };
    const pageFacts = jsonl([docLine(), page(1), page(2), page(3), runLine()]);
    const h = await harness({ markdown: "OneTwoThree", pageFacts });
    h.state.artifactLedger.record(VISION_ROUTING_VERSION_SLOT, "v3");
    const recordPageEquivalents = vi.spyOn(h.ledger, "recordPageEquivalents");
    try {
      await h.stage.run(h.state);
      expect(h.state.documentStage("doc-1", "extract-markdown")?.status).toBe("completed");
      // The walker grids and centred counts reached the stored layout, and still sized nothing.
      const stored = [...h.json.entries()].find(([key]) => key.includes("page-layout-facts/"))![1] as { source: string; pages: Array<{ grids: Array<{ rows: number }> | null; tableCoverage: number | null; images: Array<{ wordsInside: number | null }> | null }> };
      expect(stored.source).toBe("vm-pdf-facts");
      expect(stored.pages.every((p) => p.grids?.length === 64 && p.grids[0]!.rows === 4_095 && p.tableCoverage === null)).toBe(true);
      expect(stored.pages.every((p) => p.images?.[0]?.wordsInside === 410)).toBe(true);
      expect(recordPageEquivalents).not.toHaveBeenCalled();
    } finally { await h.cleanup(); }
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
        expect(h.richIds()).toEqual(["ocr:run-1:doc-1:2"]);
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

/**
 * DOCSLURP_DOPPLER_PAGE_FACTS=use on the sandboxed route: the winning VM job's validated page facts stand in for the host probes
 * the route never runs (page-image evidence, the ingest report's per-page rows), with no command, and only when they cover every
 * page. Anything less keeps today's behaviour exactly; billing never moves.
 */
describe("Doppler page facts as routing evidence on the sandboxed route", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  const covering = () => jsonl([docLine(), textPage(1), scanPage(2), figurePage(3), runLine()]);
  /** A run with a page billing pin (every run this release starts): it bills Rich pages as they are read, never from page facts. */
  async function pinned(provider: Parameters<typeof harness>[0]) {
    const h = await harness(provider);
    h.state.artifactLedger.record(PAGE_BILLING_RULES_SLOT, "test-pricing@1");
    h.state.artifactLedger.record(VISION_ROUTING_VERSION_SLOT, "v3");
    // Started with the OCR page class on (every live worker advertised it).
    h.state.artifactLedger.record(OCR_PAGE_CLASS_SLOT, "1");
    return h;
  }
  const sourceRows = (h: Awaited<ReturnType<typeof harness>>) =>
    h.upsertPageFacts.mock.calls.flatMap((call) => call[1] as Array<Record<string, unknown>>).filter((row) => row.factsSource !== undefined);
  const evidence = (h: Awaited<ReturnType<typeof harness>>) =>
    [...h.json.entries()].find(([key]) => key.includes("/page-image-evidence/"))?.[1] as { source: string; drawnBytesPerPage: unknown; pages: Array<Record<string, unknown>> } | undefined;

  it("builds page-image evidence and per-page ingest-report rows from covering facts, running no host command", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", "use");
    const h = await pinned({ markdown: "Born digital text\fScanned page read by OCR\fA figure", pageFacts: covering(), ocrPages: [2] });
    try {
      await h.stage.run(h.state);
      const checkpoint = h.state.documentStage("doc-1", "extract-markdown");
      expect(checkpoint?.status).toBe("completed");
      // The runner spy: only the provider's VM job ran; no host tool was even planned.
      expect(h.commands.map((command) => command.binary)).toEqual(["test-vm"]);
      expect(h.hostPdf()).toEqual([]);
      expect(h.calls.filter((name) => /listImages|listPdfImages|pageText|pdfPageSizes|pdfWordBoxes|pdfLayoutFacts|pdfInfo/.test(name))).toEqual([]);
      // Page triage's artifact, as the pdfimages probe writes it: page 3 is sparse (8 words); the logo drawn on every page is
      // furniture; page 2's invisible OCR layer has 300 words, so it is not sparse (as pdftotext would read it).
      expect(h.state.artifactLedger.readDocument("doc-1", "page-image-evidence")).toMatch(/page-image-evidence\/doc-1\.json$/);
      expect(evidence(h)).toMatchObject({ source: "doppler-facts", drawnBytesPerPage: null, pages: [
        { pageNumber: 3, wordCount: 8, imagesKnown: true, anyImageCount: 1, repeatedImageCount: 0, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0, embeddedImageBytes: null },
      ] });
      // The ingest report's per-page rows: every page, no invented size.
      expect(sourceRows(h)).toEqual([
        { documentId: "doc-1", runId: "run-1", pageNumber: 1, textBytes: 17, wordCount: 410, imageCount: 1, factsSource: "doppler-facts" },
        { documentId: "doc-1", runId: "run-1", pageNumber: 2, textBytes: null, wordCount: 300, imageCount: 2, factsSource: "doppler-facts" },
        { documentId: "doc-1", runId: "run-1", pageNumber: 3, textBytes: 8, wordCount: 8, imageCount: 1, factsSource: "doppler-facts" },
      ]);
      expect(checkpoint?.stats).toMatchObject({ hostPdfProbes: "skipped-sandboxed-route", dopplerFactsEvidence: { status: "built", pages: 3, evidencePages: 1, rows: 3 } });
    } finally { await h.cleanup(); }
  });

  it.each([
    { mode: "store", pilot: "off", maxRung: "intelligent", alreadyRead: false, textDisagrees: false, selected: [] },
    { mode: "store", pilot: "on", maxRung: "intelligent", alreadyRead: false, textDisagrees: false, selected: [2, 3] },
    { mode: "store", pilot: "on", maxRung: "intelligent", alreadyRead: false, textDisagrees: true, selected: [] },
    { mode: "store", pilot: "on", maxRung: "ocr", alreadyRead: false, textDisagrees: false, selected: [] },
    { mode: "use", pilot: "off", maxRung: "ocr", alreadyRead: false, textDisagrees: false, selected: [2] },
    { mode: "use", pilot: "off", maxRung: "ocr", alreadyRead: true, textDisagrees: false, selected: [] },
    { mode: "use", pilot: "off", maxRung: "intelligent", alreadyRead: false, textDisagrees: false, selected: [2, 3] },
  ] as const)("routes validated VM facts ($mode, $maxRung, OCR already returned: $alreadyRead)", async ({ mode, pilot, maxRung, alreadyRead, textDisagrees, selected }) => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", mode);
    vi.stubEnv("DOCSLURP_ENCODING_FACTS_ROUTING", "on");
    vi.stubEnv("DOCSLURP_SMARTEST_PDF_ROUTING", pilot);
    const scan = scanPage(2);
    const text = { ...(scan.text as Record<string, unknown>), charCount: 0, invisibleCharCount: 0, wordCount: 0,
      invisibleWordCount: 0, textLayer: "none", textCoverage: 0, textOverImageRatio: 0, invisibleOverFullPageImage: false };
    const native = "A plain paragraph with usable native words on this page. ".repeat(12);
    const pageTwo = alreadyRead || textDisagrees ? native : "![Page image](page.png)";
    const h = await pinned({
      markdown: `${native}\f${pageTwo}\f${native}`,
      pageFacts: jsonl([
        docLine(),
        textPage(1),
        { ...scan, text },
        textPage(3, { mathBits: dopplerFlagBit(DOPPLER_MATH_FLAGS, "type3-bitmap-font"), tableBits: 0, encodingCounts: 0 }),
        runLine(),
      ]),
      ...(alreadyRead ? { ocrPages: [2] } : {}),
    });
    h.state.run.pipeline.quality = "auto";
    h.state.run.pipeline.ladder = { maxRung };
    try {
      await h.stage.run(h.state);
      await new ClassifyRouteStage(h.storage as never).run(h.state);
      const surface = [...h.json.entries()].find(([key]) => key.endsWith("/classify/doc-1.json"))?.[1] as
        AdaptiveRoutingDecisionSurface;
      expect(surface.pages[2]?.ocrDecision?.signals.includes(ENCODING_MATH_READ_SIGNAL) ?? false)
        .toBe((selected as readonly number[]).includes(3));
      expect(selectLegacyVisionPages(surface.pages, { routingV2: true })).toEqual(selected);
      expect(h.hostPdf()).toEqual([]);
    } finally { await h.cleanup(); }
  });

  it.each([
    ["the stream was cut short (no run line)", () => jsonl([docLine(), textPage(1), scanPage(2), figurePage(3)]), "incomplete"],
    ["a page is missing", () => jsonl([docLine(), textPage(1), scanPage(2), runLine({ pagesEmitted: 2 })]), "pages-missing"],
    ["a page failed", () => jsonl([docLine(), textPage(1), scanPage(2), { schema: "doppler-page-facts/1", type: "page", page: 3, error: "failed", parseWarnings: [], unusualFeatures: [] }, runLine({ pagesFailed: 1 })]), "pages-failed"],
    ["a line was dropped", () => jsonl([docLine(), textPage(1), scanPage(2), "{not json", figurePage(3), runLine()]), "lines-dropped"],
    ["a page has no text family", () => { const page = textPage(3); delete page.text; return jsonl([docLine(), textPage(1), scanPage(2), page, runLine()]); }, "text-family-missing"],
    ["a page's image list is truncated", () => jsonl([docLine(), textPage(1), scanPage(2), figurePage(3, { images: { ...(textPage().images as object), itemsTruncated: true } }), runLine()]), "images-family-incomplete"],
    ["a page has no image list (basic level)", () => { const images = { ...(textPage().images as Record<string, unknown>) }; delete images.items; return jsonl([docLine(), textPage(1), scanPage(2), figurePage(3, { images }), runLine()]); }, "images-family-incomplete"],
    ["the document is locked", () => jsonl([docLine({ locked: true }), textPage(1), scanPage(2), figurePage(3), runLine()]), "locked"],
    // Facts call page 3 sparse (8 words) while the extraction read it as 40 words of text, not by OCR.
    ["the facts disagree with the extracted text", () => covering(), "words-disagree", `One\fTwo\f${Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ")}`],
  ])("fails closed when %s: no evidence, no rows, and still no host command", async (_label, facts, reason, markdown = "One\fTwo\fThree") => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", "use");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const h = await pinned({ markdown, pageFacts: facts() });
    try {
      await h.stage.run(h.state);
      const checkpoint = h.state.documentStage("doc-1", "extract-markdown");
      expect(checkpoint?.status).toBe("completed");
      expect(h.state.artifactLedger.readDocument("doc-1", "page-image-evidence")).toBeUndefined();
      expect(sourceRows(h)).toEqual([]);
      expect(h.commands.map((command) => command.binary)).toEqual(["test-vm"]);
      expect(h.hostPdf()).toEqual([]);
      expect(checkpoint?.stats).toMatchObject({ dopplerFactsEvidence: { status: "skipped", reason } });
    } finally { await h.cleanup(); }
  });

  it.each([["store"], ["off"]])("builds nothing in %s mode (only use lets facts stand in for probes)", async (mode) => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", mode);
    const h = await pinned({ markdown: "One\fTwo\fThree", pageFacts: covering() });
    try {
      await h.stage.run(h.state);
      expect(h.state.artifactLedger.readDocument("doc-1", "page-image-evidence")).toBeUndefined();
      expect(sourceRows(h)).toEqual([]);
      expect(h.state.documentStage("doc-1", "extract-markdown")?.stats).toMatchObject({ dopplerFactsEvidence: { status: "skipped", reason: `mode-${mode}` } });
    } finally { await h.cleanup(); }
  });

  it("billing is unchanged by facts: the same Rich reads, no page-equivalent sizes from facts, no rows for a legacy-billed run", async () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    vi.stubEnv("DOCSLURP_DOPPLER_PAGE_FACTS", "use");
    // Facts that would, if read for billing, size every page at the maximum and mark page 2 a scan with no text.
    const huge = { widthPt: 14_000, heightPt: 14_000, rotation: 0, userUnit: 1 };
    const scanNoText = scanPage(2, { geometry: huge, text: { ...(scanPage().text as object), charCount: 0, invisibleCharCount: 0, wordCount: 0, invisibleWordCount: 0, textLayer: "none" } });
    const facts = jsonl([docLine(), textPage(1, { geometry: huge }), scanNoText, figurePage(3, { geometry: huge }), runLine()]);
    const outcomes: Array<{ rich: unknown[]; equivalents: unknown[] }> = [];
    for (const provider of [{}, { pageFacts: facts }]) {
      const h = await pinned({ markdown: "Born digital text\f\fA figure", ocrPages: [2], ...provider });
      const recordPageEquivalents = vi.spyOn(h.ledger, "recordPageEquivalents");
      try {
        await h.stage.run(h.state);
        expect(h.state.documentStage("doc-1", "extract-markdown")?.status).toBe("completed");
        outcomes.push({ rich: h.richIds(), equivalents: recordPageEquivalents.mock.calls });
      } finally { await h.cleanup(); }
    }
    // Billing evidence is the provider's ocrPages and the walker's sizes (none here) alone, facts or not.
    expect(outcomes[1]).toEqual(outcomes[0]);
    expect(outcomes[0]!.rich).toEqual(["ocr:run-1:doc-1:2"]);
    expect(outcomes[0]!.equivalents).toEqual([]);

    // A run started before the page billing pin bills pages with no text bytes and an image as scans at completion
    // (page-base-fee.ts): facts rows would raise its charge, so none are written. The evidence (routing) still is.
    const h = await harness({ markdown: "Born digital text\f\fA figure", ocrPages: [2], pageFacts: facts });
    h.state.artifactLedger.record(VISION_ROUTING_VERSION_SLOT, "v3");
    try {
      await h.stage.run(h.state);
      expect(sourceRows(h)).toEqual([]);
      expect(h.richIds()).toEqual(["ocr:run-1:doc-1:2"]);
      expect(h.state.documentStage("doc-1", "extract-markdown")?.stats).toMatchObject({ dopplerFactsEvidence: { status: "built", rows: 0, rowsSkipped: "legacy-billing" } });
    } finally { await h.cleanup(); }
  });
});


import { defaultPipelineFeatures, getPipelineStageOrder, mergePipelineFeatures, pipelineFeatureOverridesSchema, textConsumingStages } from "@docslurp/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../sandbox/source-integrity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sandbox/source-integrity.js")>();
  return {
    ...actual,
    // Every host decoder starts from these: any call is a host read of the customer source.
    readSourceBytes: vi.fn(async () => { throw new Error("host read of the source"); }),
    stageSourceFile: vi.fn(async () => { throw new Error("staged the source for a text fallback"); }),
  };
});

const { extractTextForEmbedding, SourceTextUnavailableError } = await import("../stages/embedding-runtime.js");
const { readSummarySource } = await import("../stages/summary-source.js");
const { coerceMarkdownExtractionForVmFloor, loadRunState } = await import("../pipeline/stage-execution.js");
const integrity = await import("../sandbox/source-integrity.js");

const production = () => { vi.stubEnv("DOCSLURP_PROFILE", "service"); vi.stubEnv("NODE_ENV", "production"); };
const featuresOf = (override: Record<string, unknown>) => mergePipelineFeatures(defaultPipelineFeatures, pipelineFeatureOverridesSchema.parse(override));

/** Every way a caller can turn extraction off and still ask for a stage that reads the text (DocSlurp/app issue 599). */
const consumers: Array<[string, Record<string, unknown>]> = [
  ["defaults (embed)", { markdownExtraction: false }],
  ["PII scan only", { markdownExtraction: false, embed: false, indexVectors: false, piiPolicy: { enabled: true, patterns: ["email"], action: "block_indexing" } }],
  ["summary only", { markdownExtraction: false, embed: false, indexVectors: false, summarize: true }],
  ["page index only", { markdownExtraction: false, embed: false, indexVectors: false, pageIndex: true }],
  ["propositions only", { markdownExtraction: false, embed: false, indexVectors: false, propositionIndex: true }],
  ["structured extraction only", { markdownExtraction: false, embed: false, indexVectors: false, outputSchema: { type: "object", properties: { total: { type: "number" } } } }],
  ["graph", { markdownExtraction: false, graphRag: true }],
  ["HTML beside it", { markdownExtraction: false, htmlExtraction: true }],
  ["Fastest level with semantic search", { markdownExtraction: false, quality: "fastest", embed: true }],
];

describe("Markdown extraction under the VM-only parsing floor", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

  it.each(consumers)("%s: the override is accepted, and the run still extracts before any stage reads the text", (_name, override) => {
    const features = featuresOf(override);
    expect(features.markdownExtraction).toBe(false);
    const stored = getPipelineStageOrder(features);
    expect(stored.some((stage) => textConsumingStages.has(stage))).toBe(true);
    const run = coerceMarkdownExtractionForVmFloor({ pipeline: features }, true);
    const stages = getPipelineStageOrder(run.pipeline);
    expect(run.pipeline.markdownExtraction).toBe(true);
    const extract = stages.indexOf("extract-markdown");
    expect(extract).toBeGreaterThanOrEqual(0);
    for (const stage of stages.filter((name) => textConsumingStages.has(name))) expect(stages.indexOf(stage)).toBeGreaterThan(extract);
    // Development keeps the stored setting.
    expect(coerceMarkdownExtractionForVmFloor({ pipeline: features }, false).pipeline.markdownExtraction).toBe(false);
  });

  it.each([
    ["embed off", { markdownExtraction: false, embed: false, indexVectors: false, contextualChunkPreambles: false }],
    // Fastest without extraction plans no page index and no embedding.
    ["Fastest level", { markdownExtraction: false, quality: "fastest" }],
  ])("%s, no text-reading stage planned: extraction stays off and no stage reads the source", (_name, override) => {
    const features = featuresOf(override);
    const run = coerceMarkdownExtractionForVmFloor({ pipeline: features }, true);
    expect(run.pipeline).toBe(features);
    const stages = getPipelineStageOrder(run.pipeline);
    expect(stages).not.toContain("extract-markdown");
    expect(stages.filter((stage) => textConsumingStages.has(stage))).toEqual([]);
  });

  it("the worker's one hydration path applies it, so extract-markdown (which measures and bills Office and EPUB pages) runs", async () => {
    production();
    // A large DOCX uploaded with extraction "disabled": the stored run says off, the state every stage sees says on.
    const pipeline = featuresOf({ markdownExtraction: false });
    const run = { id: "run-1", orgId: "o1", projectId: "w1", stage: "queued", status: "processing", pipeline, stats: {}, artifacts: {} };
    const documents = [{ id: "doc-1", filename: "huge.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sourceKey: "raw/huge", pageCount: 1, status: "processing" }];
    const store = { loadRun: vi.fn(async () => structuredClone(run)), loadDocumentsForRun: vi.fn(async () => structuredClone(documents)), hydrateState: vi.fn(), pageBasisLedger: {} };
    const state = await loadRunState(store as never, "run-1", { hydrate: false });
    expect(state.run.pipeline.markdownExtraction).toBe(true);
    expect(getPipelineStageOrder(state.run.pipeline)).toContain("extract-markdown");
  });

  it.each([
    ["front-matter.md", "text/markdown"],
    ["page.html", "text/html"],
    ["notes.txt", "text/plain"],
    ["rows.csv", "text/csv"],
    ["data.json", "application/json"],
    ["scan.pdf", "application/pdf"],
  ])("%s with no extraction artifact: a typed refusal; the source is never staged, decoded or parsed", async (filename, mimeType) => {
    production();
    const runner = { run: vi.fn(), extractMarkdown: vi.fn(), extractText: vi.fn() };
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const document = { id: `doc-${filename}`, filename, mimeType, pageCount: 1, sourceKey: `raw/${filename}` } as never;
    const failure = await extractTextForEmbedding(document, runner as never, {} as never, undefined, undefined, undefined).catch((caught: unknown) => caught);
    expect(failure).toBeInstanceOf(SourceTextUnavailableError);
    expect(String((failure as Error).message)).toMatch(/^source-text-unavailable/);
    expect(error.mock.calls.flat().join(" ")).toContain("[parser-sandbox] status=refused reason=source-text-fallback");
    expect(integrity.readSourceBytes).not.toHaveBeenCalled();
    expect(integrity.stageSourceFile).not.toHaveBeenCalled();
    expect(runner.run).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it("the summary never reads the source file: no artifact means no summary source", async () => {
    production();
    // PII in places a converter drops (front matter, an HTML title, an unused link definition): the summary must never see
    // the raw file, only the extraction artifact the PII scan read.
    const raw = "---\nowner: jane.doe@private.test\n---\n<title>jane.doe@private.test</title>\n[x]: mailto:jane.doe@private.test\nBody.";
    const storage = { bucket: "b", objectSize: vi.fn(async () => raw.length), getByteRange: vi.fn(async () => Buffer.from(raw)) };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const mimeType of ["text/markdown", "text/html", "text/plain"]) {
      expect(await readSummarySource(storage, { id: "doc-1", sourceKey: "raw/doc-1", mimeType }, undefined)).toBeNull();
    }
    expect(storage.objectSize).not.toHaveBeenCalled();
    expect(storage.getByteRange).not.toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).toContain("no_summary_source");
    warn.mockRestore();
  });

  it("in development the source fallbacks still run (unchanged)", async () => {
    vi.mocked(integrity.readSourceBytes).mockResolvedValueOnce(Buffer.from("hello world") as never);
    const result = await extractTextForEmbedding({ id: "d", filename: "dev.txt", mimeType: "text/plain", pageCount: 1, sourceKey: "raw/d" } as never, {} as never, {} as never, undefined, undefined, undefined);
    expect(result).toMatchObject({ text: "hello world", extractor: "raw-text" });
    const storage = { bucket: "b", objectSize: vi.fn(async () => 5), getByteRange: vi.fn(async () => Buffer.from("hello")) };
    expect((await readSummarySource(storage, { id: "d", sourceKey: "raw/d", mimeType: "text/plain" }, undefined))?.text).toBe("hello");
  });
});

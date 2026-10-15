import { describe, expect, it, vi } from "vitest";

const sqlMock = Object.assign(vi.fn(), { unsafe: vi.fn(), array: vi.fn((v: unknown) => v), begin: vi.fn() });
vi.mock("../db.js", () => ({ sql: sqlMock }));
const getArtifactText = vi.hoisted(() => vi.fn());
vi.mock("../lib/artifacts.js", async (importOriginal) => ({ ...(await importOriginal<object>()), getArtifactText }));

const { readChunkLocator, mapChunk } = await import("../services/search.js");
const { searchCitationSchema } = await import("@docslurp/shared");
const { buildCanonicalChunksFromDocument, buildMediaCanonicalDocument } = await import("@docslurp/worker/testing");
const { searchChunkToResult, searchResultsToChunks } = await import("../search/session-execution.js");
const { readMediaSummary } = await import("../services/documents.js");

const media = { kind: "media", media: "video", startSeconds: 252, endSeconds: 270, durationSeconds: 3700, mode: "said", speaker: "Speaker 1", timing: "word", frameSeconds: [], boxes: [] };

describe("chunk locators on search results", () => {
  it("passes through a stored locator and falls back to the page for older chunks", () => {
    expect(readChunkLocator(media, 1)).toMatchObject({ kind: "media", speaker: "Speaker 1", startSeconds: 252 });
    expect(readChunkLocator(undefined, 7)).toEqual({ kind: "page", pageNumber: 7, charStart: null, charEnd: null, boxes: [] });
    expect(readChunkLocator({ kind: "slide" }, null)).toBeNull();
    // a locator of another kind that fails validation never degrades to a fake page 1
    expect(readChunkLocator({ kind: "media", media: "audio" }, 1)).toBeNull();
    // old recordings / decks / sheets have a placeholder page 1, so no page locator is invented
    expect(readChunkLocator(undefined, 1, { filename: "call.mp3" })).toBeNull();
    expect(readChunkLocator(undefined, 1, { filename: "x.bin", extractor: "media:deepinfra" })).toBeNull();
    expect(readChunkLocator(undefined, 1, { filename: "deck.PPTX" })).toBeNull();
    expect(readChunkLocator(undefined, 3, { filename: "report.pdf" })).toMatchObject({ kind: "page", pageNumber: 3 });
    const boxes = Array.from({ length: 80 }, () => ({ x: 0, y: 0, width: .1, height: .1 }));
    expect((readChunkLocator({ kind: "image", boxes }, null) as { boxes: unknown[] }).boxes).toHaveLength(32);
    expect(readChunkLocator(null, null)).toBeNull();
  });
  it("carries the locator on the citation and back into chunks", () => {
    const chunk = { id: "c", documentId: "d", runId: "r", chunkIndex: 3, text: "t", headingPath: [], pageNumber: 1, tokenEstimate: 1, score: 1, filename: "f.mp4",
      pageNumbers: [1], blockIds: [], blockTypes: [], evidenceType: null, canonicalDocumentUri: null, tableGranularity: null, tableRowIndex: null, tableRowCount: null,
      tableColumnNames: [], tableColumnTypes: [], tableCells: [], tableCell: null, regionBoxes: [], regions: [], regionCoordinateSpace: null, sourceTrace: null,
      locator: readChunkLocator(media, 1), source: "document" as const, retrievalStage: "full-index" as const };
    const result = searchChunkToResult(chunk);
    expect(result.citation.locator).toMatchObject({ kind: "media", mode: "said" });
    expect(searchResultsToChunks([result])[0]!.locator).toMatchObject({ kind: "media", endSeconds: 270 });
  });
});

describe("worker chunk metadata to citation", () => {
  it("keeps a media chunk's locator from the worker chunker through search mapping to the public citation schema", () => {
    const segments = [
      { start: 252, end: 262, text: "We decided to move the launch to the fourth quarter after the security review.", speaker: "Speaker 1", timing: "word" as const },
      { start: 262, end: 270, text: "Agreed, the budget holds either way.", speaker: "Speaker 1", timing: "word" as const },
    ];
    const { canonical } = buildMediaCanonicalDocument({ documentId: "doc", mediaKind: "video", durationSeconds: 3700, segments, visualSegments: [],
      sourceArtifactUri: "s3://b/call.mp4", extractor: "media:deepinfra" });
    const [chunk] = buildCanonicalChunksFromDocument(canonical, "call.mp4", { maxChars: 4000 });
    // embed.ts stores the chunk locator in chunk metadata (JSON round trip through Postgres jsonb)
    const metadata = JSON.parse(JSON.stringify({ locator: chunk!.locator, blockIds: chunk!.blockIds, sourceTrace: chunk!.sourceTrace ?? undefined }));
    const mapped = mapChunk({ id: "c", document_id: "doc", run_id: "r", chunk_index: 0, text: chunk!.text, heading_path: [], page_number: 1,
      token_estimate: 10, rank: 1, filename: "call.mp4", metadata }, 1);
    expect(mapped.locator).toMatchObject({ kind: "media", media: "video", startSeconds: 252, endSeconds: 270, speaker: "Speaker 1", mode: "said" });
    const result = searchChunkToResult(mapped);
    const citation = searchCitationSchema.parse(JSON.parse(JSON.stringify(result.citation)));
    expect(citation.locator).toMatchObject({ kind: "media", startSeconds: 252, endSeconds: 270 });
    // an old chunk of the same recording (no locator) must not claim page 1
    expect(mapChunk({ id: "c2", document_id: "doc", run_id: "r", chunk_index: 1, text: "[0.00-5.00s] hi", heading_path: [], page_number: 1,
      token_estimate: 3, rank: 1, filename: "call.mp4", metadata: {} }, 1).locator).toBeNull();
  });
  it("degrades one invalid locator to null instead of rejecting the whole citation list", () => {
    const good = { source: "document" as const, locator: media };
    const parsed = searchCitationSchema.pick({ source: true, locator: true }).array().parse([good, { ...good, locator: { kind: "media", media: "audio" } }]);
    expect(parsed).toHaveLength(2); expect(parsed[0]!.locator).toMatchObject({ kind: "media" }); expect(parsed[1]!.locator).toBeNull();
  });
});

describe("media summary on document detail", () => {
  const summary = { mediaKind: "video", durationSeconds: 3700, wordCount: 9000, speakerCount: 3, segmentCount: 400, keyframesIndexed: 120, framesWithText: 80,
    coverage: "audio-and-sampled-visual", ingestCostCents: 1.5, timing: "segment", diarized: true };
  it("reads the worker summary and prefers the ledger-attributed cost", async () => {
    getArtifactText.mockResolvedValue(JSON.stringify(summary));
    expect(await readMediaSummary({ summaryUri: "s3://b/k.json", withheld: new Set(), billedCostCents: null })).toMatchObject({ speakerCount: 3, ingestCostCents: 1.5 });
    expect(await readMediaSummary({ summaryUri: "s3://b/k.json", withheld: new Set(), billedCostCents: 4 })).toMatchObject({ ingestCostCents: 4 });
  });
  it("omits media for non-media, withheld, or unreadable summaries", async () => {
    expect(await readMediaSummary({ summaryUri: null, withheld: new Set(), billedCostCents: null })).toBeNull();
    expect(await readMediaSummary({ summaryUri: "s3://b/k.json", withheld: new Set(["s3://b/k.json"]), billedCostCents: null })).toBeNull();
    getArtifactText.mockResolvedValue("not json");
    expect(await readMediaSummary({ summaryUri: "s3://b/k.json", withheld: new Set(), billedCostCents: null })).toBeNull();
  });
});

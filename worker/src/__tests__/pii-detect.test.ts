import { describe, expect, it } from "vitest";

import { normalizePipelineFeatures, PII_BLOCKED_DOCUMENT_STATUS, type CanonicalDocument, type PiiMatch } from "@docslurp/shared";

import { fromEnv } from "../config.js";
import { buildCanonicalChunksFromDocument } from "../lib/canonical-document.js";
import type { Document, WorkspaceRun } from "../models.js";
import { indexableDocuments, isPiiBlockedDocument } from "../pipeline/pii-gate.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { EmbedStage } from "../stages/embed.js";
import { extractTextForEmbedding } from "../stages/embedding-runtime.js";
import { PiiDetectStage, type PiiDetectionArtifact, type PiiDetectionSink, type PiiDocumentOutcome } from "../stages/pii-detect.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";

const BUCKET = "test-bucket";
const SSN = "123-45-6789";
const EMAIL = "jane.doe@private.test";

class MemoryStore {
  readonly bucket = BUCKET;
  readonly objects = new Map<string, string>();
  reads = 0;
  uri(key: string) { return `s3://${BUCKET}/${key}`; }
  async getBytes(key: string) {
    this.reads += 1;
    const value = this.objects.get(key);
    if (value === undefined) throw new Error(`missing ${key}`);
    return Buffer.from(value, "utf8");
  }
  async getJson<T>(key: string): Promise<T> { return JSON.parse((await this.getBytes(key)).toString("utf8")) as T; }
  async putJson(key: string, value: unknown) { this.objects.set(key, JSON.stringify(value)); }
  async streamText(key: string, text: string) { this.objects.set(key, text); }
  json<T>(key: string): T { return JSON.parse(this.objects.get(key) ?? "null") as T; }
}

class RecordingSink implements PiiDetectionSink {
  detections: Array<{ documentId: string; matches: PiiMatch[]; redacted: boolean }> = [];
  outcomes: Array<{ documentId: string; outcome: PiiDocumentOutcome }> = [];
  async recordDetections(documentId: string, _runId: string, matches: PiiMatch[], redacted: boolean) {
    this.detections.push({ documentId, matches, redacted });
  }
  async setDocumentOutcome(documentId: string, outcome: PiiDocumentOutcome) {
    this.outcomes.push({ documentId, outcome });
  }
  async close() {}
}

function canonicalFor(documentId: string): CanonicalDocument {
  return {
    documentId,
    generator: "test",
    source: { format: "markdown", artifactUri: null, extractor: "test", parser: null, parserArtifactUri: null },
    stats: { blockCount: 3, headingCount: 1, paragraphCount: 1, codeBlockCount: 0, tableCount: 1, pageCount: 2 },
    blocks: [
      { id: "b1", type: "heading", order: 0, text: "Employee record", headingPath: [], pageNumber: 1, lineStart: null, lineEnd: null, bbox: null, metadata: {} },
      { id: "b2", type: "paragraph", order: 1, text: `Contact ${EMAIL} about payroll.`, headingPath: ["Employee record"], pageNumber: 1, lineStart: null, lineEnd: null, bbox: null, metadata: {} },
      {
        id: "b3", type: "table", order: 2,
        text: `| Name | SSN |\n| --- | --- |\n| Jane | ${SSN} |`,
        headingPath: ["Employee record"], pageNumber: 2, lineStart: null, lineEnd: null, bbox: null,
        metadata: { cells: [{ columnName: "SSN", rawValue: SSN }], sourceArtifactUri: "s3://test-bucket/raw/source.json" },
      },
    ],
  };
}

function setup(action: "flag_for_review" | "block_indexing" | "redact_artifacts", options: {
  allowlistPatterns?: string[];
  withExtraction?: boolean;
  sourceText?: string;
} = {}) {
  const storage = new MemoryStore();
  const sink = new RecordingSink();
  const documentId = "doc-1";
  const prefix = `u1/run-1`;
  const document: Document = {
    id: documentId, userId: "u1", runId: "run-1", filename: options.withExtraction === false ? "notes.txt" : "record.pdf",
    mimeType: options.withExtraction === false ? "text/plain" : "application/pdf",
    sourceKey: `${prefix}/source/${documentId}`, status: "processing", extractionMode: "hybrid", pageCount: 2,
    createdAt: new Date(), updatedAt: new Date(),
  };
  const artifacts: Record<string, string> = {};
  if (options.withExtraction !== false) {
    storage.objects.set(`${prefix}/markdown/candidate-a.md`, `# Employee record\n\nContact ${EMAIL} about payroll.\n\n| Name | SSN |\n| --- | --- |\n| Jane | ${SSN} |\n`);
    storage.objects.set(`${prefix}/canonical/${documentId}.json`, JSON.stringify(canonicalFor(documentId)));
    storage.objects.set(`${prefix}/html/${documentId}.html`, `<p>Contact <a href="mailto:${EMAIL}">${EMAIL}</a></p><td>${SSN}</td>`);
    storage.objects.set(`${prefix}/extraction/${documentId}.contract.json`, JSON.stringify({
      documentId, artifactUri: storage.uri(`${prefix}/markdown/candidate-a.md`),
      pages: [{ pageNumber: 2, text: `Jane ${SSN}` }],
    }));
    artifacts[`${documentId}:markdown`] = storage.uri(`${prefix}/markdown/candidate-a.md`);
    artifacts[`${documentId}:canonical-document`] = storage.uri(`${prefix}/canonical/${documentId}.json`);
    artifacts[`${documentId}:html`] = storage.uri(`${prefix}/html/${documentId}.html`);
    artifacts[`${documentId}:extraction-contract`] = storage.uri(`${prefix}/extraction/${documentId}.contract.json`);
    // Debug artifacts written before pii-detect that it does not rewrite.
    artifacts[`${documentId}:pymupdf-json`] = storage.uri(`${prefix}/parsers/${documentId}.pymupdf.json`);
    artifacts[`${documentId}:vision`] = storage.uri(`${prefix}/vision/${documentId}.json`);
    artifacts[`${documentId}:images`] = storage.uri(`${prefix}/images/${documentId}/manifest.json`);
    artifacts[`${documentId}:retryCount`] = "1";
  } else {
    storage.objects.set(document.sourceKey, options.sourceText ?? "");
  }
  const pipeline = normalizePipelineFeatures({
    piiPolicy: {
      enabled: true,
      patterns: ["ssn", "email"],
      action,
      allowlistPatterns: options.allowlistPatterns ?? [],
    },
  });
  const run = { id: "run-1", userId: "u1", orgId: "o1", workspaceId: "w1", stage: "pii-detect", status: "processing", pipeline, stats: {}, artifacts } as unknown as WorkspaceRun;
  const state = WorkflowState.create(run, [document]);
  const stage = new PiiDetectStage({} as CommandRunner, storage as unknown as ArtifactStore, fromEnv(), sink);
  return { storage, sink, state, stage, document, prefix, documentId };
}

function piiArtifact(storage: MemoryStore, prefix: string, documentId: string) {
  return storage.json<PiiDetectionArtifact>(`${prefix}/pii/${documentId}.json`);
}

describe("piiPolicy flag_for_review", () => {
  it("records detections and a review flag without touching artifacts or indexing", async () => {
    const { storage, sink, state, stage, document, prefix, documentId } = setup("flag_for_review");
    const before = new Map(storage.objects);

    await stage.run(state);

    expect(sink.detections[0]?.matches.map((match) => [match.patternType, match.pageNumber])).toEqual([
      ["email", 1],
      ["ssn", 2],
    ]);
    expect(sink.detections[0]?.redacted).toBe(false);
    expect(sink.outcomes[0]?.outcome).toMatchObject({ reviewRequired: true, blocked: false, redacted: false, matchCount: 2 });
    for (const [key, value] of before) expect(storage.objects.get(key)).toBe(value);
    expect(document.status).not.toBe(PII_BLOCKED_DOCUMENT_STATUS);
    expect(indexableDocuments(state)).toEqual([document]);
    expect(piiArtifact(storage, prefix, documentId)).toMatchObject({ reviewRequired: true, matchCount: 2 });
    // Fingerprints only; the raw values never reach the audit trail.
    expect(JSON.stringify(sink.detections)).not.toContain(SSN);
    expect(JSON.stringify(piiArtifact(storage, prefix, documentId))).not.toContain(EMAIL);
  });
});

describe("piiPolicy block_indexing", () => {
  it("marks the document blocked with a reason and keeps it out of every index stage", async () => {
    const { sink, state, stage, document } = setup("block_indexing");

    await stage.run(state);

    expect(document.status).toBe(PII_BLOCKED_DOCUMENT_STATUS);
    expect(sink.outcomes[0]?.outcome).toMatchObject({ blocked: true, matchCount: 2, patternTypes: ["email", "ssn"], reason: expect.any(String) });
    expect(state.documentStage(document.id, "pii-detect")?.stats).toMatchObject({ blocked: true });
    expect(indexableDocuments(state)).toEqual([]);
  });

  it("stays blocked from the checkpoint even if the status was overwritten", async () => {
    const { state, stage, document } = setup("block_indexing");
    await stage.run(state);
    document.status = "pii-detect";

    expect(isPiiBlockedDocument(state, document)).toBe(true);
    expect(indexableDocuments(state)).toEqual([]);
  });

  it("embed never reads a blocked document's text", async () => {
    const { storage, state, stage } = setup("block_indexing");
    await stage.run(state);
    state.run.pipeline = normalizePipelineFeatures({ ...state.run.pipeline, embed: true });
    const readsBefore = storage.reads;

    await new EmbedStage({} as CommandRunner, storage as unknown as ArtifactStore, fromEnv()).run(state);

    expect(storage.reads).toBe(readsBefore);
    expect(state.documentStage("doc-1", "embed")).toBeUndefined();
  });

  it("does not block a clean document", async () => {
    const { sink, state, stage, document } = setup("block_indexing", { withExtraction: false, sourceText: "Nothing sensitive here." });
    await stage.run(state);

    expect(document.status).toBe("processing");
    expect(sink.outcomes[0]?.outcome).toMatchObject({ blocked: false, matchCount: 0, reason: null });
    expect(indexableDocuments(state)).toEqual([document]);
  });
});

describe("piiPolicy redact_artifacts", () => {
  it("redacts the canonical document, markdown, HTML and contract that later stages read", async () => {
    const { storage, sink, state, stage, prefix, documentId } = setup("redact_artifacts");

    await stage.run(state);

    const canonical = storage.json<CanonicalDocument>(`${prefix}/canonical/${documentId}.json`);
    const everything = [...storage.objects.values()].join("\n");
    expect(everything).not.toContain(SSN);
    expect(everything).not.toContain(EMAIL);
    expect(canonical.blocks[1]?.text).toBe("Contact [REDACTED:email] about payroll.");
    expect(canonical.blocks[2]?.metadata).toMatchObject({
      cells: [{ columnName: "SSN", rawValue: "[REDACTED:ssn]" }],
      // Identifier fields are left intact so artifacts still link up.
      sourceArtifactUri: "s3://test-bucket/raw/source.json",
    });
    expect(sink.detections[0]?.redacted).toBe(true);
    expect(piiArtifact(storage, prefix, documentId).redactedArtifacts.sort()).toEqual(
      ["canonical-document", "extraction-contract", "html", "markdown"],
    );

    // What embed would chunk and index is the redacted text.
    const chunks = buildCanonicalChunksFromDocument(canonical, "record.pdf");
    expect(chunks.map((chunk) => chunk.text).join("\n")).toContain("[REDACTED:ssn]");
    expect(JSON.stringify(chunks)).not.toContain(SSN);
    const extracted = await extractTextForEmbedding(
      state.documents[0]!, {} as CommandRunner, storage as unknown as ArtifactStore,
      state.artifactLedger.readDocument(documentId, "markdown"), undefined,
      state.artifactLedger.readDocument(documentId, "canonical-document"),
    );
    expect(extracted.text).toContain("[REDACTED:email]");
    expect(extracted.text).not.toContain(EMAIL);
  });

  it("writes a redacted markdown artifact when embed would otherwise read the raw source", async () => {
    const { storage, state, stage, documentId } = setup("redact_artifacts", {
      withExtraction: false,
      sourceText: `Reach me at ${EMAIL}.`,
    });

    await stage.run(state);

    const markdownUri = state.artifactLedger.readDocument(documentId, "markdown");
    expect(markdownUri).toBe(storage.uri(`u1/run-1/pii/${documentId}.redacted.md`));
    const extracted = await extractTextForEmbedding(
      state.documents[0]!, {} as CommandRunner, storage as unknown as ArtifactStore, markdownUri, undefined, undefined,
    );
    expect(extracted.text).toBe("Reach me at [REDACTED:email].");
  });
});

describe("piiPolicy allowlistPatterns", () => {
  it("suppresses allowlisted values from detection and redaction", async () => {
    const { storage, sink, stage, state, prefix, documentId } = setup("redact_artifacts", {
      allowlistPatterns: [".*@private\\.test"],
    });

    await stage.run(state);

    expect(sink.detections[0]?.matches.map((match) => match.patternType)).toEqual(["ssn"]);
    const canonical = storage.json<CanonicalDocument>(`${prefix}/canonical/${documentId}.json`);
    expect(canonical.blocks[1]?.text).toContain(EMAIL);
    expect(canonical.blocks[2]?.text).not.toContain(SSN);
  });

  it("does not block a document whose only matches are allowlisted", async () => {
    const { sink, stage, state, document } = setup("block_indexing", {
      allowlistPatterns: [".*@private\\.test", "123-45-6789"],
    });

    await stage.run(state);

    expect(sink.outcomes[0]?.outcome).toMatchObject({ blocked: false, matchCount: 0 });
    expect(document.status).not.toBe(PII_BLOCKED_DOCUMENT_STATUS);
  });
});

describe("piiPolicy withheld debug artifacts", () => {
  const debugUris = [
    "s3://test-bucket/u1/run-1/images/doc-1/manifest.json",
    "s3://test-bucket/u1/run-1/parsers/doc-1.pymupdf.json",
    "s3://test-bucket/u1/run-1/source/doc-1",
    "s3://test-bucket/u1/run-1/vision/doc-1.json",
  ];

  it("redact_artifacts withholds everything it did not rewrite, including the source", async () => {
    const { sink, state, stage } = setup("redact_artifacts");
    await stage.run(state);

    expect(sink.outcomes[0]?.outcome.withheldArtifactUris).toEqual(debugUris);
  });

  it("block_indexing withholds every artifact, including the unredacted markdown and canonical", async () => {
    const { sink, state, stage } = setup("block_indexing");
    await stage.run(state);

    const withheld = sink.outcomes[0]?.outcome.withheldArtifactUris ?? [];
    expect(withheld).toEqual(expect.arrayContaining([
      ...debugUris,
      "s3://test-bucket/u1/run-1/markdown/candidate-a.md",
      "s3://test-bucket/u1/run-1/canonical/doc-1.json",
      "s3://test-bucket/u1/run-1/html/doc-1.html",
      "s3://test-bucket/u1/run-1/extraction/doc-1.contract.json",
    ]));
    expect(withheld.some((uri) => uri.includes("/pii/"))).toBe(false);
  });

  it("flag_for_review and clean documents withhold nothing", async () => {
    const flagged = setup("flag_for_review");
    await flagged.stage.run(flagged.state);
    expect(flagged.sink.outcomes[0]?.outcome.withheldArtifactUris).toEqual([]);

    const clean = setup("redact_artifacts", { withExtraction: false, sourceText: "Nothing sensitive." });
    await clean.stage.run(clean.state);
    expect(clean.sink.outcomes[0]?.outcome.withheldArtifactUris).toEqual([]);
  });

  it("keeps the redacted fallback markdown servable", async () => {
    const { sink, state, stage } = setup("redact_artifacts", { withExtraction: false, sourceText: `Mail ${EMAIL}` });
    await stage.run(state);
    expect(sink.outcomes[0]?.outcome.withheldArtifactUris).toEqual(["s3://test-bucket/u1/run-1/source/doc-1"]);
  });
});

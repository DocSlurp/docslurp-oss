import { describe, expect, it } from "vitest";

import type { Document, StageState } from "../models.js";
import {
  buildRunProgressEvent,
  calculateRunProgressLedger,
  getPageProgressForDocumentStage,
  type PageProgress,
  type RunProgressState,
  recordPageProgress,
  refreshRunProgressStats,
} from "../pipeline/run-ledger.js";

function document(id: string, pageCount: number): Document {
  return {
    id,
    userId: "user-1",
    runId: "run-1",
    filename: `${id}.pdf`,
    mimeType: "application/pdf",
    sourceKey: `user-1/run-1/raw/${id}.pdf`,
    status: "queued",
    extractionMode: "hybrid",
    pageCount,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function stage(
  documentId: string | undefined,
  stageName: string,
  status: string,
): StageState {
  return {
    runId: "run-1",
    documentId,
    stageName,
    status,
    attempts: 1,
    artifactUri: "",
    stats: {},
    error: "",
    startedAt: null,
    completedAt: null,
    updatedAt: new Date(),
  };
}

function progressState(
  documents: Document[],
  overrides: Partial<RunProgressState> = {},
): RunProgressState {
  return {
    run: {
      id: "run-1",
      userId: "user-1",
      status: "processing",
      stats: {},
      processedDocuments: 0,
      totalDocuments: documents.length,
      pagesProcessed: 0,
      pagesTotal: documents.reduce((sum, doc) => sum + doc.pageCount, 0),
    },
    documents,
    stage: "extract",
    totalStages: 2,
    runStages: new Map(),
    documentStages: new Map(),
    pageProgress: new Map(),
    ...overrides,
  };
}

describe("run progress ledger", () => {
  it("aggregates run, document, and page progress into one snapshot", () => {
    const docs = [document("doc-1", 4), document("doc-2", 2)];
    const documentStages = new Map<string, Map<string, StageState>>([
      [
        "doc-1",
        new Map([
          ["extract", stage("doc-1", "extract", "completed")],
          ["embed", stage("doc-1", "embed", "processing")],
        ]),
      ],
      [
        "doc-2",
        new Map([["extract", stage("doc-2", "extract", "failed")]]),
      ],
    ]);
    const pageProgress: PageProgress[] = [
      {
        documentId: "doc-1",
        stageName: "embed",
        pageNumber: 1,
        pageCount: 4,
        status: "completed",
      },
      {
        documentId: "doc-1",
        stageName: "embed",
        pageNumber: 2,
        pageCount: 4,
        status: "processing",
      },
    ];

    const ledger = calculateRunProgressLedger({
      documents: docs,
      stage: "embed",
      totalStages: 2,
      runStages: [
        stage(undefined, "extract", "completed"),
        stage(undefined, "embed", "processing"),
      ],
      documentStages: documentStages.entries(),
      pageProgress,
    });

    expect(ledger.completedStages).toBe(1);
    expect(ledger.failedDocumentStages).toBe(1);
    expect(ledger.processingDocumentStages).toBe(1);
    expect(ledger.stageCompletionRatio).toBe(0.5);
    expect(ledger.percentComplete).toBe(31);
    expect(ledger.currentStagePageProgress).toEqual({
      stage: "embed",
      totalPages: 4,
      completedPages: 1,
      percentPages: 25,
    });
    expect(ledger.docsProgress[0]).toMatchObject({
      documentId: "doc-1",
      stage: "embed",
      status: "processing",
      pagesCompleted: 1,
      percentComplete: 50,
    });
  });

  it("summarizes page progress for a document stage", () => {
    const progress: PageProgress[] = [
      {
        documentId: "doc-1",
        stageName: "extract",
        pageNumber: 1,
        pageCount: 3,
        status: "completed",
      },
      {
        documentId: "doc-1",
        stageName: "extract",
        pageNumber: 2,
        pageCount: 3,
        status: "failed",
      },
      {
        documentId: "doc-2",
        stageName: "extract",
        pageNumber: 1,
        pageCount: 1,
        status: "completed",
      },
    ];

    expect(getPageProgressForDocumentStage(progress, "doc-1", "extract"))
      .toEqual({
        completed: 1,
        failed: 1,
        total: 3,
      });
  });

  it("records page progress and builds the public page progress event shape", () => {
    const docs = [document("doc-1", 4)];
    const state = progressState(docs, {
      documentStages: new Map([
        [
          "doc-1",
          new Map([["extract", stage("doc-1", "extract", "processing")]]),
        ],
      ]),
    });

    recordPageProgress(state, {
      documentId: "doc-1",
      stageName: "extract",
      pageNumber: 1,
      pageCount: 4,
      status: "completed",
    });

    expect(state.run.pagesProcessed).toBe(1);
    expect(state.run.stats.percentComplete).toBe(13);

    expect(
      buildRunProgressEvent(state, {
        kind: "page",
        documentId: "doc-1",
        stageName: "extract",
        pageNumber: 1,
        pageCount: 4,
        pageStatus: "completed",
        extraStats: { strategy: "ocr" },
      }),
    ).toMatchObject({
      userId: "user-1",
      runId: "run-1",
      documentId: "doc-1",
      stageName: "extract",
      eventType: "run.progress",
      status: "processing",
      progress: {
        stage: "extract",
        documentId: "doc-1",
        pageNumber: 1,
        pageCount: 4,
        pageStatus: "completed",
        percentComplete: 13,
        completedDocumentStages: 0,
        processingDocumentStages: 1,
        failedDocumentStages: 0,
        totalDocuments: 1,
        pagesProcessed: 1,
        pagesTotal: 4,
        strategy: "ocr",
      },
    });
  });

  it("builds document and stage progress events from ledger stats", () => {
    const docs = [document("doc-1", 2), document("doc-2", 3)];
    const state = progressState(docs, {
      stage: "embed",
      documentStages: new Map([
        [
          "doc-1",
          new Map([["embed", stage("doc-1", "embed", "completed")]]),
        ],
        [
          "doc-2",
          new Map([["embed", stage("doc-2", "embed", "failed")]]),
        ],
      ]),
    });

    refreshRunProgressStats(state);

    expect(
      buildRunProgressEvent(state, {
        kind: "document-stage",
        documentId: "doc-2",
        stageName: "embed",
        outcome: "failed",
        error: "embedding failed",
        payload: {
          error: "embedding failed",
          partialArtifactUri: null,
          attempts: 2,
        },
      }),
    ).toMatchObject({
      eventType: "run.progress",
      status: "failed",
      progress: {
        stage: "embed",
        documentId: "doc-2",
        completedDocumentStages: 1,
        failedDocumentStages: 1,
        totalDocuments: 2,
      },
      payload: {
        error: "embedding failed",
        partialArtifactUri: null,
        attempts: 2,
      },
    });

    expect(
      buildRunProgressEvent(state, {
        kind: "stage",
        stageName: "embed",
        outcome: "completed",
      }),
    ).toMatchObject({
      eventType: "run.progress",
      status: "processing",
      progress: {
        stage: "embed",
        completedDocumentStages: 1,
        failedDocumentStages: 1,
        totalDocuments: 2,
      },
    });
  });
});

import { isTerminalDocumentStatus } from "@docslurp/shared";

import type {
  Document,
  JsonMap,
  StageState,
  WorkspaceRun,
  WorkspaceRunEvent,
} from "../models.js";

export interface PageProgress {
  documentId: string;
  stageName: string;
  pageNumber: number;
  pageCount: number;
  status: "completed" | "failed" | "processing";
}

export interface RunProgressLedgerInput {
  documents: Document[];
  stage: string;
  totalStages: number;
  runStages: Iterable<StageState>;
  documentStages: Iterable<[string, Map<string, StageState>]>;
  pageProgress: Iterable<PageProgress>;
}

export interface RunProgressLedger {
  completedStages: number;
  failedStages: number;
  completedDocumentStages: number;
  failedDocumentStages: number;
  /** Documents with at least one failed stage; the Run skips them and carries on. */
  failedDocuments: number;
  processingDocumentStages: number;
  documents: number;
  totalStages: number;
  stageCompletionRatio?: number;
  percentComplete: number;
  docsProgress: Array<{
    documentId: string;
    stage: string;
    status: string;
    pagesTotal: number;
    percentComplete: number;
    pagesCompleted: number;
    pagesFailed: number;
  }>;
  currentStagePageProgress: {
    stage: string;
    totalPages: number;
    completedPages: number;
    percentPages: number;
  };
}

export interface RunProgressState {
  run: Pick<
    WorkspaceRun,
    | "id"
    | "userId"
    | "status"
    | "stats"
    | "processedDocuments"
    | "totalDocuments"
    | "pagesProcessed"
    | "pagesTotal"
  >;
  documents: Document[];
  stage: string;
  totalStages: number;
  runStages: Map<string, StageState>;
  documentStages: Map<string, Map<string, StageState>>;
  pageProgress: Map<string, PageProgress>;
}

export interface PageProgressUpdate {
  documentId: string;
  stageName: string;
  pageNumber: number;
  pageCount: number;
  status: PageProgress["status"];
}

export type RunProgressEventIntent =
  | {
      kind: "document-stage";
      documentId: string;
      stageName: string;
      outcome: "completed" | "failed";
      error?: string;
      payload?: JsonMap;
    }
  | {
      kind: "page";
      documentId: string;
      stageName: string;
      pageNumber: number;
      pageCount: number;
      pageStatus: PageProgress["status"];
      extraStats?: JsonMap;
    }
  | {
      kind: "stage";
      stageName: string;
      outcome: "completed";
    }
  | {
      kind: "heartbeat";
      stageName: string;
      metrics: JsonMap;
      completedDocumentStages?: number;
      failedDocumentStages?: number;
    };

export function refreshRunProgressStats(
  state: RunProgressState,
): RunProgressLedger {
  const ledger = calculateRunProgressLedger({
    documents: state.documents,
    stage: state.stage,
    totalStages: state.totalStages,
    runStages: state.runStages.values(),
    documentStages: state.documentStages.entries(),
    pageProgress: state.pageProgress.values(),
  });

  Object.assign(state.run.stats, ledger);
  return ledger;
}

export function recordPageProgress(
  state: RunProgressState,
  update: PageProgressUpdate,
): PageProgress {
  const progress = { ...update };
  state.pageProgress.set(pageProgressKey(update), progress);
  refreshRunProgressStats(state);

  if (update.status === "completed") {
    state.run.pagesProcessed = Math.min(
      state.run.pagesTotal,
      (state.run.pagesProcessed ?? 0) + 1,
    );
  }

  return progress;
}

export function buildRunProgressEvent(
  state: RunProgressState,
  intent: RunProgressEventIntent,
): WorkspaceRunEvent {
  switch (intent.kind) {
    case "document-stage":
      return {
        userId: state.run.userId,
        runId: state.run.id,
        documentId: intent.documentId,
        stageName: intent.stageName,
        eventType: "run.progress",
        status: intent.outcome === "failed" ? "failed" : state.run.status,
        message:
          intent.outcome === "failed"
            ? `document ${intent.documentId} ${intent.stageName} failed: ${intent.error ?? ""}`
            : `document ${intent.documentId} ${intent.stageName} completed`,
        progress: documentStageProgress(state, intent.stageName, intent.documentId),
        stats: state.run.stats,
        ...(intent.payload ? { payload: intent.payload } : {}),
      };
    case "page":
      return {
        userId: state.run.userId,
        runId: state.run.id,
        documentId: intent.documentId,
        stageName: intent.stageName,
        eventType: "run.progress",
        status: state.run.status,
        message:
          `document ${intent.documentId} ${intent.stageName} ` +
          `page ${intent.pageNumber}/${intent.pageCount} ${intent.pageStatus}`,
        progress: {
          ...documentStageProgress(state, intent.stageName, intent.documentId),
          pageNumber: intent.pageNumber,
          pageCount: intent.pageCount,
          pageStatus: intent.pageStatus,
          pagesProcessed: state.run.pagesProcessed,
          pagesTotal: state.run.pagesTotal,
          ...(intent.extraStats ?? {}),
        },
        stats: state.run.stats,
      };
    case "stage":
      return {
        userId: state.run.userId,
        runId: state.run.id,
        stageName: intent.stageName,
        eventType: "run.progress",
        status: state.run.status,
        message: `stage ${intent.stageName} completed`,
        progress: stageProgress(state, intent.stageName),
        stats: state.run.stats,
      };
    case "heartbeat":
      return {
        userId: state.run.userId,
        runId: state.run.id,
        eventType: "run.progress",
        status: state.run.status,
        message: `heartbeat during ${intent.stageName}`,
        progress: {
          ...stageProgress(state, intent.stageName),
          completedDocumentStages:
            intent.completedDocumentStages ??
            numericStat(state, "completedDocumentStages"),
          failedDocumentStages:
            intent.failedDocumentStages ?? numericStat(state, "failedDocumentStages"),
          ...intent.metrics,
        },
        stats: state.run.stats,
      };
  }
}

export function buildRunStartedEvent(
  state: RunProgressState,
  message: string,
): WorkspaceRunEvent {
  return {
    userId: state.run.userId,
    runId: state.run.id,
    eventType: "run.started",
    status: state.run.status,
    message,
    progress: {
      stage: state.stage,
    },
    stats: state.run.stats,
  };
}

export function buildRunCompletedEvent(
  state: RunProgressState,
  message: string,
): WorkspaceRunEvent {
  return {
    userId: state.run.userId,
    runId: state.run.id,
    eventType: "run.completed",
    status: "completed",
    message,
    progress: {
      processedDocuments: state.run.processedDocuments,
      totalDocuments: state.run.totalDocuments,
      pagesProcessed: state.run.pagesProcessed,
      pagesTotal: state.run.pagesTotal,
    },
    stats: state.run.stats,
  };
}

export function calculateRunProgressLedger(
  input: RunProgressLedgerInput,
): RunProgressLedger {
  let completedStages = 0;
  let failedStages = 0;
  let completedDocumentStages = 0;
  let failedDocumentStages = 0;
  let processingDocumentStages = 0;

  const documentStageEntries = Array.from(input.documentStages);
  const failedDocumentIds = new Set<string>();
  const pageProgress = Array.from(input.pageProgress);

  for (const stageState of input.runStages) {
    if (stageState.status === "completed") {
      completedStages += 1;
    } else if (stageState.status === "failed") {
      failedStages += 1;
    }
  }

  for (const [documentId, stages] of documentStageEntries) {
    for (const stageState of stages.values()) {
      if (stageState.status === "completed") {
        completedDocumentStages += 1;
      } else if (stageState.status === "failed") {
        failedDocumentStages += 1;
        failedDocumentIds.add(documentId);
      } else if (stageState.status === "processing") {
        processingDocumentStages += 1;
      }
    }
  }

  const totalDocs = Math.max(1, input.documents.length);
  const expectedDocStagesPerDoc = Math.max(1, input.totalStages);
  const totalDocWorkUnits = totalDocs * expectedDocStagesPerDoc;
  const percentComplete =
    totalDocWorkUnits > 0
      ? calculatePercentComplete({
          documentStageEntries,
          documents: input.documents,
          completedDocumentStages,
          failedDocumentIds,
          expectedDocStagesPerDoc,
          pageProgress,
          totalDocWorkUnits,
        })
      : 0;

  const docsProgress = input.documents.map((doc) => {
    const stages = documentStageEntries.find(([id]) => id === doc.id)?.[1];
    let docCompleted = 0;
    let currentStageName = input.stage;
    let currentStatus = isTerminalDocumentStatus(doc.status) ? doc.status : "queued";

    if (stages) {
      for (const [name, stageState] of stages) {
        if (stageState.status === "completed") {
          docCompleted += 1;
        } else if (stageState.status === "processing") {
          currentStageName = name;
          currentStatus = "processing";
        }
      }
    }

    const pageProg = getPageProgressForDocumentStage(
      pageProgress,
      doc.id,
      currentStageName,
    );

    return {
      documentId: doc.id,
      stage: currentStageName,
      status: currentStatus,
      pagesTotal: doc.pageCount,
      percentComplete: Math.round(
        (docCompleted / expectedDocStagesPerDoc) * 100,
      ),
      pagesCompleted: pageProg.completed,
      pagesFailed: pageProg.failed,
    };
  });

  let totalPagesCurrentStage = 0;
  let completedPagesCurrentStage = 0;
  for (const doc of input.documents) {
    const progress = getPageProgressForDocumentStage(
      pageProgress,
      doc.id,
      input.stage,
    );
    if (progress.total > 0) {
      totalPagesCurrentStage += progress.total;
      completedPagesCurrentStage += progress.completed;
    }
  }

  return {
    completedStages,
    failedStages,
    completedDocumentStages,
    failedDocumentStages,
    failedDocuments: failedDocumentIds.size,
    processingDocumentStages,
    documents: input.documents.length,
    totalStages: input.totalStages,
    ...(input.totalStages > 0
      ? { stageCompletionRatio: completedStages / input.totalStages }
      : {}),
    percentComplete,
    docsProgress,
    currentStagePageProgress: {
      stage: input.stage,
      totalPages: totalPagesCurrentStage,
      completedPages: completedPagesCurrentStage,
      percentPages:
        totalPagesCurrentStage > 0
          ? Math.round(
              (completedPagesCurrentStage / totalPagesCurrentStage) * 100,
            )
          : 0,
    },
  };
}

function calculatePercentComplete(args: {
  documentStageEntries: Array<[string, Map<string, StageState>]>;
  documents: Document[];
  completedDocumentStages: number;
  failedDocumentIds: ReadonlySet<string>;
  expectedDocStagesPerDoc: number;
  pageProgress: PageProgress[];
  totalDocWorkUnits: number;
}): number {
  let weightedCompleted = args.completedDocumentStages;

  for (const [docId, stages] of args.documentStageEntries) {
    const doc = args.documents.find((candidate) => candidate.id === docId);
    if (!doc) {
      continue;
    }

    // A failed Document is finished: later stages skip it, so count its
    // unfinished stages as done and let the Run reach 100%.
    if (args.failedDocumentIds.has(docId)) {
      const completed = Array.from(stages.values()).filter((stage) => stage.status === "completed").length;
      weightedCompleted += Math.max(0, args.expectedDocStagesPerDoc - completed);
      continue;
    }

    for (const [stageName, stageState] of stages) {
      if (stageState.status !== "processing") {
        continue;
      }

      const pageProgress = getPageProgressForDocumentStage(
        args.pageProgress,
        docId,
        stageName,
      );
      if (pageProgress.total > 0) {
        weightedCompleted += Math.max(
          0.1,
          pageProgress.completed / pageProgress.total,
        );
      } else {
        weightedCompleted += 0.5;
      }
    }
  }

  const ratio = weightedCompleted / args.totalDocWorkUnits;
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

export function getPageProgressForDocumentStage(
  pageProgress: Iterable<PageProgress>,
  documentId: string,
  stageName: string,
): { completed: number; failed: number; total: number } {
  let completed = 0;
  let failed = 0;
  let total = 0;
  for (const progress of pageProgress) {
    if (
      progress.documentId === documentId &&
      progress.stageName === stageName
    ) {
      total = Math.max(total, progress.pageCount);
      if (progress.status === "completed") {
        completed += 1;
      } else if (progress.status === "failed") {
        failed += 1;
      }
    }
  }
  return { completed, failed, total };
}

function pageProgressKey(update: PageProgressUpdate): string {
  return `${update.documentId}:${update.stageName}:${update.pageNumber}`;
}

function documentStageProgress(
  state: RunProgressState,
  stageName: string,
  documentId: string,
): JsonMap {
  return {
    stage: stageName,
    documentId,
    percentComplete: numericStat(state, "percentComplete"),
    completedDocumentStages: numericStat(state, "completedDocumentStages"),
    processingDocumentStages: numericStat(state, "processingDocumentStages"),
    failedDocumentStages: numericStat(state, "failedDocumentStages"),
    totalDocuments: state.documents.length,
  };
}

function stageProgress(
  state: RunProgressState,
  stageName: string,
): JsonMap {
  return {
    stage: stageName,
    percentComplete: numericStat(state, "percentComplete"),
    completedDocumentStages: numericStat(state, "completedDocumentStages"),
    failedDocumentStages: numericStat(state, "failedDocumentStages"),
    totalDocuments: state.documents.length,
  };
}

function numericStat(state: RunProgressState, key: string): number {
  const value = state.run.stats[key];
  return typeof value === "number" ? value : 0;
}

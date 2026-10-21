import type { PrivacyAuditEntry } from "@docslurp/shared";
import type { StageState, WorkspaceRunEvent } from "../models.js";
import type { Document, ParserEvaluation, PerformanceEvent, WorkspaceRun } from "../models.js";
import { cloneArtifacts, cloneJsonMap } from "../models.js";
import { DocumentArtifactLedger } from "./artifact-ledger.js";
import { PipelineUsageEventLedger } from "./usage-ledger.js";
import type { PageFactUpsert } from "./page-facts.js";
import {
  getPageProgressForDocumentStage,
  type PageProgress,
  refreshRunProgressStats,
} from "./run-ledger.js";

export interface CheckpointStore {
  updateProgress(state: WorkflowState): Promise<void>;
  startRunStage(state: WorkflowState, stage: string): Promise<void>;
  completeRunStage(
    state: WorkflowState,
    stage: string,
    artifactUri: string,
    stats: Record<string, unknown>
  ): Promise<void>;
  /** Returns the stage's ordinary failure total when the store tracks it. */
  failRunStage(state: WorkflowState, stage: string, message: string, options?: { countFailure?: boolean }): Promise<number | void>;
  startDocumentStage(state: WorkflowState, documentId: string, stage: string): Promise<void>;
  completeDocumentStage(
    state: WorkflowState,
    documentId: string,
    stage: string,
    artifactUri: string,
    stats: Record<string, unknown>
  ): Promise<void>;
  failDocumentStage(
    state: WorkflowState,
    documentId: string,
    stage: string,
    message: string,
    artifactUri?: string,
    stats?: Record<string, unknown>
  ): Promise<void>;
  appendEvent(event: WorkspaceRunEvent): Promise<void>;
  /**
   * Credit leases: true when the run's usage not yet checkpointed would use up
   * the lease this process last saw, so the caller should checkpoint now.
   */
  creditLeaseWouldExhaust?(state: WorkflowState): boolean;
  setPagesStageComplete?(runId: string, documentId: string, stageName: string, pageNumbers: number[]): Promise<void>;
  setPageStageComplete(runId: string, documentId: string, stageName: string, pageNumber: number): Promise<void>;
  getCompletedPages(runId: string, documentId: string, stageName: string): Promise<Set<number>>;
  recordPrivacyAudit?(entries: readonly PrivacyAuditEntry[]): Promise<void>;
  /** Per-page ingest facts (ingest report); best effort, idempotent per (document, page). */
  upsertPageFacts?(rows: readonly PageFactUpsert[]): Promise<void>;
}

export interface Stage {
  readonly name: string;
  run(state: WorkflowState, signal?: AbortSignal): Promise<void>;
}

export interface VectorIndex {
  documentId: string;
  backend: string;
  bucket: string;
  path: string;
  embeddingModel: string;
  dimension: number;
  /** Identity of the index config the vectors were built with (`documents.index_config_hash`). */
  indexConfigHash?: string;
}

export class WorkflowState {
  run: WorkspaceRun;
  documents: Document[];
  stage: string;
  artifacts: Record<string, string>;
  artifactLedger: DocumentArtifactLedger;
  readonly usageLedger = new PipelineUsageEventLedger();
  /**
   * Chunk ids the embed stage dropped (a retry that produced fewer chunks),
   * per document: the index stage deletes their LanceDB rows again once the
   * document's new rows are committed, so an earlier attempt's pending write
   * cannot bring them back.
   */
  readonly staleVectorIds = new Map<string, string[]>();
  pendingPerformance: PerformanceEvent[];
  pendingParserEvaluations: ParserEvaluation[];
  vectorIndexes: VectorIndex[];
  contentHashes: Map<string, string> = new Map();
  runStages: Map<string, StageState>;
  documentStages: Map<string, Map<string, StageState>>;
  store?: CheckpointStore;
  totalStages: number;
  docConcurrency = 1;
  distributedVisionPages = new Map<string, unknown>();
  /** Page-level progress for granular percent-complete computation */
  pageProgress: Map<string, PageProgress> = new Map();
  /** Last time updateProgress was called (throttle granular flushes) */
  lastProgressFlushAt = 0;
  /**
   * Set while this state runs one document shard of a stage beside other
   * shards: what the run row already holds from this state, so progress
   * checkpoints write only this shard's additions (see Store.writeProgress).
   */
  shard: { artifacts: Record<string, string> } | null = null;

  constructor(run: WorkspaceRun, documents: Document[]) {
    this.run = {
      ...run,
      stats: cloneJsonMap(run.stats),
      artifacts: cloneArtifacts(run.artifacts)
    };
    this.documents = documents;
    this.usageLedger.planId = run.orgPlanId ?? null;
    this.stage = run.stage;
    this.artifacts = this.run.artifacts;
    this.artifactLedger = DocumentArtifactLedger.create(
      this.artifacts,
      this.run.artifacts,
    );
    this.pendingPerformance = [];
    this.pendingParserEvaluations = [];
    this.vectorIndexes = [];
    this.runStages = new Map();
    this.documentStages = new Map();
    this.totalStages = 0;
  }

  static create(run: WorkspaceRun, documents: Document[]): WorkflowState {
    return new WorkflowState(run, documents);
  }

  runStageCompleted(stage: string): boolean {
    return this.runStages.get(stage)?.status === "completed";
  }

  documentStage(documentId: string, stage: string): StageState | undefined {
    return this.documentStages.get(documentId)?.get(stage);
  }

  setRunStage(stageState: StageState): void {
    this.runStages.set(stageState.stageName, stageState);
  }

  setDocumentStage(stageState: StageState): void {
    const stages = this.documentStages.get(stageState.documentId ?? "") ?? new Map<string, StageState>();
    stages.set(stageState.stageName, stageState);
    this.documentStages.set(stageState.documentId ?? "", stages);
  }

  replaceArtifacts(artifacts: Record<string, string>): void {
    this.artifacts = artifacts;
    this.run.artifacts = artifacts;
    this.artifactLedger.replace(this.artifacts, this.run.artifacts);
  }

  setPageProgress(documentId: string, stageName: string, pageNumber: number, pageCount: number, status: PageProgress["status"]): void {
    const key = `${documentId}:${stageName}:${pageNumber}`;
    this.pageProgress.set(key, { documentId, stageName, pageNumber, pageCount, status });
  }

  getPageProgressForDocumentStage(documentId: string, stageName: string): { completed: number; failed: number; total: number } {
    return getPageProgressForDocumentStage(
      this.pageProgress.values(),
      documentId,
      stageName,
    );
  }

  /** Narrow this state to one shard's documents (see `shard`). */
  beginShard(documentIds: readonly string[]): void {
    const ids = new Set(documentIds);
    this.documents = this.documents.filter((document) => ids.has(document.id));
    this.shard = { artifacts: { ...this.artifacts } };
  }

  refreshStats(): void {
    refreshRunProgressStats(this);
  }
}

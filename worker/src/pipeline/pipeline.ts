import type { GeoFinalSource } from "../db/geo-final-source.js";
import type { PrivacyAuditEntry } from "@docslurp/shared";
import type { StageState, ProjectRunEvent } from "../models.js";
import type { Document, ParserEvaluation, PerformanceEvent, ProjectRun } from "../models.js";
import { cloneArtifacts, cloneJsonMap } from "../models.js";
import { DocumentArtifactLedger } from "./artifact-ledger.js";
import { PipelineUsageEventLedger } from "./usage-ledger.js";
import type { DocumentContentWriter } from "../db/document-content.js";
import type { DocumentRecords } from "../db/document-records.js";
import type { DocumentAssets } from "../db/document-asset-ledger.js";
import type { FleetBudgets } from "../db/fleet-budgets.js";
import type { OcrEscalationLog } from "../db/ocr-escalation-reads.js";
import type { KnowledgeGraphStore } from "../graph/knowledge-graph-store.js";
import { runUsesOcrPageClass } from "./ocr-page-class.js";
import { PageBasis, type PageBasisLedger } from "./page-basis.js";
import {
  getPageProgressForDocumentStage,
  type PageProgress,
  refreshRunProgressStats,
} from "./run-ledger.js";

/**
 * The ports a run's stages write through, bound to every loaded state (WorkflowState.bindStore). Run and stage checkpoints
 * are the run ledger's own (db/run-ledger.ts); each other concern is a required port owned by its module, so a bound state never
 * probes for a capability and never skips a write because a method is missing. A state without a store (unit tests, a page
 * task that must not flush a stale run snapshot) has none of them; every caller decides explicitly what that means.
 */
export interface CheckpointStore {
  updateProgress(state: WorkflowState): Promise<void>;
  startRunStage(state: WorkflowState, stage: string): Promise<void>;
  completeRunStage(
    state: WorkflowState,
    stage: string,
    artifactUri: string,
    stats: Record<string, unknown>,
    options?: { readControlState?: boolean },
  ): Promise<{ controlRequested?: boolean } | void>;
  /** Returns the stage's ordinary failure total when the store tracks it. */
  failRunStage(state: WorkflowState, stage: string, message: string, options?: { countFailure?: boolean }): Promise<number | void>;
  startDocumentStage(state: WorkflowState, documentId: string, stage: string): Promise<void>;
  /**
   * Count one parser-sandbox infrastructure failure under this document's stage, durably across activity retries, and
   * return the new count (recheck S #2: a document that keeps breaking fresh VMs fails instead of retrying the stage).
   */
  noteSandboxInfrastructureStrike(state: WorkflowState, documentId: string, stage: string): Promise<number>;
  /** The same strike on a blamed document's row for the stage it last ran; null when it has no stage row in this run. */
  noteBlamedSandboxStrike(state: WorkflowState, documentId: string): Promise<number | null>;
  completeDocumentStage(
    state: WorkflowState,
    documentId: string,
    stage: string,
    artifactUri: string,
    stats: Record<string, unknown>,
    geoFinalSource?: GeoFinalSource,
  ): Promise<void>;
  failDocumentStage(
    state: WorkflowState,
    documentId: string,
    stage: string,
    message: string,
    artifactUri?: string,
    stats?: Record<string, unknown>,
    failure?: import("@docslurp/shared").DocumentFailure
  ): Promise<void>;
  appendEvent(event: ProjectRunEvent): Promise<void>;
  /**
   * Credit leases: true when the run's usage not yet checkpointed would use up
   * the lease this process last saw, so the caller should checkpoint now.
   */
  creditLeaseWouldExhaust(state: WorkflowState): boolean;
  setPagesStageComplete(runId: string, documentId: string, stageName: string, pageNumbers: number[]): Promise<void>;
  /** Stamps a run milestone once; null when already stamped (pipeline/run-milestones.ts). */
  markRunMilestone(runId: string, milestone: import("./run-milestones.js").RunMilestone): Promise<import("./run-milestones.js").RunMilestoneHit | null>;
  setPageStageComplete(runId: string, documentId: string, stageName: string, pageNumber: number): Promise<void>;
  getCompletedPages(runId: string, documentId: string, stageName: string): Promise<Set<number>>;
  /** Audit rows for provider calls the run's privacy mode blocked (lib/privacy-guard.ts). */
  recordPrivacyAudit(entries: readonly PrivacyAuditEntry[]): Promise<void>;
  /** Newest observed page-shard timings for one `${stage}:${executor}` profile (shard calibration). */
  loadShardObservations(profileKey: string, limit?: number): Promise<Array<{ pages: number; ms: number; maxRssMiB?: number }>>;
  /**
   * The page basis port (pipeline/page-basis.ts): document page counts, billing pages and the spend check they owe. Required:
   * a store without it does not type-check, so no state bound to a store can skip a page-count spend check.
   */
  readonly pageBasisLedger: PageBasisLedger;
  /** Search content a stage derives (db/document-content.ts): pages, chunks, propositions, summaries, page facts, reuse refs. */
  readonly content: DocumentContentWriter;
  /** Facts a stage settles on its document's row (db/document-records.ts): file facts, parse source, title, PII, geo. */
  readonly records: DocumentRecords;
  /** Figure rows beside each upload and the pages the host renders (db/document-asset-ledger.ts). */
  readonly assets: DocumentAssets;
  /** The project knowledge graph (graph/knowledge-graph-store.ts). */
  readonly graph: KnowledgeGraphStore;
  /** Reservations against caps every worker shares (db/fleet-budgets.ts). */
  readonly budgets: FleetBudgets;
  /** Each OCR escalation call, persisted as it returns (db/ocr-escalation-reads.ts). */
  readonly ocrEscalation: OcrEscalationLog;
}

export interface Stage {
  readonly name: string;
  run(state: WorkflowState, signal?: AbortSignal): Promise<void>;
  /**
   * Page-range shard: do the per-page work for only these pages, leaving document checkpoints,
   * manifests and ledger entries to the unsharded pass that follows (which must find the work
   * done and skip it). Stages without it reject page-range shards.
   */
  runPageRanges?(state: WorkflowState, ranges: ReadonlyMap<string, ReadonlyArray<{ first: number; last: number }>>, signal?: AbortSignal): Promise<void>;
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
  /** Expected generation from activity intent, not a fresh database row. */
  executionGeneration?: string | null;
  run: ProjectRun;
  documents: Document[];
  stage: string;
  artifacts: Record<string, string>;
  artifactLedger: DocumentArtifactLedger;
  readonly usageLedger: PipelineUsageEventLedger;
  /**
   * Chunk ids the embed stage dropped (a retry that produced fewer chunks),
   * per document: the index stage deletes their LanceDB rows again once the
   * document's new rows are committed, so an earlier attempt's pending write
   * cannot bring them back.
   */
  readonly staleVectorIds = new Map<string, string[]>();
  pendingPerformance: PerformanceEvent[];
  pendingParserEvaluations: ParserEvaluation[];
  /** Page extract records and tag merges (pipeline/page-extracts.ts) waiting for the next checkpoint. */
  pendingPageExtracts: import("./page-extracts.js").PageExtractRow[] = [];
  pendingPageExtractTags: import("./page-extracts.js").PageExtractTagMerge[] = [];
  /**
   * Document asset ledger writes (db/document-asset-ledger.ts) waiting for the checkpoint that records the documents'
   * Markdown and figure slots: the store writes them after that checkpoint commits, never before.
   */
  readonly pendingAssetLedger = new Map<string, import("../db/document-asset-ledger.js").PendingAssetLedgerWrite>();
  vectorIndexes: VectorIndex[];
  contentHashes: Map<string, string> = new Map();
  /** The document whose extraction registered each content hash (checkDedup never serves a document its own attempt). */
  contentHashOwners: Map<string, string> = new Map();
  runStages: Map<string, StageState>;
  documentStages: Map<string, Map<string, StageState>>;
  /** Set only through bindStore, which binds the page basis to the same store. */
  store?: CheckpointStore;
  /**
   * The run's page basis (pipeline/page-basis.ts): every page-count or billing-page change and the spend check it owes go
   * through it. Unbound (refusing every operation) until bindStore; tests bind an in-memory one (page-basis-memory.ts).
   */
  pageBasis: PageBasis;
  /**
   * The run's workflow recorded the first pass (pipeline/first-pass.ts): format-detect leaves first-pass PDFs' page counts to
   * the batch, which measures them in the same VM. Set by the stage runtime from recorded workflow input only.
   */
  firstPassRun?: boolean;
  /** This activity is one of the first pass's own document shards: the checkpoints it writes are provisional. */
  firstPassShard?: boolean;
  /**
   * The run's pipeline extracts PDFs differently from the first pass's (firstPassPipeline): the ordinary loop re-runs a
   * provisional extract-markdown checkpoint (pipeline/checkpoints.ts firstPassCheckpointStale).
   */
  firstPassExtractionDiffers?: boolean;
  totalStages: number;
  docConcurrency = 1;
  distributedVisionPages = new Map<string, unknown>();
  /**
   * The shared vision attempt ledger (page bound, rejection breaker and org uncharged bound,
   * lib/vision-attempt-guard.ts). Set by loadRunState from the store, null when that store has none
   * (vision then refuses every request); absent only in store-less runs, which count per process.
   */
  visionAttempts?: import("../lib/vision-attempt-guard.js").VisionAttemptBackend | null;
  /**
   * The page reader's fleet-wide org daily spend ledger (ocr/page-reader-budget.ts). Set by loadRunState from the store,
   * null when that store has none (the reader then sends nothing); absent only in store-less runs, which count per process.
   */
  pageReaderBudget?: import("../ocr/page-reader-budget.js").PageReaderOrgBudget | null;
  /** Page-level progress for granular percent-complete computation */
  pageProgress: Map<string, PageProgress> = new Map();
  /** Last time updateProgress was called (throttle granular flushes) */
  lastProgressFlushAt = 0;
  /**
   * Set while this state runs one document shard of a stage beside other
   * shards: what the run row already holds from this state, so progress
   * checkpoints write only this shard's additions (see PostgresRunLedger.writeProgress).
   */
  shard: { artifacts: Record<string, string> } | null = null;

  constructor(run: ProjectRun, documents: Document[]) {
    this.usageLedger = new PipelineUsageEventLedger(run.pipeline.speedBoost === true);
    this.run = {
      ...run,
      stats: cloneJsonMap(run.stats),
      artifacts: cloneArtifacts(run.artifacts)
    };
    this.documents = documents;
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
    this.usageLedger.runId = run.id;
    this.usageLedger.modelClass = runModelClass(run.pipeline);
    // The run's OCR page class decision (pipeline/ocr-page-class.ts), read when a charge is made: it may be pinned after
    // construction (startRun) or arrive with hydrated artifacts.
    this.usageLedger.ocrPageClass = () => runUsesOcrPageClass(this.artifactLedger);
    this.pageBasis = PageBasis.unbound(this);
  }

  /** Binds the state to its store: checkpoints, and the page basis over the store's ledger. */
  bindStore(store: CheckpointStore): void {
    this.store = store;
    this.pageBasis = new PageBasis(this, store.pageBasisLedger);
  }

  static create(run: ProjectRun, documents: Document[]): WorkflowState {
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

/** The levels a run was configured with, as recorded next to every model it calls (usage-ledger.ts `modelClass`). */
export function runModelClass(pipeline: ProjectRun["pipeline"] | null | undefined): Record<string, string> | null {
  if (!pipeline) return null;
  const levels: Record<string, string | undefined> = {
    quality: pipeline.quality,
    visionProfile: pipeline.vision?.profile,
    embeddingProfile: pipeline.embedding?.profile,
    pageRouter: pipeline.pageRouter?.router,
    inferenceLane: pipeline.inferenceLane,
    // Speed boost swaps hosted models for their fast hosts: part of what selected the model.
    speedBoost: pipeline.speedBoost === true ? "on" : undefined,
  };
  const known = Object.fromEntries(Object.entries(levels).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== ""));
  return Object.keys(known).length ? known : null;
}

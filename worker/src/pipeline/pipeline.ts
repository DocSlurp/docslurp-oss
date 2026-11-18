import type { GeoAttempt, GeoFinalSource } from "../db/geo-final-source.js";
import type { DerivedDocumentTitle, PrivacyAuditEntry } from "@docslurp/shared";
import type { StageState, ProjectRunEvent } from "../models.js";
import type { Document, ParserEvaluation, PerformanceEvent, UsageEvent, ProjectRun } from "../models.js";
import { cloneArtifacts, cloneJsonMap } from "../models.js";
import { DocumentArtifactLedger } from "./artifact-ledger.js";
import { PipelineUsageEventLedger } from "./usage-ledger.js";
import type { PageFactUpsert } from "./page-facts.js";
import { runUsesOcrPageClass } from "./ocr-page-class.js";
import { PageBasis, type PageBasisLedger } from "./page-basis.js";
import {
  getPageProgressForDocumentStage,
  type PageProgress,
  refreshRunProgressStats,
} from "./run-ledger.js";

/** One persisted OCR escalation call (ocr_escalation_reads). */
export interface OcrEscalationReadRow {
  attempt: number;
  status: "completed" | "failed";
  text: string | null;
  model: string;
  /** The call's usage events, under the ids they were buffered with. */
  usageEvents: UsageEvent[];
}

export interface CheckpointStore {
  beginGeoAttempt?(state: WorkflowState, documentId: string, schema: Record<string, unknown>): Promise<GeoAttempt | undefined>;
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
  noteSandboxInfrastructureStrike?(state: WorkflowState, documentId: string, stage: string): Promise<number>;
  noteBlamedSandboxStrike?(state: WorkflowState, documentId: string): Promise<number | null>;
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
  creditLeaseWouldExhaust?(state: WorkflowState): boolean;
  setPagesStageComplete?(runId: string, documentId: string, stageName: string, pageNumbers: number[]): Promise<void>;
  /** Stamps a run milestone once; null when already stamped (pipeline/run-milestones.ts). */
  markRunMilestone?(runId: string, milestone: import("./run-milestones.js").RunMilestone): Promise<import("./run-milestones.js").RunMilestoneHit | null>;
  setPageStageComplete(runId: string, documentId: string, stageName: string, pageNumber: number): Promise<void>;
  getCompletedPages(runId: string, documentId: string, stageName: string): Promise<Set<number>>;
  recordPrivacyAudit?(entries: readonly PrivacyAuditEntry[]): Promise<void>;
  /** Document asset ledger and extraction level (db/document-asset-ledger.ts), in one org-scoped transaction. */
  writeDocumentAssetLedger?(write: import("../db/document-asset-ledger.js").DocumentAssetLedgerWrite): Promise<unknown>;
  /** Figure uploads in progress (db/document-asset-ledger.ts): pending before each upload step, stored after it. */
  markAssetsPending?(args: Parameters<typeof import("../db/document-asset-ledger.js").markAssetsPending>[1]): Promise<unknown>;
  markAssetsStored?(args: Parameters<typeof import("../db/document-asset-ledger.js").markAssetsStored>[1]): Promise<unknown>;
  replaceUnvouchedObject?(args: Parameters<typeof import("../db/document-asset-ledger.js").replaceUnvouchedObject>[1]): Promise<void>;
  /** Pages whose image Doppler left to the host (db/document-asset-ledger.ts listHostPageImagePages); read-only, org-scoped. */
  listHostPageImagePages?(scope: { orgId: string; documentId: string }): Promise<number[]>;
  /**
   * PII withholding for artifacts written after the document's PII stage (the first pass's figure step): whether the
   * document's recorded PII outcome withholds artifacts (it redacted or blocked), and adding URIs to its withheld list.
   */
  documentPiiWithholds?(documentId: string): Promise<boolean>;
  appendWithheldArtifactUris?(documentId: string, uris: readonly string[]): Promise<void>;
  /** Per-page ingest facts (ingest report); best effort, idempotent per (document, page). */
  upsertPageFacts?(rows: readonly PageFactUpsert[]): Promise<void>;
  /** Reserves Fast page-image renders from the run's shared budget (db/fast-page-image-budget.ts). */
  reserveFastPageImageRenders?(args: { runId: string; documentId: string; wanted: number; perRun: number }): Promise<number>;
  /** Reserves one free-tier chart-export VM run against the org's hourly cap (db/chart-export-free-vm-cap.ts). */
  reserveChartExportFreeVmRun?(args: { orgId: string; runId: string; documentId: string; perHour: number }): Promise<boolean>;
  /**
   * Stores the derived display title in documents.metadata unless one is already set
   * (re-runs do not churn it and a user rename wins). Returns whether it was written.
   */
  setDocumentTitleIfAbsent?(documentId: string, title: DerivedDocumentTitle): Promise<boolean>;
  /**
   * The page basis port (pipeline/page-basis.ts): document page counts, billing pages and the spend check they owe. Required:
   * a store without it does not type-check, so no state bound to a store can skip a page-count spend check.
   */
  readonly pageBasisLedger: PageBasisLedger;
  /** This run's persisted OCR escalation reads of a page, oldest first (migration 0129). */
  ocrEscalationReads?(runId: string, documentId: string, pageNumber: number): Promise<OcrEscalationReadRow[]>;
  /**
   * Persist one OCR escalation call as soon as it returns, under the next free attempt number (assigned atomically, so
   * concurrent calls of a page never share one); returns that number.
   */
  recordOcrEscalationRead?(row: Omit<OcrEscalationReadRow, "attempt"> & { runId: string; documentId: string; pageNumber: number }): Promise<number>;
  /**
   * Replaces the API's provisional file facts (header inspection) with the worker's full inspection, and the document's
   * MIME type with the one the bytes are. Scoped to the run's own document.
   */
  setDocumentFileFacts?(runId: string, documentId: string, facts: import("@docslurp/shared").FileFacts): Promise<boolean>;
  /**
   * Quarantine's parse decision for this run's own document (lib/parse-source.ts): `{ copy }` (an encrypted PDF's scanned copy),
   * `{ copy: null }` (the upload it scanned), or null to clear it (refused).
   */
  setDocumentParseSource?(runId: string, documentId: string, decision: import("../lib/parse-source.js").ParseSourceDecisionRecord | null): Promise<boolean>;
  /** Newest observed page-shard timings for one `${stage}:${executor}` profile (shard calibration). */
  loadShardObservations?(profileKey: string, limit?: number): Promise<Array<{ pages: number; ms: number; maxRssMiB?: number }>>;
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
   * checkpoints write only this shard's additions (see Store.writeProgress).
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

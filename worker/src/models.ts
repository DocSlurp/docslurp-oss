import type {
  EmbeddingConfig,
  PipelineFeatureOverrides,
  PipelineFeatures,
  RunStage,
  WorkspaceRunEventType as SharedWorkspaceRunEventType,
} from "@docslurp/shared";
import { normalizePipelineFeatures } from "@docslurp/shared";

export type JsonMap = Record<string, unknown>;

export interface WorkspaceRun {
  id: string;
  orgId: string | null;
  /** The billed org's plan, so AI on bonus plans carries the plan-neutral credit factor. */
  /** Whether the run's org has ever had a paid grant (organizations.funded_at). */
  orgFunded?: boolean;
  /** False when the org turned off China-based model providers. */
  orgAllowChinaProviders?: boolean;
  userId: string;
  workspaceId?: string;
  kind: string;
  status: string;
  stage: string;
  totalDocuments: number;
  processedDocuments: number;
  pagesTotal: number;
  pagesProcessed: number;
  /**
   * Committed billed spend of the run (`workspace_runs.spent_cents`): the sum
   * of cost_cents of every usage event persisted for it, kept by a trigger on
   * usage_events (migration 0056) and refreshed by each progress checkpoint.
   * Add the ledger's pending billable cents for the live figure the run cost
   * cap (`pipeline.maxCostCents`) is checked against (checkpoints.ts
   * runSpentCents). Equals the run's billed cost in usage_attribution.
   */
  spentCents: number;
  pipeline: PipelineFeatures;
  error: string | null;
  stats: JsonMap;
  artifacts: Record<string, string>;
  claimId: string | null;
  /** Extract runs (workspace_runs.extract_id) write every artifact under this prefix instead of <user>/<run>. */
  storagePrefix?: string | null;
  extractId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Document {
  id: string;
  userId: string;
  runId: string;
  filename: string;
  mimeType: string;
  sourceKey: string;
  /** sha256 the server computed over the source bytes; staged sources are checked against it (sandbox/source-integrity.ts). */
  sourceSha256?: string | null;
  status: string;
  extractionMode: string;
  pageCount: number;
  createdAt: Date;
  updatedAt: Date;
  /** Set for documents of an extract run: the run's storage prefix (see runArtifactRoot). */
  artifactRoot?: string | null;
}

export interface UsageEvent {
  id?: string;
  provider: string;
  model: string;
  metric: string;
  amount: number;
  unit: string;
  costCents: number;
  inputTokens?: number;
  outputTokens?: number;
  metadata?: JsonMap;
}

export interface PerformanceEvent {
  documentId?: string;
  scope: string;
  stageName: string;
  metric: string;
  pageNumber?: number;
  value: number;
  unit: string;
  tags: string[];
  metadata?: JsonMap;
}

export interface ParserEvaluation {
  userId: string;
  runId: string;
  documentId: string;
  stageName: string;
  parser: string;
  matchedBlocks: number;
  bboxBlocks: number;
  pageBackedBlocks: number;
  matchRatio: number;
  bboxRatio: number;
  pageRatio: number;
  selected: boolean;
  artifactUri?: string | null;
  metadata?: JsonMap;
}

export interface StageState {
  runId: string;
  documentId?: string;
  stageName: string;
  status: string;
  attempts: number;
  artifactUri: string;
  stats: JsonMap;
  error: string;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export type WorkspaceRunEventType = SharedWorkspaceRunEventType | string;

export interface WorkspaceRunEvent {
  id?: string;
  userId: string;
  runId: string;
  documentId?: string;
  stageName?: string;
  eventType: WorkspaceRunEventType | string;
  status?: string;
  message?: string;
  progress?: JsonMap;
  stats?: JsonMap;
  payload?: JsonMap;
  createdAt?: Date;
}

export interface EmbeddingProfile {
  profile: EmbeddingConfig["profile"];
  target: EmbeddingConfig["target"];
  modelUri: string;
  runtime: "remote" | "local";
  provider: string;
  model: string;
  baseUrl: string | null;
  dimensions: number;
  /** Explicitly configured workspace dimensions, sent to servers that support them. */
  requestedDimensions?: number;
  task: EmbeddingConfig["task"];
  normalize: boolean;
  batchSize: number;
  lateChunking: boolean;
  lateChunkingWindow: number;
  supportsCustomDimensions?: boolean;
}

type PipelineFeaturesInput = PipelineFeatureOverrides;

export function cloneJsonMap(source?: JsonMap | null): JsonMap {
  if (!source) {
    return {};
  }
  return { ...source };
}

export function cloneArtifacts(source?: Record<string, string> | null): Record<string, string> {
  if (!source) {
    return {};
  }
  return { ...source };
}

export function mergePipelineFeatures(source?: PipelineFeaturesInput | null): PipelineFeatures {
  return normalizePipelineFeatures(source);
}

export type StageName = RunStage | string;

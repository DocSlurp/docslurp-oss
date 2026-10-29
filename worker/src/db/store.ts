import { instrumentFetch } from "@docslurp/shared/observability";
import { instrumentPostgres } from "@docslurp/shared/observability";
import { dbTraceStatementHook } from "../lib/db-trace.js";
import { pipelineTransaction } from "./transaction-pipeline.js";
import { PostgresCapacityLeaseStore } from "../media/capacity/store.js";
import { PostgresMediaJournal } from "../media/journal.js";
import { PUBLIC_ERROR_MESSAGES } from "@docslurp/shared";
import { DocumentNotFoundError, isMissingDocumentError } from "./missing-document.js";
import { recordPageBaseFee } from "./page-base-fee.js";
import { PageTaskStore } from "./page-task-store.js";
import { WorkerSlotStore, resolveWorkerSlotOptions, tryMaintenanceLease, type WorkerSlotOptions } from "./worker-slot-store.js";
import { randomUUID, createHmac } from "node:crypto";

import postgres, { type JSONValue, type PendingQuery, type Sql } from "postgres";
import { applyDefaultVisionOverride, defaultPipelineFeatures, PII_BLOCKED_DOCUMENT_STATUS, planRunFailure, type DerivedDocumentTitle, type PrivacyAuditEntry } from "@docslurp/shared";

import { mergePipelineFeatures } from "../models.js";
import { adoptBackfillDocuments } from "../deferred/backfill-adoption.js";
import { insertPrivacyAuditRows } from "../lib/privacy-guard.js";
import type {
  Document,
  WorkspaceRun,
  WorkspaceRunEvent,
  JsonMap,
  StageState,
} from "../models.js";
import type { WorkflowState, VectorIndex } from "../pipeline/pipeline.js";
import type { PageFactUpsert } from "../pipeline/page-facts.js";
import type { ArtifactStore } from "../tools/storage.js";
import type { EmbeddingReuseRef } from "../embeddings/embedding-reuse.js";
import {
  collectOrphanedStorageKeys,
  keyFromStorageUri,
} from "../tools/storage.js";
import { RunEventPublisher, resolveRunEventPublisherOptions, type RunEventPublisherOptions } from "./run-event-store.js";
import { graphFallbackScope, workspaceTemplates } from "@docslurp/shared";
import { queryWorkerScalerSnapshot, type ScalerSql, type WorkerScalerQueryParams, type WorkerScalerSnapshot } from "@docslurp/shared";
import {
  refreshWorkspaceCommunities,
  type CommunityRefreshResult,
  type CommunitySummaryContext,
} from "../graph/communities.js";
import { lockWorkspaceGraph, replaceDocumentGraph, type ReplaceDocumentGraphInput } from "../graph/graph-store.js";
import { runGraphJobs, type GraphJobRunnerOptions } from "../graph/rebuild-job.js";
import {
  drainDocumentCleanupQueue,
  drainStorageCleanupQueue,
  purgeSupersededDocuments,
  refreshKnowledgeGraphNodes,
  type PurgeStorage,
  type SupersededPurgeOptions,
  type SupersededPurgeResult,
} from "./superseded-purge.js";
import { enforceRunSpend, spendCounterSql } from "./spend-check.js";
import { retryTransaction } from "./transaction-retry.js";
import { consumeRunCreditLease, creditLeasesActive, RunCreditLeases, type LeaseObservation } from "./credit-lease.js";
import {
  lexicalColumnProbe,
  resolveWorkerCapabilities,
  WorkerCapabilityRegistry,
  type WorkerCapabilityRegistryOptions,
} from "./worker-capabilities.js";
import {
  debitRunUsageCredits,
  flushPendingCreditDebits,
  persistRunUsageEvents,
  runUsageEventStatements,
} from "./usage-event-store.js";

type WorkspaceRunRow = {
  id: string;
  org_id: string;
  /** Joined from organizations by loadRun; absent from other run queries. */
  org_funded?: boolean | null;
  org_allow_china_providers?: boolean | null;
  workspace_id: string;
  user_id: string;
  kind: string;
  status: string;
  stage: string;
  total_documents: number;
  processed_documents: number;
  pages_total: number;
  pages_processed: number;
  spent_cents: number | string;
  pipeline: Partial<WorkspaceRun["pipeline"]> | null;
  stats: JsonMap | null;
  artifacts: Record<string, string> | null;
  error: string | null;
  run_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  extract_id?: string | null;
  storage_prefix?: string | null;
};

type RunReleaseRow = {
  id: string;
  status: string;
  control_state: string | null;
};

type DocumentRow = {
  id: string;
  user_id: string;
  run_id: string;
  filename: string;
  mime_type: string;
  source_key: string;
  status: string;
  extraction_mode: string;
  page_count: number;
  created_at: string | Date;
  updated_at: string | Date;
  /** Joined by the run document loaders: the run's extract storage prefix. */
  run_storage_prefix?: string | null;
};

type StageStateRow = {
  run_id: string;
  document_id?: string | null;
  stage_name: string;
  status: string;
  attempts: number;
  artifact_uri: string | null;
  stats: JsonMap | null;
  error: string | null;
  started_at: string | Date | null;
  completed_at: string | Date | null;
  updated_at: string | Date;
};

type HistoricalStagePerformanceRow = {
  stage_name: string;
  samples: number;
  p50_ms: number | null;
  p95_ms: number | null;
  p50_ms_per_page: number | null;
};

type BudgetAlertRow = {
  scope_id: string;
  scope_name: string;
  org_id: string | null;
  workspace_id: string | null;
  owner_user_id: string;
  owner_email: string;
  monthly_budget_cents: number;
  budget_alert_threshold_percent: number;
  budget_alert_level: number;
  budget_paused: boolean;
  spend_cents: number;
  cost_alert: boolean | null;
};

type ArtifactRetentionRow = {
  run_id: string;
  user_id: string;
  org_id: string | null;
  workspace_id: string;
  workspace_name: string;
  source_keys: string[] | null;
  run_artifact_uris: string[] | null;
  stage_artifact_uris: string[] | null;
};

type RunRetentionRow = {
  run_id: string;
  user_id: string;
  org_id: string | null;
  workspace_id: string;
  workspace_name: string;
};

type StorageReferenceRow = {
  reference_kind: string;
  reference_key: string | null;
  run_id: string | null;
  document_id: string | null;
  workspace_id: string | null;
  org_id: string | null;
  user_id: string | null;
  reference_source: string | null;
};

type StorageIntegrityRunRow = {
  run_id: string;
  user_id: string;
  org_id: string | null;
  workspace_id: string;
  status: string;
  pipeline: Partial<WorkspaceRun["pipeline"]> | null;
};

type CountByRunRow = {
  run_id: string;
  count: number;
};

type StorageReference = {
  kind: string;
  key: string;
  runId: string | null;
  documentId: string | null;
  workspaceId: string | null;
  orgId: string | null;
  userId: string | null;
  source: string | null;
};

type StorageIntegrityRunCheck = {
  runId: string;
  userId: string;
  orgId: string | null;
  workspaceId: string;
  status: string;
  pipeline: Partial<WorkspaceRun["pipeline"]> | null;
  documentCount: number;
  chunkCount: number;
  vectorIndexCount: number;
  summaryCount: number;
  propositionCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
  chunkEntityCount: number;
  communityCount: number;
};

export type StorageIntegrityFinding = {
  kind:
    | "missing-storage-object"
    | "orphaned-storage-object"
    | "missing-index-rows"
    | "missing-vector-index-metadata"
    | "missing-summary-rows"
    | "missing-proposition-rows"
    | "missing-graph-rows";
  severity: "warning" | "error";
  key?: string;
  runId?: string | null;
  documentId?: string | null;
  workspaceId?: string | null;
  orgId?: string | null;
  userId?: string | null;
  referenceKind?: string | null;
  referenceSource?: string | null;
  message: string;
  metadata: Record<string, unknown>;
};

export type StorageIntegrityReport = {
  generatedAt: string;
  reportKey: string | null;
  reportUri: string | null;
  sweep: {
    bucket: string;
    prefix: string | null;
    maxKeys: number;
    listedKeys: number;
    listedKeysTruncated: boolean;
    nextContinuationToken: string | null;
    expectedReferenceCount: number;
    checkedReferenceCount: number;
    checkedReferenceTruncated: boolean;
  };
  summary: {
    findingCount: number;
    missingObjectCount: number;
    orphanedObjectCount: number;
    danglingMetadataCount: number;
    affectedRuns: number;
    affectedDocuments: number;
  };
  findings: StorageIntegrityFinding[];
};

const BULK_WRITE_BATCH_SIZE = 1000;
const HISTORICAL_PERFORMANCE_TTL_MS = 5 * 60_000;

function batchedRows<T>(rows: T[], batchSize = BULK_WRITE_BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < rows.length; index += batchSize) {
    batches.push(rows.slice(index, index + batchSize));
  }
  return batches;
}

export function resolveBudgetAlertLevel(
  spendCents: number,
  budgetCents: number | null,
  thresholdPercent: number,
): number {
  if (!budgetCents || budgetCents <= 0) {
    return 0;
  }

  if (spendCents >= budgetCents) {
    return 100;
  }

  const warningThreshold = Math.ceil((budgetCents * thresholdPercent) / 100);
  return spendCents >= warningThreshold ? thresholdPercent : 0;
}

/** A newer canonical version that took over search from older ones. */
export type CanonicalReplacement = {
  documentId: string;
  canonicalId: string;
  previousVersionId: string | null;
  replacedDocumentIds: string[];
};

/**
 * SQL fragment: this run's `index` stage has completed the document. With
 * WORKER_INDEX_BEFORE_ENRICH the enrichment stages (summary, structured
 * extraction, graph, page and proposition indexes) run after `index`; their
 * checkpoints must not flip a searchable document out of 'completed'.
 */
function indexedInRun(client: Sql<Record<string, unknown>>, runId: string, documentId: string) {
  return client`exists (
    select 1 from document_run_stage_states indexed
    where indexed.run_id = ${runId}
      and indexed.document_id = ${documentId}
      and indexed.stage_name = 'index'
      and indexed.status = 'completed'
  )`;
}

/**
 * Versions the supersede trigger replaced in the current transaction. The
 * trigger stamps superseded_at = now(), which is the transaction start time.
 */
function supersededInThisTransactionQuery(
  client: Sql<Record<string, unknown>>,
  documentIds: string[],
) {
  return client<{
    document_id: string;
    canonical_id: string;
    previous_version_id: string | null;
    replaced_ids: string[];
  }[]>`
    select live.id as document_id,
      live.canonical_id,
      live.previous_version_id,
      array_agg(old.id order by old.created_at) as replaced_ids
    from documents old
    join documents live on live.id = old.superseded_by_document_id
    where live.id = any(${client.array(documentIds)})
      and old.superseded_at = now()
    group by live.id, live.canonical_id, live.previous_version_id
  `;
}

function mapSuperseded(rows: { document_id: string; canonical_id: string; previous_version_id: string | null; replaced_ids: string[] }[]): CanonicalReplacement[] {
  return rows.map((row) => ({
    documentId: row.document_id,
    canonicalId: row.canonical_id,
    previousVersionId: row.previous_version_id,
    replacedDocumentIds: row.replaced_ids,
  }));
}

async function supersededInThisTransaction(
  client: Sql<Record<string, unknown>>,
  documentIds: string[],
): Promise<CanonicalReplacement[]> {
  if (documentIds.length === 0) return [];
  return mapSuperseded(await supersededInThisTransactionQuery(client, documentIds));
}

type StageStateRows = (StageStateRow & { scope: "run" | "document" })[];

function runRowQuery(client: Sql<Record<string, unknown>>, runId: string) {
  // The org's plan rides along (no extra round trip): it sets the AI credit
  // factor for bonus plans in the usage ledger.
  return client<WorkspaceRunRow[]>`
    select r.*, (select o.funded_at is not null from organizations o where o.id = r.org_id) as org_funded,
      (select o.allow_china_providers from organizations o where o.id = r.org_id) as org_allow_china_providers
    from workspace_runs r
    where r.id = ${runId}
    limit 1
  `;
}

function runDocumentRowsQuery(client: Sql<Record<string, unknown>>, runId: string) {
  return client<DocumentRow[]>`
    select d.*, (select r.storage_prefix from workspace_runs r where r.id = d.run_id) as run_storage_prefix
    from documents d
    where d.run_id = ${runId}
      and d.superseded_at is null and d.status <> 'cancelled'
    order by d.created_at asc
  `;
}

function stageStateRowsQuery(client: Sql<Record<string, unknown>>, runId: string) {
  // Run and document checkpoints in one round trip; run rows have no document_id.
  return client<StageStateRows>`
    select 'run' as scope, run_id, null::text as document_id, stage_name, status, attempts, artifact_uri, stats, error,
      started_at, completed_at, updated_at
    from workspace_run_stage_states
    where run_id = ${runId}
    union all
    select 'document' as scope, run_id, document_id, stage_name, status, attempts, artifact_uri, stats, error,
      started_at, completed_at, updated_at
    from document_run_stage_states
    where run_id = ${runId}
    order by updated_at asc
  `;
}

/** The three reads that open a stage activity, mapped; a stage-completion checkpoint can fetch them for the next stage. */
export type PreloadedRunState = { run: WorkspaceRun; documents: Document[]; stageStates: StageStateRows };

/** What a checkpoint reports back to the stage boundary. */
type ProgressWrite = {
  unspentSinceCheck: boolean;
  lease?: { observation: LeaseObservation | null };
  /** The run's pause/cancel request, read in the checkpoint's own transaction (options.readControlState). */
  controlRequested?: boolean;
  /** The next stage's opening reads, read in the checkpoint's own transaction (options.preloadRunState). */
  preloaded?: PreloadedRunState;
};

const CONTROL_REQUEST_STATES = ["pause_requested", "paused", "cancel_requested", "cancelled"];

/** The documents of a completing run: retire obsolete rows, then mark the healthy ones completed. */
function completeRunDocumentStatements(client: Sql<Record<string, unknown>>, runId: string) {
  return [
    client`select retire_replaced_pending_documents(${runId})`,
    // Legacy retries may already contain obsolete queued rows. They were not
    // hydrated or processed; retire them instead of declaring them completed.
    client`
      update documents set status = 'cancelled', lexical_searchable_at = null, updated_at = now()
      where run_id = ${runId} and superseded_at is not null
        and status in ('queued', 'processing')
    `,
    client<{ id: string }[]>`
      update documents
      set status = 'completed',
          updated_at = now()
      where run_id = ${runId}
        and superseded_at is null
        and status not in ('failed', 'cancelled', 'pii_blocked')
        and not exists (
          select 1 from document_run_stage_states stage_state
          where stage_state.document_id = documents.id
            and stage_state.run_id = documents.run_id
            and stage_state.status = 'failed'
        )
      returning id
    `,
  ] as const;
}

async function completeRunDocuments(client: Sql<Record<string, unknown>>, runId: string): Promise<string[]> {
  const [retire, cancel, completed] = completeRunDocumentStatements(client, runId);
  await retire;
  await cancel;
  return (await completed).map((row) => row.id);
}

export class Store {
  private readonly sql: Sql<Record<string, unknown>>;
  capacityLeaseStore(providerIds: string[]) { return new PostgresCapacityLeaseStore(this.sql, (id) => this.loadRun(id).catch(() => null), providerIds); }
  /** Raw client for stages that write their own tables (deferred indexing). */
  get stageSql(): Sql<Record<string, unknown>> { return this.sql; }
  get mediaJournal(): PostgresMediaJournal { return new PostgresMediaJournal(this.sql); }
  private readonly plausibilityWarningThreshold: number;
  private readonly apiKeyUsageRetentionDays: number;
  private readonly perfLogRetentionDays: number;
  private readonly poisonRunFailureThreshold: number;
  private readonly workerSlotOptions: WorkerSlotOptions;
  private readonly tableExistenceCache = new Map<string, boolean>();
  /** Tail of each state's checkpoint queue (writeProgress runs one at a time per state). */
  private readonly progressQueues = new WeakMap<WorkflowState, Promise<unknown>>();
  private readonly runEvents: RunEventPublisher;
  /** This process's view of run credit leases (credit-lease.ts), shared with page tasks. */
  readonly creditLeases: RunCreditLeases;
  /** Historical stage timings per workspace/user; a 14-day aggregate does not need a fresh read per stage. */
  private readonly historicalPerformanceCache = new Map<string, { loadedAt: number; value: Record<string, unknown> | null }>();
  // One in-flight load per scope: after a fleet restart every activity misses
  // the cache at once (127 concurrent percentile queries in the 2026-10-09 re-run).
  private readonly historicalPerformanceLoads = new Map<string, Promise<Record<string, unknown> | null>>();

  constructor(
    databaseUrl: string,
    private readonly leaseTtlMs: number,
    options?: {
      plausibilityWarningThreshold?: number;
      apiKeyUsageRetentionDays?: number;
      perfLogRetentionDays?: number;
      poisonRunFailureThreshold?: number;
      /** Connections per worker process; 8 activities share it (docs/scaling-1000-workers.md). */
      poolMax?: number;
      workerSlots?: WorkerSlotOptions;
      /** Run event coalescing (run-event-store.ts). */
      runEvents?: RunEventPublisherOptions;
    },
  ) {
    this.sql = instrumentPostgres(postgres<Record<string, postgres.PostgresType>>(databaseUrl, {
      max: Math.max(1, options?.poolMax ?? 10),
      // Avoid stale result types in pooled statements after schema deployments.
      prepare: false,
      types: { numeric: { to: 1700, from: [1700], serialize: (value: unknown) => String(value), parse: (value: string): unknown => Number(value) } },
      idle_timeout: 20,
      connect_timeout: 10,
    }), databaseUrl, { onStatement: dbTraceStatementHook() });
    this.plausibilityWarningThreshold =
      options?.plausibilityWarningThreshold ?? 0.3;
    this.apiKeyUsageRetentionDays = Math.max(
      1,
      options?.apiKeyUsageRetentionDays ?? 30,
    );
    this.perfLogRetentionDays = Math.max(
      1,
      options?.perfLogRetentionDays ?? 90,
    );
    this.workerSlotOptions = options?.workerSlots ?? resolveWorkerSlotOptions();
    this.runEvents = new RunEventPublisher(this.sql, options?.runEvents ?? resolveRunEventPublisherOptions());
    this.creditLeases = new RunCreditLeases(this.sql);
    this.poisonRunFailureThreshold = Math.max(
      1,
      options?.poisonRunFailureThreshold ?? 3,
    );
  }

  async close(): Promise<void> {
    await this.runEvents.close().catch((error) => {
      console.warn(`[run-events] final flush failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await this.sql.end();
  }

  async loadRun(runId: string): Promise<WorkspaceRun> {
    const [row] = await runRowQuery(this.sql, runId);

    if (!row) {
      throw new Error(`run not found: ${runId}`);
    }

    return mapRun(row);
  }

  async loadDocument(documentId: string): Promise<Document> {
    const [row] = await this.sql<DocumentRow[]>`select d.*, (select r.storage_prefix from workspace_runs r where r.id = d.run_id) as run_storage_prefix from documents d where d.id = ${documentId} limit 1`;
    if (!row) throw new DocumentNotFoundError(documentId);
    return mapDocument(row);
  }

  async loadDocumentsForRun(runId: string): Promise<Document[]> {
    return (await runDocumentRowsQuery(this.sql, runId)).map(mapDocument);
  }

  /** The run's stage checkpoints (run and document rows), for loadRunState to read beside the run. */
  readStageStates(runId: string): Promise<StageStateRows> {
    return stageStateRowsQuery(this.sql, runId);
  }

  async hydrateState(state: WorkflowState, stageStates?: Promise<StageStateRows> | StageStateRows): Promise<void> {
    state.store = this;
    state.runStages.clear();
    state.documentStages.clear();
    state.run.stats = state.run.stats ?? {};
    state.run.artifacts = state.run.artifacts ?? {};
    state.replaceArtifacts(state.run.artifacts);

    const rows = await (stageStates ?? this.readStageStates(state.run.id));

    for (const row of rows) {
      if (row.scope !== "run") continue;
      const { scope: _scope, ...stageRow } = row;
      state.setRunStage(mapStageState(stageRow));
    }

    for (const row of rows) {
      if (row.scope !== "document") continue;
      const { scope: _scope, ...stageRow } = row;
      const stageState = mapStageState(stageRow);
      state.setDocumentStage(stageState);
      if (
        stageState.status === "completed" &&
        stageState.documentId &&
        stageState.artifactUri
      ) {
        const key = `${stageState.documentId}:${stageState.stageName}`;
        state.artifactLedger.record(key, stageState.artifactUri);
      }
    }

    await this.hydrateHistoricalStagePerformance(state);
    state.refreshStats();
  }

  private async hydrateHistoricalStagePerformance(state: WorkflowState): Promise<void> {
    const filterScope = state.run.workspaceId
      ? { column: "workspace_id", value: state.run.workspaceId }
      : { column: "user_id", value: state.run.userId };
    const cacheKey = `${filterScope.column}:${filterScope.value}`;
    const cached = this.historicalPerformanceCache.get(cacheKey);
    let value: Record<string, unknown> | null;
    if (cached && Date.now() - cached.loadedAt < HISTORICAL_PERFORMANCE_TTL_MS) {
      value = cached.value;
    } else {
      let load = this.historicalPerformanceLoads.get(cacheKey);
      if (!load) {
        load = this.loadHistoricalStagePerformance(filterScope, state.run.id).then((loaded) => {
          if (this.historicalPerformanceCache.size > 1_000) this.historicalPerformanceCache.clear();
          this.historicalPerformanceCache.set(cacheKey, { loadedAt: Date.now(), value: loaded });
          return loaded;
        }).finally(() => this.historicalPerformanceLoads.delete(cacheKey));
        this.historicalPerformanceLoads.set(cacheKey, load);
      }
      value = await load;
    }
    if (value) state.run.stats = { ...(state.run.stats ?? {}), historicalStagePerformance: value };
  }

  private async loadHistoricalStagePerformance(
    filterScope: { column: string; value: string },
    runId: string,
  ): Promise<Record<string, unknown> | null> {
    const rows = await this.sql.unsafe<HistoricalStagePerformanceRow[]>(
      `
      select
        perf.stage_name,
        count(*)::int as samples,
        percentile_cont(0.5) within group (order by perf.value)::numeric as p50_ms,
        percentile_cont(0.95) within group (order by perf.value)::numeric as p95_ms,
        percentile_cont(0.5) within group (
          order by perf.value / greatest(1, coalesce(runs.pages_total, 0))
        )::numeric as p50_ms_per_page
      from performance_log perf
      join workspace_runs runs on runs.id = perf.run_id
      where perf.metric = 'stage-duration'
        and perf.unit = 'ms'
        and perf.created_at >= now() - interval '14 days'
        and runs.id <> $1
        and runs.${filterScope.column} = $2
        and runs.pages_total > 0
      group by perf.stage_name
      having count(*) >= 2
      `,
      [runId, filterScope.value],
    );

    const stages: Record<string, Record<string, unknown>> = {};
    for (const row of rows) {
      stages[row.stage_name] = {
        samples: row.samples,
        p50Ms: Number(row.p50_ms ?? 0),
        p95Ms: Number(row.p95_ms ?? 0),
        p50MsPerPage: Number(row.p50_ms_per_page ?? 0),
      };
    }
    if (Object.keys(stages).length === 0) return null;
    return {
      scope: filterScope.column === "workspace_id" ? "workspace" : "user",
      lookbackDays: 14,
      stages,
    };
  }

  /**
   * Newest shard timings for one planner profile (`${stage}:${executor}`), for shard calibration.
   * Fleet-wide performance aggregate: selects only numeric measurements (wall ms, pages, peak RSS), never
   * document, run, user or org identifiers, so one tenant's plan cannot learn anything about another's content.
   * Served by performance_log_shard_timing_idx (0098).
   */
  async loadShardObservations(profileKey: string, limit = 200): Promise<Array<{ pages: number; ms: number; maxRssMiB?: number }>> {
    const rows = await this.sql<Array<{ ms: string | number; pages: string | number | null; max_rss_mib: string | number | null }>>`
      select perf.value as ms,
        (perf.metadata->>'pages')::numeric as pages,
        (perf.metadata->>'maxRssMiB')::numeric as max_rss_mib
      from performance_log perf
      where perf.metric = 'shard_timing_ms'
        and perf.metadata->>'profileKey' = ${profileKey}
        and perf.created_at >= now() - interval '14 days'
      order by perf.created_at desc
      limit ${Math.max(1, Math.min(1_000, Math.floor(limit)))}
    `;
    return rows.flatMap((row) => {
      const pages = Number(row.pages);
      const ms = Number(row.ms);
      if (!(pages > 0) || !Number.isFinite(ms)) return [];
      const rss = row.max_rss_mib === null ? undefined : Number(row.max_rss_mib);
      return [rss !== undefined && Number.isFinite(rss) ? { pages, ms, maxRssMiB: rss } : { pages, ms }];
    });
  }

  async renewHeartbeat(runId: string): Promise<void> {
    await this.sql`
      update workspace_runs
      set
        last_heartbeat_at = now(),
        lease_expires_at = case when workspace_runs.kind = 'materialize'
            then greatest(coalesce(workspace_runs.lease_expires_at, now()), now() + (${this.leaseTtlMs} * interval '1 millisecond'))
            else now() + (${this.leaseTtlMs} * interval '1 millisecond') end,
        updated_at = now()
      where id = ${runId} and status = 'processing'
    `;
  }

  async updateProgress(state: WorkflowState): Promise<void> {
    await this.writeProgress(state);
  }

  creditLeaseWouldExhaust(state: WorkflowState): boolean {
    return creditLeasesActive() && this.creditLeases.wouldExhaust(state.run.id, state.usageLedger.pendingBillableCents);
  }

  /**
   * One transaction per progress checkpoint: the run row, buffered usage
   * events and their credit debit, vector registrations, performance samples
   * and parser evaluations. `prelude` runs first in the same transaction, so a
   * stage transition and its progress land in one commit.
   *
   * Checkpoints of one state run one at a time: documents of a stage share the
   * state and checkpoint concurrently, and a shard's checkpoint adds the cost
   * since its last committed checkpoint, so two in flight at once would both
   * add the same delta.
   *
   * Lock order inside the transaction: the prelude's own rows (stage state
   * rows), then the run row, then child rows that reference it. The worker
   * locks the run row only in FOR NO KEY UPDATE mode (plain UPDATE, spendCounterSql),
   * which never conflicts with the FOR KEY SHARE locks that foreign-key checks
   * on child rows take, so page and stage writes outside the checkpoint cannot
   * close a cycle with it. A deadlock or serialization victim is retried.
   */
  private writeProgress(
    state: WorkflowState,
    prelude?: (client: Sql<Record<string, unknown>>) => readonly PendingQuery<any>[],
    options: { stageBoundary?: boolean; readControlState?: boolean; preloadRunState?: boolean } = {},
  ): Promise<ProgressWrite> {
    const previous = this.progressQueues.get(state) ?? Promise.resolve();
    const next = previous.then(() => this.writeProgressGuarded(state, prelude, options));
    const tail = next.catch(() => undefined);
    this.progressQueues.set(state, tail);
    void tail.then(() => {
      if (this.progressQueues.get(state) === tail) this.progressQueues.delete(state);
    });
    return next;
  }

  private async writeProgressGuarded(
    state: WorkflowState,
    prelude: ((client: Sql<Record<string, unknown>>) => readonly PendingQuery<any>[]) | undefined,
    options: { stageBoundary?: boolean; readControlState?: boolean; preloadRunState?: boolean },
  ): Promise<ProgressWrite> {
    try {
      return await this.writeProgressNow(state, prelude, options);
    } catch (error) {
      // A document deleted mid-run (DELETE /v1/documents/:id hard-deletes the row) leaves rows in the buffers
      // that reference it. The checkpoint rolled back as a whole, which would also drop the usage already
      // incurred; prune the dead references and write the rest.
      if (!isMissingDocumentError(error) || !(await this.dropRowsForDeletedDocuments(state))) throw error;
      return await this.writeProgressNow(state, prelude, options);
    }
  }

  /** Removes buffered rows that reference deleted documents. Returns whether anything changed. */
  private async dropRowsForDeletedDocuments(state: WorkflowState): Promise<boolean> {
    const referenced = new Set<string>();
    for (const vector of state.vectorIndexes) referenced.add(vector.documentId);
    for (const event of state.pendingPerformance) if (event.documentId) referenced.add(event.documentId);
    for (const evaluation of state.pendingParserEvaluations) referenced.add(evaluation.documentId);
    if (referenced.size === 0) return false;
    const live = new Set((await this.sql<{ id: string }[]>`select id from documents where id = any(${[...referenced]})`).map((row) => row.id));
    const missing = new Set([...referenced].filter((id) => !live.has(id)));
    if (missing.size === 0) return false;
    console.warn(`[store] dropping checkpoint rows for deleted documents run=${state.run.id} documents=${[...missing].join(",")}`);
    state.vectorIndexes = state.vectorIndexes.filter((vector) => !missing.has(vector.documentId));
    state.pendingParserEvaluations = state.pendingParserEvaluations.filter((evaluation) => !missing.has(evaluation.documentId));
    // Performance samples stay (stage timings still describe real work), detached from the deleted document.
    state.pendingPerformance = state.pendingPerformance.map((event) => (event.documentId && missing.has(event.documentId) ? { ...event, documentId: undefined } : event));
    return true;
  }

  private async writeProgressNow(
    state: WorkflowState,
    prelude: ((client: Sql<Record<string, unknown>>) => readonly PendingQuery<any>[]) | undefined,
    options: { stageBoundary?: boolean; readControlState?: boolean; preloadRunState?: boolean },
  ): Promise<ProgressWrite> {
    state.run.artifacts = state.artifacts;
    const usageBatch = state.usageLedger.checkpoint();
    const vectors = state.vectorIndexes.slice();
    const performance = state.pendingPerformance.slice();
    const parserEvaluations = state.pendingParserEvaluations.length > 0 && (await this.tableExists("parser_eval_results"))
      ? state.pendingParserEvaluations.slice()
      : [];

    // Billable spend in this batch and pages finished since the last write
    // drive the mid-run balance check cadence (spend-check.ts).
    const batchCredits = usageBatch.events.reduce(
      (sum, usage) => sum + (usage.metadata?.billable === false ? 0 : Math.max(0, Number(usage.costCents) || 0)),
      0,
    );
    let spendCheckDue = false;
    let unspentSinceCheck = true;
    let controlRequested: boolean | undefined;
    let preloaded: PreloadedRunState | undefined;
    // Credit leases (credit-lease.ts) replace the cadence counters when on:
    // the checkpoint consumes the run's lease with the credits it debits.
    const leases = await this.creditLeases.active();
    let leaseConsumed = false;
    let leaseObservation: LeaseObservation | null = null;
    // A shard runs beside other shards of the same stage, each with its own
    // snapshot of the run. It must add to the row, never overwrite it: merge
    // its new artifacts and leave status and stats to the unsharded stage
    // pass. Spend is never written here: the usage_events trigger adds the
    // inserted events' cost to spent_cents (migration 0056).
    const shard = state.shard;
    const shardDelta = shard
      ? { artifacts: state.artifactLedger.changedSince(shard.artifacts) }
      : null;
    // workspace_runs.spent_cents once this checkpoint commits.
    let spentCents = state.run.spentCents;

    // Postgres rolls a deadlock victim back whole; every assignment below is
    // reset per attempt and the usage batch commits only after success.
    // The independent writes go out as one pipelined transaction (one round
    // trip, transaction-pipeline.ts); only the credit lease needs a result.
    await retryTransaction(`checkpoint run=${state.run.id}`, async () => {
      spendCheckDue = false;
      unspentSinceCheck = true;
      leaseConsumed = false;
      leaseObservation = null;
      let runUpdateIndex = 0;
      let usageFrom = 0;
      let usageTo = 0;
      let usageCost: (results: readonly unknown[][]) => number = () => 0;
      let counterPath = false;
      let controlIndex = -1;
      let preloadIndex = -1;
      const insertedCost = (results: readonly unknown[]) => usageCost(results.slice(usageFrom, usageTo) as unknown[][]);
      const results = await pipelineTransaction(this.sql, (client) => {
        const statements: PendingQuery<any>[] = [];
        if (prelude) statements.push(...prelude(client));

        const counter = leases
          ? null
          : spendCounterSql(
            client,
            state.run.id,
            shard ? client`0` : client`greatest(0, ${state.run.pagesProcessed}::int - spend_prev.pages_processed)`,
            batchCredits,
          );
        // A late activity may settle paid usage after another actor terminates
        // the run. Keep its terminal outcome and lease state while inserting usage.
        // An explicit retry resets the row to queued before checkpoints resume.
        const runAssignments = shardDelta
          ? client`
            stage = case when workspace_runs.status in ('completed', 'failed') then workspace_runs.stage else ${state.stage} end,
            processed_documents = greatest(workspace_runs.processed_documents, ${state.run.processedDocuments}),
            pages_processed = greatest(workspace_runs.pages_processed, ${state.run.pagesProcessed}),
            artifacts = coalesce(workspace_runs.artifacts, '{}'::jsonb) || ${this.toJson(shardDelta.artifacts)}::jsonb`
          : client`
            status = case when workspace_runs.status in ('completed', 'failed') then workspace_runs.status else ${state.run.status} end,
            stage = case when workspace_runs.status in ('completed', 'failed') then workspace_runs.stage else ${state.stage} end,
            processed_documents = ${state.run.processedDocuments},
            pages_total = ${state.run.pagesTotal},
            pages_processed = ${state.run.pagesProcessed},
            stats = ${this.toJson(state.run.stats ?? {})}::jsonb,
            artifacts = ${this.toJson(state.run.artifacts ?? {})}::jsonb`;
        // The run row is locked from this update to commit, so spent_cents
        // changes only by the trigger on this checkpoint's own usage inserts.
        const runUpdate = counter
          ? client<{ spend_check_due: boolean; no_unchecked_spend: boolean; spent_cents: number | string }[]>`
            update workspace_runs
            set
              ${counter.assignments},
              ${runAssignments},
              last_heartbeat_at = case when workspace_runs.status in ('completed', 'failed') then workspace_runs.last_heartbeat_at else now() end,
              lease_expires_at = case
                when workspace_runs.status in ('completed', 'failed') then workspace_runs.lease_expires_at
                when workspace_runs.kind = 'materialize'
                  then greatest(coalesce(workspace_runs.lease_expires_at, now()), now() + (${this.leaseTtlMs} * interval '1 millisecond'))
                else now() + (${this.leaseTtlMs} * interval '1 millisecond') end,
              updated_at = now()
            from ${counter.from}
            where workspace_runs.id = spend_prev.id
            returning ${counter.checkDue} as spend_check_due,
              workspace_runs.spend_unchecked_credits = 0 as no_unchecked_spend,
              workspace_runs.spent_cents
          `
          : client<{ spent_cents: number | string }[]>`
            update workspace_runs
            set
              ${runAssignments},
              last_heartbeat_at = case when workspace_runs.status in ('completed', 'failed') then workspace_runs.last_heartbeat_at else now() end,
              lease_expires_at = case
                when workspace_runs.status in ('completed', 'failed') then workspace_runs.lease_expires_at
                when workspace_runs.kind = 'materialize'
                  then greatest(coalesce(workspace_runs.lease_expires_at, now()), now() + (${this.leaseTtlMs} * interval '1 millisecond'))
                else now() + (${this.leaseTtlMs} * interval '1 millisecond') end,
              updated_at = now()
            where id = ${state.run.id}
            returning spent_cents
          `;
        counterPath = counter !== null;
        statements.push(runUpdate);
        runUpdateIndex = statements.length - 1;

        // The one per-checkpoint spend delta: newly inserted events only (ON
        // CONFLICT DO NOTHING), so a retried checkpoint or duplicate id adds 0.
        // spent_cents (trigger), the credit debit and the lease all take it.
        // Each insert statement appends the pending debit (the org row is
        // debited by the flusher) for exactly the rows it inserted.
        const usage = runUsageEventStatements({ client, state, usageEvents: usageBatch.events });
        usageFrom = statements.length;
        statements.push(...usage.statements);
        usageTo = statements.length;
        usageCost = usage.cost;

        statements.push(...this.vectorIndexStatements(vectors, client));
        statements.push(...this.performanceRowStatements(client, state, performance));
        statements.push(...this.parserEvaluationStatements(client, parserEvaluations));
        if (options.readControlState) {
          controlIndex = statements.length;
          statements.push(client<{ control_state: string | null }[]>`select control_state from workspace_runs where id = ${state.run.id}`);
        }
        if (options.preloadRunState) {
          preloadIndex = statements.length;
          statements.push(runRowQuery(client, state.run.id), runDocumentRowsQuery(client, state.run.id), stageStateRowsQuery(client, state.run.id));
        }
        return statements;
      }, leases ? async (client, rows) => {
        // Same transaction as the debit: available and the lease fall together.
        const cost = insertedCost(rows);
        if (cost > 0 || options.stageBoundary) {
          leaseConsumed = true;
          leaseObservation = await consumeRunCreditLease(client as unknown as typeof this.sql, state.run, cost);
        }
      } : undefined);

      const runRow = (results[runUpdateIndex] as { spend_check_due?: boolean; no_unchecked_spend?: boolean; spent_cents?: number | string }[])[0];
      if (counterPath) {
        spendCheckDue = runRow?.spend_check_due === true;
        unspentSinceCheck = runRow?.no_unchecked_spend === true;
      }
      spentCents = (Number(runRow?.spent_cents ?? state.run.spentCents) || 0) + insertedCost(results);
      if (preloadIndex >= 0) {
        const [runRows, documentRows, stageRows] = results.slice(preloadIndex, preloadIndex + 3) as [WorkspaceRunRow[], DocumentRow[], StageStateRows];
        if (runRows[0]) preloaded = { run: mapRun(runRows[0]), documents: documentRows.map(mapDocument), stageStates: stageRows };
      }
      if (controlIndex >= 0) controlRequested = CONTROL_REQUEST_STATES.includes((results[controlIndex] as { control_state: string | null }[])[0]?.control_state ?? "");
    });

    // Synchronously together: the committed events leave the pending sum as
    // spent_cents takes them, so runSpentCents never counts them twice or 0 times.
    usageBatch.commit();
    state.run.spentCents = spentCents;
    state.lastProgressFlushAt = Date.now();
    if (shard && shardDelta) {
      Object.assign(shard.artifacts, shardDelta.artifacts);
    }
    // Drop only what this checkpoint wrote; stages may have queued more meanwhile.
    const without = <T>(items: T[], written: T[]) => {
      if (written.length === 0) return items;
      const taken = new Set(written);
      return items.filter((item) => !taken.has(item));
    };
    state.vectorIndexes = without(state.vectorIndexes, vectors);
    state.pendingPerformance = without(state.pendingPerformance, performance);
    state.pendingParserEvaluations = without(state.pendingParserEvaluations, parserEvaluations);
    if (spendCheckDue) await enforceRunSpend(this.sql, state.run, "checkpoint-interval");
    if (leaseConsumed) {
      // The stage boundary handles its lease after the stage.completed event.
      if (options.stageBoundary) return { unspentSinceCheck: true, lease: { observation: leaseObservation }, controlRequested, preloaded };
      await this.creditLeases.afterConsume(state.run, leaseObservation, "checkpoint-interval");
      return { unspentSinceCheck: true, controlRequested, preloaded };
    }
    // After a check the counters are 0 too: the stage boundary has nothing new to check.
    return { unspentSinceCheck: spendCheckDue || unspentSinceCheck, controlRequested, preloaded };
  }

  private performanceRowStatements(
    client: Sql<Record<string, unknown>>,
    state: WorkflowState,
    performance: WorkflowState["pendingPerformance"],
  ): PendingQuery<any>[] {
    const rows = performance.map((perf) => ({
      id: randomUUID(),
      user_id: state.run.userId,
      run_id: state.run.id,
      document_id: perf.documentId ?? null,
      scope: perf.scope,
      stage_name: perf.stageName,
      metric: perf.metric,
      page_number: perf.pageNumber ?? null,
      value: perf.value,
      unit: perf.unit,
      tags: perf.tags,
      metadata: this.toJsonText(perf.metadata ?? {}),
    }));

    return batchedRows(rows).map((batch) => client`
        insert into performance_log ${client(
          batch,
          "id",
          "user_id",
          "run_id",
          "document_id",
          "scope",
          "stage_name",
          "metric",
          "page_number",
          "value",
          "unit",
          "tags",
          "metadata",
        )}
      `);
  }

  private async insertPerformanceRows(
    client: Sql<Record<string, unknown>>,
    state: WorkflowState,
    performance: WorkflowState["pendingPerformance"],
  ): Promise<void> {
    for (const statement of this.performanceRowStatements(client, state, performance)) await statement;
  }

  private parserEvaluationStatements(
    client: Sql<Record<string, unknown>>,
    parserEvaluations: WorkflowState["pendingParserEvaluations"],
  ): PendingQuery<any>[] {
    const rows = parserEvaluations.map((parserEval) => ({
      id: randomUUID(),
      user_id: parserEval.userId,
      run_id: parserEval.runId,
      document_id: parserEval.documentId,
      stage_name: parserEval.stageName,
      parser: parserEval.parser,
      matched_blocks: parserEval.matchedBlocks,
      bbox_blocks: parserEval.bboxBlocks,
      page_backed_blocks: parserEval.pageBackedBlocks,
      match_ratio: parserEval.matchRatio,
      bbox_ratio: parserEval.bboxRatio,
      page_ratio: parserEval.pageRatio,
      selected: parserEval.selected,
      artifact_uri: parserEval.artifactUri ?? null,
      metadata: this.toJsonText(parserEval.metadata ?? {}),
    }));

    return batchedRows(rows).map((batch) => client`
        insert into parser_eval_results ${client(
          batch,
          "id",
          "user_id",
          "run_id",
          "document_id",
          "stage_name",
          "parser",
          "matched_blocks",
          "bbox_blocks",
          "page_backed_blocks",
          "match_ratio",
          "bbox_ratio",
          "page_ratio",
          "selected",
          "artifact_uri",
          "metadata",
        )}
      `);
  }

  private async insertParserEvaluationRows(
    client: Sql<Record<string, unknown>>,
    parserEvaluations: WorkflowState["pendingParserEvaluations"],
  ): Promise<void> {
    for (const statement of this.parserEvaluationStatements(client, parserEvaluations)) await statement;
  }

  async completeRun(state: WorkflowState): Promise<void> {
    state.run.status = "completed";
    state.run.processedDocuments = state.run.totalDocuments;
    state.run.pagesProcessed = state.run.pagesTotal;
    state.stage = "completed";
    for (const document of state.documents) {
      const hasFailedStage = Array.from(state.documentStages.get(document.id)?.values() ?? [])
        .some((stage) => stage.status === "failed");
      if (!["failed", "cancelled", PII_BLOCKED_DOCUMENT_STATUS].includes(document.status) && !hasFailedStage) {
        document.status = "completed";
      }
    }
    state.refreshStats();
    await this.updateProgress(state);

    await recordPageBaseFee(this.sql, state);

    let replacements: CanonicalReplacement[] = [];
    const cutover = state.run.kind === "full-index"
      ? await this.sql.begin(async (tx) => {
        const client = tx as unknown as typeof this.sql;
        // Mode-switch backfills re-key their artifacts onto the source document and retire themselves
        // (see backfill-adoption.ts) before anything below, and must not supersede the source version.
        const adopted = new Set(await adoptBackfillDocuments(client, state.run.id));
        const completed = await completeRunDocuments(client, state.run.id);
        return await supersededInThisTransaction(client, completed.filter((id) => !adopted.has(id)));
      })
      // Independent statements go out in one burst; the supersede read needs the completed ids.
      : await pipelineTransaction(this.sql, (client) => completeRunDocumentStatements(client, state.run.id),
        async (client, [, , completed]) => {
          replacements = await supersededInThisTransaction(client, completed.map((row) => row.id));
        }).then(() => replacements);
    await this.announceReplacements(state, cutover);

    await this.sql`
      update workspace_runs
      set
        status = 'completed',
        stage = 'completed',
        processed_documents = total_documents,
        pages_processed = pages_total,
        lease_expires_at = null,
        updated_at = now()
      where id = ${state.run.id}
    `;
  }

  async failRun(runId: string, stage: string, message: string): Promise<void> {
    const [current] = await this.sql<
      {
        user_id: string;
        stats: JsonMap | null;
        failure_count: number;
      }[]
    >`
      select user_id, stats, coalesce(failure_count, 0) as failure_count
      from workspace_runs
      where id = ${runId}
      limit 1
    `;

    if (!current) {
      return;
    }

    const plan = planRunFailure({
      failureCount: current.failure_count,
      stats: current.stats,
      stage,
      message,
      threshold: this.poisonRunFailureThreshold,
    });
    const nextFailureCount = plan.failureCount;
    const deadLettered = plan.deadLettered;
    const nextStats = plan.stats as JsonMap;

    const [row] = await this.sql<{ user_id: string; stats: JsonMap | null }[]>`
      update workspace_runs
      set
        status = 'failed',
        stage = ${stage},
        error = ${message},
        lease_expires_at = now(),
        failure_count = ${nextFailureCount},
        dead_lettered_at = case when ${deadLettered} then now() else dead_lettered_at end,
        dead_letter_reason = case when ${deadLettered} then ${message} else dead_letter_reason end,
        control_state = case when ${deadLettered} then 'dead-letter' else control_state end,
        stats = ${this.toJson(nextStats)}::jsonb,
        updated_at = now()
      where id = ${runId}
      returning user_id, stats
    `;

    if (!row) {
      return;
    }

    await this.sql`select retire_replaced_pending_documents(${runId})`;
    await this.failProcessingDocumentStages(runId, stage, message);
    await this.failUnfinishedDocumentsForRun(runId);

    await this.appendEvent({
      userId: row.user_id,
      runId,
      stageName: stage,
      eventType: "run.failed",
      status: "failed",
      message: plan.eventMessage,
      progress: {},
      stats: row.stats ?? {},
      payload: plan.eventPayload,
    });
  }

  async releaseRunLease(runId: string): Promise<boolean> {
    const [row] = await this.sql<RunReleaseRow[]>`
      update workspace_runs
      set status = 'queued',
          lease_expires_at = null,
          last_heartbeat_at = null,
          updated_at = now()
      where id = ${runId}
        and status = 'processing'
        and coalesce(control_state, '') not in ('paused', 'cancelled', 'cancel_requested', 'dead-letter')
      returning id, status, control_state
    `;

    return Boolean(row);
  }

  private async failProcessingDocumentStages(
    runId: string,
    stage: string,
    message: string,
  ): Promise<void> {
    await this.sql`
      update document_run_stage_states
      set status = 'failed',
          error = ${message},
          updated_at = now()
      where run_id = ${runId}
        and stage_name = ${stage}
        and status = 'processing'
    `;

    await this.sql`
      update documents d
      set status = 'failed',
          updated_at = now()
      from document_run_stage_states s
      where s.run_id = ${runId}
        and s.stage_name = ${stage}
        and s.status = 'failed'
        and s.document_id = d.id
        and d.status = 'processing'
    `;
  }

  /**
   * A failed Run fails only the Documents that have a failed stage (the one in
   * the breaking stage was marked just before). Untouched Documents go back to
   * queued so "Retry failed documents" resumes them from their checkpoints.
   */
  private async failUnfinishedDocumentsForRun(runId: string): Promise<void> {
    await this.sql`
      update documents d
      set status = case
            when d.superseded_at is not null then 'cancelled'
            when exists (
              select 1 from document_run_stage_states s
              where s.document_id = d.id and s.run_id = d.run_id and s.status = 'failed'
            ) then 'failed'
            else 'queued'
          end,
          updated_at = now()
      where d.run_id = ${runId}
        and d.status not in ('completed', 'failed', 'pii_blocked', 'cancelled')
    `;
  }

  /** The run has a pending pause or cancel request (workspace_runs.control_state). */
  async hasRunControlRequest(runId: string): Promise<boolean> {
    const [row] = await this.sql<{ control_state: string | null }[]>`
      select control_state from workspace_runs where id = ${runId}
    `;
    return ["pause_requested", "paused", "cancel_requested", "cancelled"].includes(row?.control_state ?? "");
  }

  /** Which of `stages` this run has completed (workspace_run_stage_states). */
  async completedRunStages(runId: string, stages: readonly string[]): Promise<Set<string>> {
    if (stages.length === 0) return new Set();
    const rows = await this.sql<{ stage_name: string }[]>`
      select stage_name from workspace_run_stage_states
      where run_id = ${runId} and status = 'completed' and stage_name = any(${this.sql.array([...stages])})
    `;
    return new Set(rows.map((row) => row.stage_name));
  }

  /** The stage the run last started (workspace_runs.stage). */
  async currentRunStage(runId: string): Promise<string | null> {
    const [row] = await this.sql<{ stage: string | null }[]>`select stage from workspace_runs where id = ${runId}`;
    return row?.stage ?? null;
  }

  /** Shards still pending for the run's current stage (the autoscaler turns them into machines). */
  async setRunShardDemand(runId: string, shards: number): Promise<void> {
    await this.sql`update workspace_runs set shard_demand = ${Math.max(0, Math.floor(shards))} where id = ${runId}`;
  }

  /** A shard's final checkpoint, then one shard less of fleet demand. */
  async finishShard(state: WorkflowState): Promise<void> {
    await this.writeProgress(state, (client) => [
      client`update workspace_runs set shard_demand = greatest(0, shard_demand - 1) where id = ${state.run.id}`,
    ]);
  }

  /** Marks a run stage processing and checkpoints run progress in the same transaction. */
  async startRunStage(state: WorkflowState, stage: string): Promise<void> {
    state.setRunStage({
      runId: state.run.id,
      stageName: stage,
      status: "processing",
      attempts: 1,
      artifactUri: "",
      stats: {},
      error: "",
      startedAt: new Date(),
      completedAt: null,
      updatedAt: new Date(),
    });
    state.refreshStats();

    await this.writeProgress(state, (client) => [
      client`
        insert into workspace_run_stage_states (run_id, stage_name, status, attempts, stats, started_at, updated_at)
        values (${state.run.id}, ${stage}, 'processing', 1, '{}'::jsonb, now(), now())
        on conflict (run_id, stage_name) do update
        set status = 'processing',
            attempts = workspace_run_stage_states.attempts + 1,
            error = null,
            started_at = now(),
            completed_at = null,
            updated_at = now()
      `,
      // The stage's own pass starts once its shards are done.
      client`update workspace_runs set shard_demand = 0 where id = ${state.run.id} and shard_demand <> 0`,
    ]);

    await this.appendEvent({
      userId: state.run.userId,
      runId: state.run.id,
      stageName: stage,
      eventType: "stage.started",
      status: "processing",
      message: "stage started",
      progress: {
        stage,
      },
      stats: state.run.stats,
    });
  }

  /** Marks a run stage completed and checkpoints run progress in the same transaction. */
  async completeRunStage(
    state: WorkflowState,
    stage: string,
    artifactUri: string,
    stats: Record<string, unknown>,
    options: { readControlState?: boolean; preloadRunState?: boolean } = {},
  ): Promise<{ controlRequested?: boolean; preloaded?: PreloadedRunState } | void> {
    state.setRunStage({
      runId: state.run.id,
      stageName: stage,
      status: "completed",
      attempts: 1,
      artifactUri,
      stats: { ...stats },
      error: "",
      startedAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    });
    state.refreshStats();

    const progress = await this.writeProgress(state, (client) => [
      client`
        update workspace_run_stage_states
        set status = 'completed',
            artifact_uri = ${artifactUri || null},
            stats = ${this.toJson(stats)}::jsonb,
            error = null,
            completed_at = now(),
            updated_at = now()
        where run_id = ${state.run.id} and stage_name = ${stage}
      `,
    ], { stageBoundary: true, readControlState: options.readControlState, preloadRunState: options.preloadRunState });

    await this.appendEvent({
      userId: state.run.userId,
      runId: state.run.id,
      stageName: stage,
      eventType: "stage.completed",
      status: "completed",
      message: "stage completed",
      progress: {
        stage,
      },
      stats,
    });
    // Stage boundary: check the org balance before the workflow starts the
    // next stage (a pause lands at its existing stage-boundary wait). Skipped
    // when the run has spent nothing since its last check, so cost-free stages
    // add no statement.
    // With credit leases the boundary only queries the org when the run's
    // lease is exhausted, expired or missing (credit-lease.ts).
    // A spend check that paused or blocked the run changed what the checkpoint read; the caller reads again.
    const check = progress.lease
      ? await this.creditLeases.afterConsume(state.run, progress.lease.observation, "stage-boundary")
      : !progress.unspentSinceCheck
        ? await enforceRunSpend(this.sql, state.run, "stage-boundary")
        : null;
    if (check && (check.paused || check.blocked)) return {};
    return { controlRequested: progress.controlRequested, preloaded: progress.preloaded };
  }

  /**
   * Checkpoints a failed run stage. Ordinary failures are counted in
   * stats.ordinaryFailures (kept across retries; startRunStage leaves stats
   * alone and completion replaces them). Returns that total, which the
   * Temporal adapter compares with STAGE_ORDINARY_ATTEMPTS instead of the
   * attempt number, so infrastructure interruptions never use one up.
   */
  async failRunStage(
    state: WorkflowState,
    stage: string,
    message: string,
    options: { countFailure?: boolean } = {},
  ): Promise<number> {
    const increment = options.countFailure === false ? 0 : 1;
    const [counted] = await this.sql<{ ordinary_failures: number }[]>`
      insert into workspace_run_stage_states (run_id, stage_name, status, attempts, error, stats, started_at, updated_at)
      values (${state.run.id}, ${stage}, 'failed', 1, ${message}, jsonb_build_object('ordinaryFailures', ${increment}::int), now(), now())
      on conflict (run_id, stage_name) do update
      set status = 'failed', error = ${message}, updated_at = now(),
          stats = jsonb_set(
            coalesce(workspace_run_stage_states.stats, '{}'::jsonb),
            '{ordinaryFailures}',
            to_jsonb(coalesce((workspace_run_stage_states.stats->>'ordinaryFailures')::int, 0) + ${increment}::int)
          )
      returning coalesce((stats->>'ordinaryFailures')::int, 0) as ordinary_failures
    `;

    await this.failProcessingDocumentStages(state.run.id, stage, message);

    for (const stages of state.documentStages.values()) {
      const stageState = stages.get(stage);
      if (stageState?.status !== "processing") {
        continue;
      }

      state.setDocumentStage({
        ...stageState,
        status: "failed",
        error: message,
        updatedAt: new Date(),
      });
    }

    state.setRunStage({
      runId: state.run.id,
      stageName: stage,
      status: "failed",
      attempts: 1,
      artifactUri: "",
      stats: {},
      error: message,
      startedAt: null,
      completedAt: null,
      updatedAt: new Date(),
    });
    state.refreshStats();

    await this.appendEvent({
      userId: state.run.userId,
      runId: state.run.id,
      stageName: stage,
      eventType: "stage.failed",
      status: "failed",
      message,
      progress: {
        stage,
      },
      stats: state.run.stats,
    });
    return Number(counted?.ordinary_failures ?? increment);
  }

  async startDocumentStage(
    state: WorkflowState,
    documentId: string,
    stage: string,
  ): Promise<void> {
    // Checkpoint and document status in one statement (one commit).
    await retryTransaction(`start-document-stage run=${state.run.id} stage=${stage}`, () => this.sql`
      with checkpoint as (
        insert into document_run_stage_states (run_id, document_id, stage_name, status, attempts, stats, started_at, updated_at)
        values (${state.run.id}, ${documentId}, ${stage}, 'processing', 1, '{}'::jsonb, now(), now())
        on conflict (run_id, document_id, stage_name) do update
        set status = 'processing',
            attempts = document_run_stage_states.attempts + 1,
            error = null,
            started_at = now(),
            completed_at = null,
            updated_at = now()
        returning 1
      )
      update documents
      set status = case
            when status = 'pii_blocked' and ${stage} <> 'pii-detect' then status
            when status = 'completed' and ${indexedInRun(this.sql, state.run.id, documentId)} then status
            else 'processing'
          end,
          -- A PII (re)scan briefly lifts pii_blocked to 'processing'; chunks
          -- written before it must not serve early keyword search until embed
          -- rewrites them after the scan. Embed itself replaces the chunk set
          -- (a retry after failure, or a restart), so the previous attempt's
          -- marker is lifted until the replacement is complete
          -- (server/src/search/eligibility.ts).
          lexical_searchable_at = case when ${stage} in ('pii-detect', 'embed') then null else lexical_searchable_at end,
          updated_at = now()
      where id = ${documentId}
    `.then(() => undefined));

    state.setDocumentStage({
      runId: state.run.id,
      documentId,
      stageName: stage,
      status: "processing",
      attempts: 1,
      artifactUri: "",
      stats: {},
      error: "",
      startedAt: new Date(),
      completedAt: null,
      updatedAt: new Date(),
    });
    state.refreshStats();

    await this.appendEvent({
      userId: state.run.userId,
      runId: state.run.id,
      documentId,
      stageName: stage,
      eventType: "document.started",
      status: "processing",
      message: "document stage started",
      progress: {
        stage,
        documentId,
      },
      stats: state.run.stats,
    });
  }

  async completeDocumentStage(
    state: WorkflowState,
    documentId: string,
    stage: string,
    artifactUri: string,
    stats: Record<string, unknown>,
  ): Promise<void> {
    const completesDocument = stage === "index";
    const vectors = completesDocument
      ? state.vectorIndexes.filter((vector) => vector.documentId === documentId)
      : [];

    // One transaction: vectors are registered before the status flips, and the
    // supersede trigger swaps the previous canonical version out atomically, so
    // search always sees exactly one fully indexed version.
    const stageStateUpdate = (client: Sql<Record<string, unknown>>) => client`
        update document_run_stage_states
        set status = 'completed',
            artifact_uri = ${artifactUri || null},
            stats = ${this.toJson(stats)}::jsonb,
            error = null,
            completed_at = now(),
            updated_at = now()
        where run_id = ${state.run.id} and document_id = ${documentId} and stage_name = ${stage}`;
    let cutover: CanonicalReplacement[] = [];
    if (completesDocument) {
      cutover = await retryTransaction(`complete-document-stage run=${state.run.id} stage=${stage}`, async () => {
        const results = await pipelineTransaction(this.sql, (client) => [
          ...this.vectorIndexStatements(vectors, client),
          stageStateUpdate(client),
          client`
            update documents
            set status = case
                  when status = 'pii_blocked' then status
                  when status = 'completed' and ${indexedInRun(client, state.run.id, documentId)} then status
                  else 'completed'
                end,
                updated_at = now()
            where id = ${documentId}`,
          supersededInThisTransactionQuery(client, [documentId]),
        ]);
        return mapSuperseded(results.at(-1) as Parameters<typeof mapSuperseded>[0]);
      });
    } else {
      // Another stage's checkpoint row cannot change what `indexedInRun` reads (the 'index' row),
      // so the stage state and the document status land in one statement: one commit, one round trip.
      await retryTransaction(`complete-document-stage run=${state.run.id} stage=${stage}`, () => this.sql`
        with checkpoint as (
          ${stageStateUpdate(this.sql)}
          returning 1
        )
        update documents
        set status = case
              when status = 'pii_blocked' then status
              when status = 'completed' and ${indexedInRun(this.sql, state.run.id, documentId)} then status
              else ${stage}
            end,
            updated_at = now()
        where id = ${documentId}
      `.then(() => undefined));
    }
    if (vectors.length > 0) {
      state.vectorIndexes = state.vectorIndexes.filter((vector) => !vectors.includes(vector));
    }
    await this.announceReplacements(state, cutover);

    state.setDocumentStage({
      runId: state.run.id,
      documentId,
      stageName: stage,
      status: "completed",
      attempts: 1,
      artifactUri,
      stats: { ...stats },
      error: "",
      startedAt: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    });
    state.refreshStats();

    if (stage === "index") {
      const document = state.documents.find((entry) => entry.id === documentId);
      const apiKeyId =
        typeof state.run.stats.apiKeyId === "string"
          ? state.run.stats.apiKeyId
          : null;
      await this.incrementApiKeyPageUsage(apiKeyId, document?.pageCount ?? 0);
    }

    await this.appendEvent({
      userId: state.run.userId,
      runId: state.run.id,
      documentId,
      stageName: stage,
      eventType: "document.completed",
      status: "completed",
      message: "document stage completed",
      progress: {
        stage,
        documentId,
      },
      stats,
      payload: {
        artifactUri,
      },
    });

    if (
      typeof stats.plausibilityScore === "number" &&
      stats.plausibilityScore < this.plausibilityWarningThreshold
    ) {
      await this.appendEvent({
        userId: state.run.userId,
        runId: state.run.id,
        documentId,
        stageName: stage,
        eventType: "document.plausibility_warning",
        status: "warning",
        message: `document plausibility score ${stats.plausibilityScore.toFixed(3)} below ${this.plausibilityWarningThreshold.toFixed(3)}`,
        progress: {
          stage,
          documentId,
        },
        stats,
        payload: {
          plausibilityScore: stats.plausibilityScore,
          threshold: this.plausibilityWarningThreshold,
        },
      });
      await this.triggerPlausibilityWarningEmail(
        state.run.id,
        documentId,
        stats.plausibilityScore,
        stage,
      );
    }
  }

  private async incrementApiKeyPageUsage(
    apiKeyId: string | null,
    pageCount: number,
  ): Promise<void> {
    if (!apiKeyId || pageCount <= 0) {
      return;
    }

    const minuteBucket = new Date();
    minuteBucket.setSeconds(0, 0);

    await this.sql`
      insert into api_key_usage (key_id, minute_bucket, request_count, page_count)
      values (${apiKeyId}, ${minuteBucket}, 0, ${pageCount})
      on conflict (key_id, minute_bucket) do update
      set page_count = api_key_usage.page_count + ${pageCount}
    `;
  }

  async failDocumentStage(
    state: WorkflowState,
    documentId: string,
    stage: string,
    message: string,
    artifactUri?: string,
    stats?: Record<string, unknown>,
  ): Promise<void> {
    // Checkpoint and document status in one statement (one commit).
    await this.sql`
      with checkpoint as (
      insert into document_run_stage_states (
        run_id,
        document_id,
        stage_name,
        status,
        attempts,
        artifact_uri,
        stats,
        error,
        started_at,
        updated_at
      )
      values (
        ${state.run.id},
        ${documentId},
        ${stage},
        'failed',
        1,
        ${artifactUri || null},
        ${this.toJson(stats ?? {})}::jsonb,
        ${message},
        now(),
        now()
      )
      on conflict (run_id, document_id, stage_name) do update
      set status = 'failed',
          artifact_uri = ${artifactUri || null},
          stats = ${this.toJson(stats ?? {})}::jsonb,
          error = ${message},
          updated_at = now()
      returning 1
      )
      update documents
      set status = 'failed',
          updated_at = now()
      where id = ${documentId}
        and status not in ('completed', 'failed', 'pii_blocked')
    `;

    state.setDocumentStage({
      runId: state.run.id,
      documentId,
      stageName: stage,
      status: "failed",
      attempts: 1,
      artifactUri: artifactUri ?? "",
      stats: stats ?? {},
      error: message,
      startedAt: null,
      completedAt: null,
      updatedAt: new Date(),
    });
    state.refreshStats();

    await this.appendEvent({
      userId: state.run.userId,
      runId: state.run.id,
      documentId,
      stageName: stage,
      eventType: "document.failed",
      status: "failed",
      message,
      progress: {
        stage,
        documentId,
      },
      stats: stats ?? state.run.stats,
      payload: artifactUri ? { artifactUri } : {},
    });
  }

  async purgeSupersededDocuments(
    storage: PurgeStorage,
    options: SupersededPurgeOptions,
  ): Promise<SupersededPurgeResult> {
    // Replaced versions, then deleted documents, then deleted runs' storage
    // prefixes and dropped org vector tables; all clean storage and LanceDB.
    const superseded = await purgeSupersededDocuments(this.sql, storage, options);
    const deleted = await drainDocumentCleanupQueue(this.sql, storage, options);
    const prefixes = await drainStorageCleanupQueue(this.sql, storage, options);
    return {
      purged: superseded.purged + deleted.purged + prefixes.purged,
      failed: superseded.failed + deleted.failed + prefixes.failed,
      ...(superseded.archived ? { archived: superseded.archived } : {}),
    };
  }

  /**
   * Buffers a run event for the next coalesced write (≤ WORKER_RUN_EVENT_FLUSH_MS);
   * terminal run events are written before this resolves. See run-event-store.ts.
   */
  async appendEvent(event: WorkspaceRunEvent): Promise<void> {
    await this.runEvents.append(event);
  }

  /** Writes buffered run events now. */
  async flushRunEvents(): Promise<void> {
    await this.runEvents.flush();
  }

  private async insertVectorIndex(vector: VectorIndex): Promise<void> {
    await this.insertVectorIndexes([vector]);
  }

  /** Emits document.replaced once a newer canonical version has taken over in search. */
  private async announceReplacements(state: WorkflowState, replacements: CanonicalReplacement[]): Promise<void> {
    for (const replacement of replacements) {
      await this.appendEvent({
        userId: state.run.userId,
        runId: state.run.id,
        documentId: replacement.documentId,
        eventType: "document.replaced",
        status: "completed",
        message: `Replaced ${replacement.replacedDocumentIds.length} previous version(s) of ${replacement.canonicalId}`,
        // progress travels on the live NOTIFY channel; payload is stored only.
        progress: {
          canonicalId: replacement.canonicalId,
          replacedDocumentIds: replacement.replacedDocumentIds,
        },
        payload: { ...replacement },
      });
    }
    await this.triggerDocumentWebhooks(state, replacements);
  }

  private vectorIndexStatements(
    vectors: VectorIndex[],
    client: Sql<Record<string, unknown>> = this.sql,
  ): PendingQuery<any>[] {
    if (vectors.length === 0) {
      return [];
    }

    const rows = vectors.map((vector) => ({
      id: randomUUID(),
      document_id: vector.documentId,
      backend: vector.backend,
      bucket: vector.bucket,
      path: vector.path,
      embedding_model: vector.embeddingModel,
      dimension: vector.dimension,
    }));

    const statements: PendingQuery<any>[] = batchedRows(rows).map((batch) => client`
      insert into vector_indexes ${client(
        batch,
        "id",
        "document_id",
        "backend",
        "bucket",
        "path",
        "embedding_model",
        "dimension",
      )}
      on conflict (document_id, backend, embedding_model, dimension)
      do update set bucket = excluded.bucket, path = excluded.path
    `);
    // Search serves each document from the index config it was built with (workspaces.index_configs).
    const hashes = new Map(vectors.filter((vector) => vector.indexConfigHash).map((vector) => [vector.documentId, vector.indexConfigHash!]));
    if (hashes.size > 0) {
      statements.push(client`
        update documents d set index_config_hash = v.hash
        from unnest(${[...hashes.keys()]}::text[], ${[...hashes.values()]}::text[]) as v(id, hash)
        where d.id = v.id
      `);
    }
    return statements;
  }

  private async insertVectorIndexes(
    vectors: VectorIndex[],
    client: Sql<Record<string, unknown>> = this.sql,
  ): Promise<void> {
    for (const statement of this.vectorIndexStatements(vectors, client)) await statement;
  }

  /**
   * Records run webhook events in the outbox. The API delivers them with its
   * signed, SSRF-checked dispatcher; the worker never calls subscriber URLs.
   */
  async triggerWebhooks(runId: string, event: string): Promise<void> {
    await this.enqueueWebhookEvent(event, this.sql`
      select r.user_id, jsonb_build_object(
        'event', ${event}::text,
        'runId', r.id,
        'workspaceId', r.workspace_id,
        'status', r.status,
        'stage', r.stage,
        'processedDocuments', r.processed_documents,
        'pagesProcessed', r.pages_processed,
        'failedDocuments', coalesce((r.stats->>'failedDocuments')::int, 0),
        'error', r.error
      ) as payload
      from workspace_runs r
      where r.id = ${runId}
    `);
  }

  private async triggerDocumentWebhooks(
    state: WorkflowState,
    replacements: CanonicalReplacement[],
  ): Promise<void> {
    for (const replacement of replacements) {
      const payload = {
        event: "document.replaced",
        runId: state.run.id,
        workspaceId: state.run.workspaceId,
        ...replacement,
      };
      await this.enqueueWebhookEvent("document.replaced", this.sql`
        select ${state.run.userId}::text as user_id, ${this.toJson(payload)}::jsonb as payload
      `);
    }
  }

  /** Inserts one outbox row per source row, only for users subscribed to the event, and wakes the API. */
  private async enqueueWebhookEvent(
    event: string,
    source: postgres.PendingQuery<postgres.Row[]>,
  ): Promise<void> {
    await this.sql`
      with source as (${source}),
      queued as (
        insert into webhook_outbox (id, user_id, event_type, payload)
        select gen_random_uuid()::text, source.user_id, ${event}, source.payload
        from source
        where exists (
          select 1 from webhooks w
          where w.user_id = source.user_id and w.active = true and ${event} = any(w.events)
        )
        returning id
      )
      select pg_notify('webhook_outbox', id) from queued
    `;
  }

  async triggerRunEmails(
    runId: string,
    event: "run.completed" | "run.failed",
  ): Promise<void> {
    const rows = await this.sql.unsafe<
      Array<{
        user_id: string;
        org_id: string | null;
        workspace_id: string;
        workspace_name: string;
        stage: string;
        error: string | null;
        email: string;
        run_completed: boolean | null;
        run_failed: boolean | null;
      }>
    >(
      `
      select
        r.user_id,
        r.org_id,
        r.workspace_id,
        w.name as workspace_name,
        r.stage,
        r.error,
        u.email,
        np.run_completed,
        np.run_failed
      from workspace_runs r
      join workspaces w on w.id = r.workspace_id
      join "user" u on u.id = r.user_id
      left join notification_prefs np on np.user_id = r.user_id
      -- Extract runs send their own completion email with the download (server services/extracts.ts).
      where r.id = $1 and r.extract_id is null
      limit 1
      `,
      [runId],
    );
    const row = rows[0];

    if (!row) {
      return;
    }

    const enabled =
      event === "run.completed"
        ? (row.run_completed ?? true)
        : (row.run_failed ?? true);
    if (!enabled) {
      return;
    }

    const subject =
      event === "run.completed"
        ? `Run completed: ${row.workspace_name}`
        : `Run failed: ${row.workspace_name}`;
    const lines = [
      `Workspace: ${row.workspace_name}`,
      `Run ID: ${runId}`,
      `Status: ${event === "run.completed" ? "completed" : "failed"}`,
      `Stage: ${row.stage}`,
    ];
    if (row.error) {
      lines.push(PUBLIC_ERROR_MESSAGES.processing);
    }

    await this.deliverNotificationEmail({
      deliveryId: randomUUID(),
      userId: row.user_id,
      orgId: row.org_id,
      workspaceId: row.workspace_id,
      runId,
      event,
      recipient: row.email,
      subject,
      text: lines.join("\n"),
      html: `<p>${lines.map((line) => escapeHtml(line)).join("<br />")}</p>`,
      metadata: {
        runId,
        stage: row.stage,
        error: row.error,
      },
    });
  }

  async triggerPlausibilityWarningEmail(
    runId: string,
    documentId: string,
    plausibilityScore: number,
    stage: string,
  ): Promise<void> {
    const rows = await this.sql.unsafe<
      Array<{
        user_id: string;
        org_id: string | null;
        workspace_id: string;
        workspace_name: string;
        filename: string;
        email: string;
        quality_warning: boolean | null;
      }>
    >(
      `
      select
        r.user_id,
        r.org_id,
        r.workspace_id,
        w.name as workspace_name,
        d.filename,
        u.email,
        np.quality_warning
      from workspace_runs r
      join workspaces w on w.id = r.workspace_id
      join documents d on d.id = $2 and d.run_id = r.id
      join "user" u on u.id = r.user_id
      left join notification_prefs np on np.user_id = r.user_id
      where r.id = $1
      limit 1
      `,
      [runId, documentId],
    );
    const row = rows[0];

    if (!row || row.quality_warning === false) {
      return;
    }

    const subject = `Extraction plausibility warning: ${row.filename}`;
    const lines = [
      `Workspace: ${row.workspace_name}`,
      `Run ID: ${runId}`,
      `Document: ${row.filename}`,
      `Stage: ${stage}`,
      `Plausibility score: ${plausibilityScore.toFixed(3)}`,
      `Threshold: ${this.plausibilityWarningThreshold.toFixed(3)}`,
    ];

    await this.deliverNotificationEmail({
      deliveryId: randomUUID(),
      userId: row.user_id,
      orgId: row.org_id,
      workspaceId: row.workspace_id,
      runId,
      documentId,
      event: "plausibility.warning",
      recipient: row.email,
      subject,
      text: lines.join("\n"),
      html: `<p>${lines.map((line) => escapeHtml(line)).join("<br />")}</p>`,
      metadata: {
        runId,
        documentId,
        filename: row.filename,
        plausibilityScore,
        threshold: this.plausibilityWarningThreshold,
        stage,
      },
    });
  }

  async processBudgetAlerts(): Promise<void> {
    await this.processWorkspaceBudgetAlerts();
    await this.processOrganizationBudgetAlerts();
  }

  async processSecretExpiryAlerts(daysBefore = 7): Promise<void> {
    type ExpiringSecretRow = {
      id: string;
      workspace_id: string;
      name: string;
      type: string;
      expires_at: string;
      workspace_name: string;
      owner_user_id: string;
      owner_email: string;
    };

    const rows = await this.sql<ExpiringSecretRow[]>`
      select
        ws.id,
        ws.workspace_id,
        ws.name,
        ws.type,
        ws.expires_at::text,
        w.name as workspace_name,
        w.user_id as owner_user_id,
        u.email as owner_email
      from workspace_secrets ws
      join workspaces w on w.id = ws.workspace_id
      join "user" u on u.id = w.user_id
      where ws.expires_at is not null
        and ws.expires_at <= now() + (${daysBefore} * interval '1 day')
        and ws.expires_at > now()
      order by ws.expires_at asc
    `;

    for (const row of rows) {
      const daysLeft = Math.ceil(
        (new Date(row.expires_at).getTime() - Date.now()) /
          (1000 * 60 * 60 * 24),
      );
      const subject = `Secret expiring soon: ${row.name} (${row.workspace_name})`;
      const text = [
        `Workspace: ${row.workspace_name}`,
        `Secret name: ${row.name}`,
        `Type: ${row.type}`,
        `Expires: ${row.expires_at} (in ${daysLeft} day${daysLeft === 1 ? "" : "s"})`,
        `Rotate this secret in workspace settings before it expires.`,
      ].join("\n");
      const html = `<p>${text.replaceAll("\n", "<br/>")}</p>`;

      await this.deliverNotificationEmail({
        deliveryId: randomUUID(),
        userId: row.owner_user_id,
        orgId: null,
        workspaceId: row.workspace_id,
        event: "cost.alert",
        recipient: row.owner_email,
        subject,
        text,
        html,
        metadata: {
          secretId: row.id,
          secretName: row.name,
          expiresAt: row.expires_at,
          daysLeft,
        },
      });

      console.log(
        `[secrets] expiry-warning secretId=${row.id} name=${row.name} workspace=${row.workspace_name} daysLeft=${daysLeft}`,
      );
    }
  }

  async runRetentionSweep(
    storage: ArtifactStore,
    batchSize: number,
  ): Promise<void> {
    await this.purgeExpiredArtifacts(storage, batchSize);
    await this.deleteExpiredRuns(batchSize);
    await this.pruneOperationalLogs();
  }

  async runStorageIntegritySweep(
    storage: ArtifactStore,
    options?: {
      maxKeys?: number;
      prefix?: string | null;
    },
  ): Promise<StorageIntegrityReport> {
    const maxKeys = Math.max(100, options?.maxKeys ?? 20_000);
    const prefix = options?.prefix?.trim() || null;
    const [references, runChecks, listedKeys] = await Promise.all([
      this.loadStorageIntegrityReferences(storage.bucket),
      this.loadStorageIntegrityRunChecks(),
      storage.listKeys({ prefix: prefix ?? undefined, maxKeys }),
    ]);

    const expectedKeySet = new Set(
      references
        .filter((reference) => !prefix || reference.key.startsWith(prefix))
        .map((reference) => reference.key),
    );
    const checkedReferences = Array.from(expectedKeySet).slice(0, maxKeys);
    // Existence comes from listing each run's prefix (`<user>/<run>/`) completely:
    // one LIST per run instead of a HEAD per artifact, with no reliance on listing
    // order. Keys a complete listing lacks are confirmed with a HEAD before they
    // count as missing; prefixes too large to list, and keys without one, are HEADed.
    const existingKeySet = new Set<string>();
    const { byPrefix, ungrouped } = groupReferencesByRunPrefix(checkedReferences);
    const needsHead = [...ungrouped];
    let listCalls = 0;
    const prefixes = [...byPrefix.entries()];
    for (let index = 0; index < prefixes.length; index += 8) {
      await Promise.all(prefixes.slice(index, index + 8).map(async ([runPrefix, keys]) => {
        const listing = await storage.listKeys({ prefix: runPrefix, maxKeys: 10_000 }).catch(() => null);
        listCalls += 1;
        if (!listing || listing.truncated) { needsHead.push(...keys); return; }
        const listed = new Set(listing.keys);
        for (const key of keys) {
          if (listed.has(key)) existingKeySet.add(key);
          else needsHead.push(key);
        }
      }));
    }

    for (let index = 0; index < needsHead.length; index += 25) {
      const batch = needsHead.slice(index, index + 25);
      const results = await Promise.all(
        batch.map(async (key) => ({
          key,
          exists: await storage.objectExists(key),
        })),
      );

      for (const result of results) {
        if (result.exists) {
          existingKeySet.add(result.key);
        }
      }
    }
    console.log(`[storage-integrity] references=${checkedReferences.length} run_prefixes=${byPrefix.size} list_calls=${listCalls} head_checks=${needsHead.length}`);

    const baseReport = buildStorageIntegrityReport({
      bucket: storage.bucket,
      prefix,
      maxKeys,
      references,
      runChecks,
      listedKeys: listedKeys.keys,
      listedKeysTruncated: listedKeys.truncated,
      nextContinuationToken: listedKeys.nextContinuationToken,
      checkedKeys: checkedReferences,
      existingKeys: existingKeySet,
    });

    const reportKey = `system/integrity/${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.json`;
    const persistedReport: StorageIntegrityReport = {
      ...baseReport,
      reportKey,
      reportUri: storage.uri(reportKey),
    };
    await storage.putJson(reportKey, persistedReport);

    await this.appendAuditLog({
      action: "maintenance.storage_integrity_sweep",
      resourceType: "maintenance",
      resourceId: reportKey,
      metadata: {
        reportUri: persistedReport.reportUri,
        ...persistedReport.summary,
        sweep: persistedReport.sweep,
      },
    });

    console.log(
      `[integrity-sweep] bucket=${storage.bucket} prefix=${prefix ?? "all"} missing=${persistedReport.summary.missingObjectCount} orphaned=${persistedReport.summary.orphanedObjectCount} dangling=${persistedReport.summary.danglingMetadataCount} report=${persistedReport.reportUri}`,
    );

    return persistedReport;
  }

  private async pruneOperationalLogs(): Promise<void> {
    await this.sql`
      delete from api_key_usage
      where minute_bucket < now() - make_interval(days => ${this.apiKeyUsageRetentionDays})
    `;

    await this.sql`
      delete from performance_log
      where created_at < now() - make_interval(days => ${this.perfLogRetentionDays})
    `;
  }

  get pageTasks(): PageTaskStore { return new PageTaskStore(this.sql, this.creditLeases); }
  get workerSlots(): WorkerSlotStore { return new WorkerSlotStore(this.sql, this.workerSlotOptions); }
  /** Queue state and per-org slot demand for the autoscaler target (shared with the app). */
  async readWorkerScalerSnapshot(params: WorkerScalerQueryParams): Promise<WorkerScalerSnapshot> {
    return queryWorkerScalerSnapshot(this.sql as unknown as ScalerSql, params);
  }

  /**
   * This worker's row in the capability registry (worker-capabilities.ts):
   * what its build supports, with credit leases and early lexical search
   * advertised only when their config and schema are in place.
   */
  capabilityRegistry(options: Omit<WorkerCapabilityRegistryOptions, "sql" | "capabilities">): WorkerCapabilityRegistry {
    const lexicalColumnPresent = lexicalColumnProbe(this.sql);
    return new WorkerCapabilityRegistry({
      ...options,
      sql: this.sql,
      capabilities: () => resolveWorkerCapabilities({
        creditLeasesActive: () => this.creditLeases.active(),
        lexicalColumnPresent,
      }),
    });
  }

  async tryMaintenanceLease(name: string, holder: string, ttlMs: number): Promise<boolean> {
    return tryMaintenanceLease(this.sql, { name, holder, ttlMs });
  }

  /** Applies pending credit debits to org pools (maintenance leader, every few seconds). */
  async flushPendingCreditDebits(): Promise<{ orgs: number; debits: number; credits: number }> {
    return flushPendingCreditDebits(this.sql);
  }

  async setPageStageComplete(
    runId: string,
    documentId: string,
    stageName: string,
    pageNumber: number,
  ): Promise<void> {
    await retryTransaction(`page-stage run=${runId} stage=${stageName}`, () => this.sql`
      insert into page_stage_states (run_id, document_id, stage_name, page_number, status, completed_at, created_at)
      values (${runId}, ${documentId}, ${stageName}, ${pageNumber}, 'completed', now(), now())
      on conflict (run_id, document_id, stage_name, page_number) do update
      set status = 'completed', completed_at = now()
    `.then(() => undefined));
  }

  async setPagesStageComplete(runId: string, documentId: string, stageName: string, pageNumbers: number[]): Promise<void> {
    if (pageNumbers.length === 0) return;
    // Sorted: concurrent batches over the same pages take row locks in one order.
    const pages = [...new Set(pageNumbers)].sort((a, b) => a - b);
    await retryTransaction(`page-stages run=${runId} stage=${stageName}`, () => this.sql`
      insert into page_stage_states (run_id, document_id, stage_name, page_number, status, completed_at, created_at)
      select ${runId}, ${documentId}, ${stageName}, value::int, 'completed', now(), now()
      from jsonb_array_elements_text(${this.sql.json(pages)}::jsonb)
      on conflict (run_id, document_id, stage_name, page_number) do update
      set status = 'completed', completed_at = now()
    `.then(() => undefined));
  }

  async getCompletedPages(
    runId: string,
    documentId: string,
    stageName: string,
  ): Promise<Set<number>> {
    const rows = await this.sql<{ page_number: number }[]>`
      select page_number
      from page_stage_states
      where run_id = ${runId}
        and document_id = ${documentId}
        and stage_name = ${stageName}
        and status = 'completed'
    `;
    return new Set(rows.map((r) => r.page_number));
  }

  async insertChunks(
    chunks: Array<{
      id: string;
      documentId: string;
      runId: string;
      userId: string;
      chunkIndex: number;
      text: string;
      headingPath: string[];
      pageNumber?: number;
      tokenEstimate: number;
      metadata: Record<string, unknown>;
      contentHash?: string;
      pipelineVersion?: string;
    }>,
  ): Promise<void> {
    if (chunks.length === 0) {
      return;
    }

    const rows = chunks.map((chunk) => ({
      id: chunk.id,
      document_id: chunk.documentId,
      run_id: chunk.runId,
      user_id: chunk.userId,
      chunk_index: chunk.chunkIndex,
      text: chunk.text,
      heading_path: chunk.headingPath,
      page_number: chunk.pageNumber ?? null,
      token_estimate: chunk.tokenEstimate,
      metadata: this.toJson(chunk.metadata),
      content_hash: chunk.contentHash ?? null,
      pipeline_version: chunk.pipelineVersion ?? null,
    }));

    for (const batch of batchedRows(rows)) {
      await this.sql`
        insert into document_chunks ${this.sql(
          batch,
          "id",
          "document_id",
          "run_id",
          "user_id",
          "chunk_index",
          "text",
          "heading_path",
          "page_number",
          "token_estimate",
          "metadata",
          "content_hash",
          "pipeline_version",
        )}
        on conflict (id) do update
        set
          document_id = excluded.document_id,
          run_id = excluded.run_id,
          user_id = excluded.user_id,
          chunk_index = excluded.chunk_index,
          text = excluded.text,
          heading_path = excluded.heading_path,
          page_number = excluded.page_number,
          token_estimate = excluded.token_estimate,
          metadata = excluded.metadata,
          content_hash = excluded.content_hash,
          pipeline_version = excluded.pipeline_version
      `;
    }
  }

  /** Content-addressed embedding reuse (embeddings/embedding-reuse.ts); always org-scoped. */
  async findEmbeddingReuseRefs(orgId: string, keys: readonly string[]): Promise<EmbeddingReuseRef[]> {
    const refs: EmbeddingReuseRef[] = [];
    for (const batch of batchedRows([...new Set(keys)])) {
      const rows = await this.sql<{ embed_key: string; artifact_uri: string; chunk_index: number }[]>`
        select embed_key, artifact_uri, chunk_index
        from embedding_reuse_refs
        where org_id = ${orgId} and embed_key = any(${batch}::text[])
      `;
      refs.push(...rows.map((row) => ({ key: row.embed_key, artifactUri: row.artifact_uri, chunkIndex: row.chunk_index })));
    }
    return refs;
  }

  /** Points each key at its newest artifact, which outlives older purged versions. */
  async recordEmbeddingReuseRefs(orgId: string, refs: readonly EmbeddingReuseRef[]): Promise<void> {
    // One row per key (an upsert cannot touch a row twice), in key order so
    // concurrent writers lock rows in the same order.
    const unique = [...new Map(refs.map((ref) => [ref.key, ref])).values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const batch of batchedRows(unique)) {
      await this.sql`
        insert into embedding_reuse_refs (org_id, embed_key, artifact_uri, chunk_index)
        select ${orgId}, ref.embed_key, ref.artifact_uri, ref.chunk_index
        from unnest(${batch.map((ref) => ref.key)}::text[], ${batch.map((ref) => ref.artifactUri)}::text[], ${batch.map((ref) => ref.chunkIndex)}::int[])
          as ref(embed_key, artifact_uri, chunk_index)
        on conflict (org_id, embed_key) do update
        set artifact_uri = excluded.artifact_uri, chunk_index = excluded.chunk_index, updated_at = now()
        where embedding_reuse_refs.artifact_uri is distinct from excluded.artifact_uri
          or embedding_reuse_refs.chunk_index is distinct from excluded.chunk_index
      `;
    }
  }

  /** Drops refs whose artifact no longer holds the keyed vector (purged or rewritten). */
  async forgetEmbeddingReuseRefs(orgId: string, artifactUri: string, keys: readonly string[]): Promise<void> {
    for (const batch of batchedRows([...new Set(keys)])) {
      await this.sql`
        delete from embedding_reuse_refs
        where org_id = ${orgId} and artifact_uri = ${artifactUri} and embed_key = any(${batch}::text[])
      `;
    }
  }

  /**
   * Ingest report page facts. Source facts (text layer, images) and vision
   * outcomes come from different stages, so each write only touches its own
   * columns and never clears the other stage's values.
   */
  async upsertPageFacts(rows: readonly PageFactUpsert[]): Promise<void> {
    const source = rows.filter((row) => row.textBytes !== undefined || row.imageCount !== undefined);
    const vision = rows.filter((row) => row.visionStatus !== undefined);
    for (const batch of batchedRows(source)) {
      const payload = batch.map((row) => ({
        document_id: row.documentId, page_number: row.pageNumber, run_id: row.runId,
        text_bytes: row.textBytes ?? null, word_count: row.wordCount ?? null,
        image_count: row.imageCount ?? null, facts_source: row.factsSource ?? null,
      }));
      await this.sql`
        insert into document_page_facts (document_id, page_number, run_id, text_bytes, word_count, image_count, facts_source)
        select r.document_id, r.page_number, r.run_id, r.text_bytes, r.word_count, r.image_count, r.facts_source
        from jsonb_to_recordset(${this.sql.json(payload as unknown as JSONValue)}::jsonb) as r(
          document_id text, page_number integer, run_id text, text_bytes integer, word_count integer,
          image_count integer, facts_source text
        )
        join documents d on d.id = r.document_id
        on conflict (document_id, page_number) do update
        set run_id = excluded.run_id,
            text_bytes = excluded.text_bytes,
            word_count = excluded.word_count,
            image_count = excluded.image_count,
            facts_source = excluded.facts_source,
            updated_at = now()
      `;
    }
    for (const batch of batchedRows(vision)) {
      const payload = batch.map((row) => ({
        document_id: row.documentId, page_number: row.pageNumber, run_id: row.runId,
        vision_status: row.visionStatus ?? null, vision_text_bytes: row.visionTextBytes ?? null,
      }));
      await this.sql`
        insert into document_page_facts (document_id, page_number, run_id, vision_status, vision_text_bytes)
        select r.document_id, r.page_number, r.run_id, r.vision_status, r.vision_text_bytes
        from jsonb_to_recordset(${this.sql.json(payload as unknown as JSONValue)}::jsonb) as r(
          document_id text, page_number integer, run_id text, vision_status text, vision_text_bytes integer
        )
        join documents d on d.id = r.document_id
        on conflict (document_id, page_number) do update
        set run_id = excluded.run_id,
            vision_status = excluded.vision_status,
            vision_text_bytes = excluded.vision_text_bytes,
            updated_at = now()
      `;
    }
  }

  async setDocumentTitleIfAbsent(documentId: string, title: DerivedDocumentTitle): Promise<boolean> {
    const rows = await this.sql`
      update documents
      set metadata = coalesce(metadata, '{}'::jsonb)
        || jsonb_build_object('title', ${title.title}::text, 'titleSource', ${title.source}::text)
      where id = ${documentId}
        and nullif(btrim(metadata ->> 'title'), '') is null
      returning id
    `;
    return rows.length > 0;
  }

  async insertPages(
    pages: Array<{
      id: string;
      documentId: string;
      runId: string;
      userId: string;
      pageNumber: number;
      text: string;
      tokenEstimate: number;
    }>,
  ): Promise<void> {
    if (pages.length === 0) {
      return;
    }

    const rows = pages.map((page) => ({
      id: page.id,
      document_id: page.documentId,
      run_id: page.runId,
      user_id: page.userId,
      page_number: page.pageNumber,
      text: page.text,
      token_estimate: page.tokenEstimate,
    }));

    for (const batch of batchedRows(rows)) {
      await this.sql`
        insert into document_pages ${this.sql(
          batch,
          "id",
          "document_id",
          "run_id",
          "user_id",
          "page_number",
          "text",
          "token_estimate",
        )}
        on conflict (id) do update
        set run_id = excluded.run_id,
            user_id = excluded.user_id,
            page_number = excluded.page_number,
            text = excluded.text,
            token_estimate = excluded.token_estimate
      `;
    }
  }

  /**
   * The document's chunks are replaced by `keepChunkIds`; rows an earlier attempt
   * wrote beyond them are stale. Scoped to this document only.
   */
  async staleDocumentChunkIds(documentId: string, keepChunkIds: readonly string[]): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      select id from document_chunks
      where document_id = ${documentId} and id <> all(${this.sql.array([...keepChunkIds])}::text[])
    `;
    return rows.map((row) => row.id);
  }

  async deleteStaleDocumentChunks(documentId: string, keepChunkIds: readonly string[]): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      delete from document_chunks
      where document_id = ${documentId} and id <> all(${this.sql.array([...keepChunkIds])}::text[])
      returning id
    `;
    return rows.map((row) => row.id);
  }

  /**
   * deleteStaleDocumentChunks, then (when the replacement set is non-empty) markDocumentLexicalSearchable,
   * in one transaction and one round trip: the marker never precedes the tail drop.
   */
  async finalizeDocumentChunks(documentId: string, keepChunkIds: readonly string[], markSearchable: boolean): Promise<void> {
    await pipelineTransaction(this.sql, (client) => [
      client`
        delete from document_chunks
        where document_id = ${documentId} and id <> all(${client.array([...keepChunkIds])}::text[])
      `,
      ...(markSearchable ? [client`
        update documents
        set lexical_searchable_at = coalesce(lexical_searchable_at, now())
        where id = ${documentId}
      `] : []),
    ]);
  }

  /**
   * Every chunk row of the document is written: keyword search may serve it
   * before the index stage completes (server/src/search/eligibility.ts).
   * Called after the last insertChunks batch, so a reader never sees a
   * half-materialized chunk set behind the marker.
   */
  async markDocumentLexicalSearchable(documentId: string): Promise<void> {
    await this.sql`
      update documents
      set lexical_searchable_at = coalesce(lexical_searchable_at, now())
      where id = ${documentId}
    `;
  }

  async linkChunksToPages(documentId: string, runId: string): Promise<void> {
    await this.sql`
      update document_chunks c
      set parent_page_id = p.id
      from document_pages p
      where c.document_id = ${documentId}
        and c.run_id = ${runId}
        and p.document_id = ${documentId}
        and p.run_id = ${runId}
        and c.page_number = p.page_number
        and c.parent_page_id is null
    `;
  }

  async insertPropositions(
    propositions: Array<{
      id: string;
      documentId: string;
      runId: string;
      userId: string;
      chunkIndex: number;
      text: string;
      sourceParagraph: string;
      tokenEstimate: number;
    }>,
  ): Promise<void> {
    if (propositions.length === 0) {
      return;
    }

    const rows = propositions.map((prop) => ({
      id: prop.id,
      document_id: prop.documentId,
      run_id: prop.runId,
      user_id: prop.userId,
      chunk_index: prop.chunkIndex,
      text: prop.text,
      source_paragraph: prop.sourceParagraph,
      token_estimate: prop.tokenEstimate,
    }));

    for (const batch of batchedRows(rows)) {
      await this.sql`
        insert into document_propositions ${this.sql(
          batch,
          "id",
          "document_id",
          "run_id",
          "user_id",
          "chunk_index",
          "text",
          "source_paragraph",
          "token_estimate",
        )}
        on conflict (id) do nothing
      `;
    }
  }

  async insertSummary(summary: {
    id: string;
    documentId: string;
    runId: string;
    userId: string;
    summary: string;
  }): Promise<void> {
    await this.sql`
      insert into document_summaries (
        id, document_id, run_id, user_id, summary
      )
      values (
        ${summary.id},
        ${summary.documentId},
        ${summary.runId},
        ${summary.userId},
        ${summary.summary}
      )
      on conflict (id) do nothing
    `;
  }

  /**
   * Partial reprocess: seed the outputs of the stages this run does not
   * execute (`reusedStages`) from each document's source version
   * (documents.reused_from_document_id): the source's document artifacts
   * (re-keyed to the new document), its completed stage checkpoints for the
   * reused stages, and the derived rows those stages write. Runs in one
   * transaction and is idempotent, so a retried run start re-seeds nothing.
   * Documents whose source is gone, purged, or lost its run artifacts to
   * retention are returned and nothing is seeded.
   */
  async seedReusedStageOutputs(
    runId: string,
    reusedStages: readonly string[],
  ): Promise<{ seededDocuments: number; unavailable: Array<{ documentId: string; reason: string }> }> {
    if (reusedStages.length === 0) return { seededDocuments: 0, unavailable: [] };
    return await this.sql.begin(async (tx) => {
      const client = tx as unknown as typeof this.sql;
      const docs = await client<{
        id: string;
        reused_from_document_id: string | null;
        source_id: string | null;
        source_run_id: string | null;
        source_purged: boolean | null;
        source_artifacts_purged: boolean | null;
      }[]>`
        select d.id, d.reused_from_document_id, source.id as source_id, source.run_id as source_run_id,
          source.purged_at is not null as source_purged,
          source_run.artifacts_purged_at is not null as source_artifacts_purged
        from documents d
        left join documents source on source.id = d.reused_from_document_id
        left join workspace_runs source_run on source_run.id = source.run_id
        where d.run_id = ${runId}
        order by d.created_at, d.id
      `;
      // Re-checked here, not only at request time: retention or a version
      // purge may have removed the source's artifacts since the run was created.
      const unavailable = docs.flatMap((doc) => {
        const reason = !doc.reused_from_document_id || !doc.source_id || !doc.source_run_id
          ? "has no source document to reuse them from"
          : doc.source_purged
            ? `reuses ${doc.source_id}, whose derived data was purged`
            : doc.source_artifacts_purged
              ? `reuses ${doc.source_id}, whose run artifacts were purged by retention`
              : null;
        return reason ? [{ documentId: doc.id, reason }] : [];
      });
      if (unavailable.length > 0) return { seededDocuments: 0, unavailable };

      const reused = [...reusedStages];
      for (const doc of docs) {
        const sourceId = doc.source_id!;
        const prefix = `${sourceId}:`;
        // Existing keys win: a retried start must not overwrite artifacts a
        // stage of this run already wrote.
        await client`
          update workspace_runs target
          set artifacts = coalesce((
                select jsonb_object_agg(${`${doc.id}:`}::text || substr(artifact.key, ${prefix.length + 1}), artifact.value)
                from workspace_runs source
                cross join lateral jsonb_each(coalesce(source.artifacts, '{}'::jsonb)) as artifact(key, value)
                where source.id = ${doc.source_run_id} and left(artifact.key, ${prefix.length}) = ${prefix}
              ), '{}'::jsonb) || coalesce(target.artifacts, '{}'::jsonb),
              updated_at = now()
          where target.id = ${runId}
        `;
        await client`
          insert into document_run_stage_states (
            run_id, document_id, stage_name, status, attempts, artifact_uri, stats, error,
            started_at, completed_at, updated_at
          )
          select ${runId}, ${doc.id}, states.stage_name, 'completed', greatest(states.attempts, 1),
            states.artifact_uri,
            coalesce(states.stats, '{}'::jsonb) || jsonb_build_object(
              'reused', true,
              'reusedFromDocumentId', ${sourceId}::text,
              'reusedFromRunId', ${doc.source_run_id}::text
            ),
            null, now(), now(), now()
          from document_run_stage_states states
          where states.document_id = ${sourceId}
            and states.status = 'completed'
            and states.stage_name = any(${reused})
          on conflict (run_id, document_id, stage_name) do nothing
        `;
        if (reused.includes("page-index")) {
          await client`
            insert into document_pages (id, document_id, run_id, user_id, page_number, text, token_estimate)
            select gen_random_uuid()::text, ${doc.id}, ${runId}, pages.user_id, pages.page_number, pages.text, pages.token_estimate
            from document_pages pages
            where pages.document_id = ${sourceId}
              and not exists (select 1 from document_pages existing where existing.document_id = ${doc.id})
          `;
        }
        if (reused.includes("embed")) {
          await client`
            insert into document_chunks (
              id, document_id, run_id, user_id, chunk_index, text, heading_path, page_number,
              token_estimate, metadata, content_hash, pipeline_version, parent_page_id
            )
            select gen_random_uuid()::text, ${doc.id}, ${runId}, chunks.user_id, chunks.chunk_index, chunks.text,
              chunks.heading_path, chunks.page_number, chunks.token_estimate, chunks.metadata,
              chunks.content_hash, chunks.pipeline_version, target_pages.id
            from document_chunks chunks
            left join document_pages source_pages on source_pages.id = chunks.parent_page_id
            left join document_pages target_pages
              on target_pages.document_id = ${doc.id} and target_pages.page_number = source_pages.page_number
            where chunks.document_id = ${sourceId}
              and not exists (select 1 from document_chunks existing where existing.document_id = ${doc.id})
          `;
          await client`
            update documents set lexical_searchable_at = coalesce(lexical_searchable_at, now())
            where id = ${doc.id} and exists (select 1 from document_chunks c where c.document_id = ${doc.id})
          `;
        }
        if (reused.includes("document-summary")) {
          await client`
            insert into document_summaries (id, document_id, run_id, user_id, summary)
            select gen_random_uuid()::text, ${doc.id}, ${runId}, summaries.user_id, summaries.summary
            from document_summaries summaries
            where summaries.document_id = ${sourceId}
              and not exists (select 1 from document_summaries existing where existing.document_id = ${doc.id})
          `;
        }
        if (reused.includes("proposition-index")) {
          await client`
            insert into document_propositions (
              id, document_id, run_id, user_id, chunk_index, text, source_paragraph, token_estimate
            )
            select gen_random_uuid()::text, ${doc.id}, ${runId}, props.user_id, props.chunk_index, props.text,
              props.source_paragraph, props.token_estimate
            from document_propositions props
            where props.document_id = ${sourceId}
              and not exists (select 1 from document_propositions existing where existing.document_id = ${doc.id})
          `;
        }
      }
      return { seededDocuments: docs.length, unavailable: [] };
    });
  }

  /** Records blocked hosted AI attempts for strict-privacy workspaces. */
  async recordPrivacyAudit(entries: readonly PrivacyAuditEntry[]): Promise<void> {
    await insertPrivacyAuditRows(this.sql, entries);
  }

  /** Read graph evidence from current document rows, never reused artifact identities. */
  async loadDocumentGraphChunks(workspaceId: string, documentId: string) {
    const rows = await this.sql<{ id: string; text: string; page_number: number | null }[]>`
      select c.id, c.text, c.page_number
      from document_chunks c join documents d on d.id = c.document_id
      where c.document_id = ${documentId} and d.workspace_id = ${workspaceId}
      order by c.chunk_index
    `;
    return rows.map((row) => ({ id: row.id, text: row.text, pageNumber: row.page_number }));
  }

  async replaceDocumentGraph(input: ReplaceDocumentGraphInput): Promise<{ nodes: number; edges: number }> {
    return await replaceDocumentGraph(this.sql, input);
  }

  /** Documents whose graph was already extracted with this config (a re-run skips them). */
  async documentsWithGraph(workspaceId: string, configHash: string, documentIds: readonly string[]): Promise<Set<string>> {
    if (documentIds.length === 0) return new Set();
    const rows = await this.sql<{ document_id: string }[]>`
      select document_id from kg_document_state
      where workspace_id = ${workspaceId} and config_hash = ${configHash}
        and document_id = any(${this.sql.array([...documentIds])})
    `;
    return new Set(rows.map((row) => row.document_id));
  }

  async refreshWorkspaceCommunities(args: {
    workspaceId: string;
    userId: string;
    runId: string | null;
    context: CommunitySummaryContext;
  }): Promise<CommunityRefreshResult> {
    return await refreshWorkspaceCommunities({ sql: this.sql, ...args });
  }

  async workspaceGraphScope(workspaceId: string): Promise<string> {
    const [workspace] = await this.sql<{ name: string; template_key: string | null }[]>`
      select name, template_key from workspaces where id = ${workspaceId}
    `;
    if (!workspace) return "Workspace";
    return graphFallbackScope({
      name: workspace.name,
      templateDescription: workspaceTemplates.find((template) => template.key === workspace.template_key)?.description,
    });
  }

  /** Claims and runs queued workspace graph rebuilds (see graph/rebuild-job.ts). */
  async runGraphJobs(options: GraphJobRunnerOptions): Promise<number> {
    return await runGraphJobs(this.sql, options);
  }

  /**
   * Native search's cached eligible sets (server search/eligible-documents.ts,
   * channel `search_eligibility`) drop these workspaces now instead of after
   * their TTL: they serve LanceDB rows without re-reading Postgres.
   */
  private async notifySearchEligibilityChanged(workspaceIds: ReadonlyArray<string | null | undefined>): Promise<void> {
    const ids = [...new Set(workspaceIds.filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return;
    await this.sql`select pg_notify('search_eligibility', ${JSON.stringify({ workspaceIds: ids })})`;
  }

  /**
   * Remove the graph evidence of a run's documents (chunk mentions, edge
   * evidence and extraction state) before retention drops their chunks or the
   * run itself, then re-derive the touched nodes and edges. Facts that other
   * documents still support survive with recomputed weights and counts;
   * workspace communities are recounted rather than deleted.
   */
  private async removeRunGraphContributions(workspaceId: string, runId: string): Promise<void> {
    if (!(await this.tableExists("kg_nodes"))) return;
    await this.sql.begin(async (tx) => {
      const client = tx as unknown as Sql<Record<string, unknown>>;
      await lockWorkspaceGraph(client, workspaceId);
      const affected = await client<{ node_id: string }[]>`
        select ce.node_id from chunk_entities ce
        where ce.workspace_id = ${workspaceId} and ce.run_id = ${runId}
        union
        select ce.node_id from chunk_entities ce
        join document_chunks c on c.id = ce.chunk_id
        join documents d on d.id = c.document_id
        where d.run_id = ${runId}
        union
        select e.source_node_id from kg_edge_evidence ev
        join kg_edges e on e.id = ev.edge_id
        join documents d on d.id = ev.document_id
        where d.run_id = ${runId}
        union
        select e.target_node_id from kg_edge_evidence ev
        join kg_edges e on e.id = ev.edge_id
        join documents d on d.id = ev.document_id
        where d.run_id = ${runId}
      `;
      await client`
        delete from chunk_entities
        where (workspace_id = ${workspaceId} and run_id = ${runId})
          or chunk_id in (
            select c.id from document_chunks c join documents d on d.id = c.document_id where d.run_id = ${runId}
          )
      `;
      await client`
        delete from kg_edge_evidence where document_id in (select id from documents where run_id = ${runId})
      `;
      await client`
        delete from kg_document_state where document_id in (select id from documents where run_id = ${runId})
      `;
      await refreshKnowledgeGraphNodes(client, affected.map((row) => row.node_id));
    });
  }

  private toJson(value: unknown) {
    return this.sql.json(JSON.parse(JSON.stringify(value ?? {})) as JSONValue);
  }

  private toJsonText(value: unknown) {
    return JSON.stringify(JSON.parse(JSON.stringify(value ?? {})));
  }

  /** Whether the app has enforced billing (Stripe configured); false before migration 0026. */
  async loadMeteringEnforced(): Promise<boolean> {
    if (!(await this.tableExists("billing_runtime"))) return false;
    const [row] = await this.sql<{ metering_enforced: boolean }[]>`
      select metering_enforced from billing_runtime where id = true limit 1
    `;
    return row?.metering_enforced ?? false;
  }

  private async tableExists(tableName: string): Promise<boolean> {
    const cached = this.tableExistenceCache.get(tableName);
    if (cached !== undefined) {
      return cached;
    }

    const rows = await this.sql.unsafe<Array<{ exists: boolean }>>(
      "select to_regclass($1) is not null as exists",
      [tableName],
    );
    const exists = rows[0]?.exists ?? false;
    this.tableExistenceCache.set(tableName, exists);
    return exists;
  }

  private async loadStorageIntegrityReferences(
    bucket: string,
  ): Promise<StorageReference[]> {
    const rows = await this.sql.unsafe<StorageReferenceRow[]>(
      `
      select
        'document-source' as reference_kind,
        d.source_key as reference_key,
        d.run_id,
        d.id as document_id,
        d.workspace_id,
        d.org_id,
        d.user_id,
        d.filename as reference_source
      from documents d
      union all
      select
        'run-artifact' as reference_kind,
        artifact.value as reference_key,
        r.id as run_id,
        null::text as document_id,
        r.workspace_id,
        r.org_id,
        r.user_id,
        artifact.key as reference_source
      from workspace_runs r
      join lateral jsonb_each_text(coalesce(r.artifacts, '{}'::jsonb)) as artifact(key, value) on true
      union all
      select
        'stage-artifact' as reference_kind,
        states.artifact_uri as reference_key,
        states.run_id,
        states.document_id,
        runs.workspace_id,
        runs.org_id,
        runs.user_id,
        states.stage_name as reference_source
      from (
        select run_id, null::text as document_id, stage_name, artifact_uri
        from workspace_run_stage_states
        where artifact_uri is not null
        union all
        select run_id, document_id, stage_name, artifact_uri
        from document_run_stage_states
        where artifact_uri is not null
      ) states
      join workspace_runs runs on runs.id = states.run_id
      union all
      select
        'vector-index' as reference_kind,
        case when vi.bucket = $1 then vi.path else null end as reference_key,
        d.run_id,
        d.id as document_id,
        d.workspace_id,
        d.org_id,
        d.user_id,
        vi.embedding_model as reference_source
      from vector_indexes vi
      join documents d on d.id = vi.document_id
      `,
      [bucket],
    );

    return rows
      .map((row) => ({
        kind: row.reference_kind,
        key: keyFromStorageUri(row.reference_key ?? "", bucket),
        runId: row.run_id,
        documentId: row.document_id,
        workspaceId: row.workspace_id,
        orgId: row.org_id,
        userId: row.user_id,
        source: row.reference_source,
      }))
      .filter((row): row is StorageReference => Boolean(row.key));
  }

  private async loadStorageIntegrityRunChecks(): Promise<
    StorageIntegrityRunCheck[]
  > {
    const runs = await this.sql<StorageIntegrityRunRow[]>`
      select
        id as run_id,
        user_id,
        org_id,
        workspace_id,
        status,
        pipeline
      from workspace_runs
      where status in ('completed', 'failed')
    `;

    const documentCounts = new Map<string, number>(
      (
        await this.sql<CountByRunRow[]>`
        select run_id, count(*)::int as count
        from documents
        where run_id is not null
        group by run_id
      `
      ).map((row) => [row.run_id, row.count]),
    );
    const chunkCounts = new Map<string, number>(
      (
        await this.sql<CountByRunRow[]>`
        select run_id, count(*)::int as count
        from document_chunks
        group by run_id
      `
      ).map((row) => [row.run_id, row.count]),
    );
    const vectorIndexCounts = new Map<string, number>(
      (
        await this.sql<CountByRunRow[]>`
        select d.run_id, count(distinct vi.document_id)::int as count
        from vector_indexes vi
        join documents d on d.id = vi.document_id
        where d.run_id is not null
        group by d.run_id
      `
      ).map((row) => [row.run_id, row.count]),
    );
    const summaryCounts = new Map<string, number>(
      (
        await this.sql<CountByRunRow[]>`
        select run_id, count(*)::int as count
        from document_summaries
        group by run_id
      `
      ).map((row) => [row.run_id, row.count]),
    );

    const propositionCounts = (await this.tableExists("document_propositions"))
      ? new Map<string, number>(
          (
            await this.sql<CountByRunRow[]>`
            select run_id, count(*)::int as count
            from document_propositions
            group by run_id
          `
          ).map((row) => [row.run_id, row.count]),
        )
      : new Map<string, number>();
    const graphNodeCounts = (await this.tableExists("kg_nodes"))
      ? new Map<string, number>(
          (
            await this.sql<CountByRunRow[]>`
            select run_id, count(*)::int as count
            from kg_nodes
            group by run_id
          `
          ).map((row) => [row.run_id, row.count]),
        )
      : new Map<string, number>();
    const graphEdgeCounts = (await this.tableExists("kg_edges"))
      ? new Map<string, number>(
          (
            await this.sql<CountByRunRow[]>`
            select run_id, count(*)::int as count
            from kg_edges
            group by run_id
          `
          ).map((row) => [row.run_id, row.count]),
        )
      : new Map<string, number>();
    const chunkEntityCounts = (await this.tableExists("chunk_entities"))
      ? new Map<string, number>(
          (
            await this.sql<CountByRunRow[]>`
            select run_id, count(*)::int as count
            from chunk_entities
            group by run_id
          `
          ).map((row) => [row.run_id, row.count]),
        )
      : new Map<string, number>();
    const communityCounts = (await this.tableExists("kg_communities"))
      ? new Map<string, number>(
          (
            await this.sql<CountByRunRow[]>`
            select run_id, count(*)::int as count
            from kg_communities
            group by run_id
          `
          ).map((row) => [row.run_id, row.count]),
        )
      : new Map<string, number>();

    return runs.map((run) => ({
      runId: run.run_id,
      userId: run.user_id,
      orgId: run.org_id,
      workspaceId: run.workspace_id,
      status: run.status,
      pipeline: run.pipeline,
      documentCount: documentCounts.get(run.run_id) ?? 0,
      chunkCount: chunkCounts.get(run.run_id) ?? 0,
      vectorIndexCount: vectorIndexCounts.get(run.run_id) ?? 0,
      summaryCount: summaryCounts.get(run.run_id) ?? 0,
      propositionCount: propositionCounts.get(run.run_id) ?? 0,
      graphNodeCount: graphNodeCounts.get(run.run_id) ?? 0,
      graphEdgeCount: graphEdgeCounts.get(run.run_id) ?? 0,
      chunkEntityCount: chunkEntityCounts.get(run.run_id) ?? 0,
      communityCount: communityCounts.get(run.run_id) ?? 0,
    }));
  }

  private async purgeExpiredArtifacts(
    storage: ArtifactStore,
    batchSize: number,
  ): Promise<void> {
    const rows = await this.sql.unsafe<ArtifactRetentionRow[]>(
      `
      select
        r.id as run_id,
        r.user_id,
        r.org_id,
        r.workspace_id,
        w.name as workspace_name,
        array_remove(array_agg(distinct d.source_key), null) as source_keys,
        array_remove(
          array_agg(distinct artifact_value.value) filter (where artifact_value.value is not null),
          null
        ) as run_artifact_uris,
        array_remove(
          array_agg(distinct stage_uri.value) filter (where stage_uri.value is not null),
          null
        ) as stage_artifact_uris
      from workspace_runs r
      join workspaces w on w.id = r.workspace_id
      left join documents d on d.run_id = r.id
      left join lateral jsonb_each_text(coalesce(r.artifacts, '{}'::jsonb)) as artifact_value(key, value) on true
      left join lateral (
        select wrss.artifact_uri as value
        from workspace_run_stage_states wrss
        where wrss.run_id = r.id
        union all
        select drss.artifact_uri as value
        from document_run_stage_states drss
        where drss.run_id = r.id
      ) as stage_uri on true
      where w.artifact_retention_days is not null
        and r.status in ('completed', 'failed')
        and r.artifacts_purged_at is null
        and r.created_at < now() - make_interval(days => w.artifact_retention_days)
        -- A partial reprocess still seeding from or running on this run's
        -- documents reads their artifacts; purge once it reaches a terminal state.
        and not exists (
          select 1
          from documents source
          join documents reusing on reusing.reused_from_document_id = source.id
          join workspace_runs reusing_run on reusing_run.id = reusing.run_id
          where source.run_id = r.id
            and reusing_run.status not in ('completed', 'failed')
        )
      group by r.id, r.user_id, r.org_id, r.workspace_id, w.name
      order by r.created_at asc
      limit $1
      `,
      [Math.max(1, batchSize)],
    );

    for (const row of rows) {
      const keys = new Set<string>();

      for (const sourceKey of row.source_keys ?? []) {
        const normalized = keyFromStorageUri(sourceKey, storage.bucket);
        if (normalized) {
          keys.add(normalized);
        }
      }

      for (const uri of [
        ...(row.run_artifact_uris ?? []),
        ...(row.stage_artifact_uris ?? []),
      ]) {
        const normalized = keyFromStorageUri(uri, storage.bucket);
        if (normalized) {
          keys.add(normalized);
        }
      }

      // Embedding reuse pointers into this run's embedding artifacts go with them.
      const artifactUris = [...(row.run_artifact_uris ?? []), ...(row.stage_artifact_uris ?? [])];
      if (artifactUris.length > 0 && (await this.tableExists("embedding_reuse_refs"))) {
        await this.sql`delete from embedding_reuse_refs where artifact_uri = any(${this.sql.array(artifactUris)}::text[])`;
      }
      await storage.deleteKeys([...keys]);

      if (await this.tableExists("document_propositions")) {
        await this.sql`
          delete from document_propositions
          where run_id = ${row.run_id}
        `;
      }
      await this.removeRunGraphContributions(row.workspace_id, row.run_id);
      if (await this.tableExists("document_summaries")) {
        await this.sql`
          delete from document_summaries
          where run_id = ${row.run_id}
        `;
      }
      if (await this.tableExists("document_chunks")) {
        await this.sql`
          delete from document_chunks
          where run_id = ${row.run_id}
        `;
      }
      if (await this.tableExists("document_pages")) {
        await this.sql`
          delete from document_pages
          where run_id = ${row.run_id}
        `;
      }
      if (await this.tableExists("vector_indexes")) {
        // The documents stay, but their LanceDB rows must go too: hand the
        // vector targets to the cleanup sweep before the index rows vanish.
        await this.sql`
          insert into document_cleanup_queue (
            document_id, org_id, user_id, workspace_id, run_id, source_key, delete_source, vector_targets
          )
          select d.id, coalesce(d.org_id, ${row.org_id ?? ""}), d.user_id, d.workspace_id, d.run_id, d.source_key, false,
            jsonb_agg(distinct jsonb_build_object(
              'backend', vi.backend, 'embeddingModel', vi.embedding_model, 'dimension', vi.dimension))
          from documents d
          join vector_indexes vi on vi.document_id = d.id
          where d.run_id = ${row.run_id}
          group by d.id
          on conflict (document_id) do nothing
        `;
        await this.sql`
          delete from vector_indexes
          where document_id in (
            select id
            from documents
            where run_id = ${row.run_id}
          )
        `;
      }
      await this.sql`
        update workspace_runs
        set
          artifacts_purged_at = now(),
          updated_at = now()
        where id = ${row.run_id}
      `;
      await this.notifySearchEligibilityChanged([row.workspace_id]);

      await this.appendAuditLog({
        orgId: row.org_id,
        userId: row.user_id,
        workspaceId: row.workspace_id,
        runId: row.run_id,
        action: "retention.artifacts_purged",
        resourceType: "workspace_run",
        resourceId: row.run_id,
        metadata: {
          workspaceName: row.workspace_name,
          deletedObjectCount: keys.size,
        },
      });
    }
  }

  private async deleteExpiredRuns(batchSize: number): Promise<void> {
    const rows = await this.sql.unsafe<RunRetentionRow[]>(
      `
      select
        r.id as run_id,
        r.user_id,
        r.org_id,
        r.workspace_id,
        w.name as workspace_name
      from workspace_runs r
      join workspaces w on w.id = r.workspace_id
      where w.run_retention_days is not null
        and r.status in ('completed', 'failed')
        and r.created_at < now() - make_interval(days => w.run_retention_days)
        -- As for artifact retention: a partial reprocess still seeding from or
        -- running on this run's documents needs them; delete once it is terminal.
        and not exists (
          select 1
          from documents source
          join documents reusing on reusing.reused_from_document_id = source.id
          join workspace_runs reusing_run on reusing_run.id = reusing.run_id
          where source.run_id = r.id
            and reusing_run.status not in ('completed', 'failed')
        )
      order by r.created_at asc
      limit $1
      `,
      [Math.max(1, batchSize)],
    );

    for (const row of rows) {
      await this.appendAuditLog({
        orgId: row.org_id,
        userId: row.user_id,
        workspaceId: row.workspace_id,
        runId: row.run_id,
        action: "retention.run_deleted",
        resourceType: "workspace_run",
        resourceId: row.run_id,
        metadata: {
          workspaceName: row.workspace_name,
        },
      });

      // A deleted run takes its documents and artifacts with it, whether or
      // not artifact retention already purged them. The documents and
      // workspace_runs BEFORE DELETE triggers enqueue LanceDB, raw-source and
      // run-prefix cleanup for the worker sweep (docs/data-deletion.md).
      await this.removeRunGraphContributions(row.workspace_id, row.run_id);
      await this.sql.begin(async (tx) => {
        const client = tx as unknown as Sql<Record<string, unknown>>;
        // Newer versions in other runs keep a valid (null) predecessor link.
        await client`
          update documents set previous_version_id = null
          where previous_version_id in (select id from documents where run_id = ${row.run_id})
            and run_id is distinct from ${row.run_id}
        `;
        await client`delete from documents where run_id = ${row.run_id}`;
        await client`delete from workspace_runs where id = ${row.run_id}`;
      });
      await this.notifySearchEligibilityChanged([row.workspace_id]);
    }
  }

  private async processWorkspaceBudgetAlerts(): Promise<void> {
    const rows = await this.sql.unsafe<BudgetAlertRow[]>(
      `
      select
        w.id as scope_id,
        w.name as scope_name,
        w.org_id,
        w.id as workspace_id,
        w.user_id as owner_user_id,
        u.email as owner_email,
        w.monthly_budget_cents,
        w.budget_alert_threshold_percent,
        w.budget_alert_level,
        w.budget_paused,
        -- floor, not the cast's rounding: 99.5 cents must not trip a 100-cent cap (the live check compares exactly).
        floor(coalesce(spend.cost_cents, 0))::integer as spend_cents,
        np.cost_alert
      from workspaces w
      join "user" u on u.id = w.user_id
      left join notification_prefs np on np.user_id = w.user_id
      -- The shared attribution rule (usage_attribution view, migration 0042).
      left join (
        select au.workspace_id, sum(au.cost_cents)::double precision as cost_cents
        from usage_attribution au
        where au.created_at >= date_trunc('month', now())
          and au.workspace_id in (
            select id from workspaces where monthly_budget_cents is not null and monthly_budget_cents > 0
          )
        group by au.workspace_id
      ) spend on spend.workspace_id = w.id
      where w.monthly_budget_cents is not null
        and w.monthly_budget_cents > 0
      group by
        w.id,
        w.name,
        w.org_id,
        w.user_id,
        u.email,
        w.monthly_budget_cents,
        w.budget_alert_threshold_percent,
        w.budget_alert_level,
        w.budget_paused,
        spend.cost_cents,
        np.cost_alert
      `,
    );

    for (const row of rows) {
      const nextLevel = resolveBudgetAlertLevel(
        row.spend_cents,
        row.monthly_budget_cents,
        row.budget_alert_threshold_percent,
      );
      // A budget change resets budget_paused but not the level, so compare both.
      if (nextLevel === row.budget_alert_level && row.budget_paused === nextLevel >= 100) {
        continue;
      }

      await this.sql`
        update workspaces
        set
          budget_alert_level = ${nextLevel},
          budget_paused = ${nextLevel >= 100},
          budget_alert_updated_at = case when ${nextLevel} > 0 then now() else null end,
          updated_at = now()
        where id = ${row.scope_id}
      `;

      if (nextLevel > row.budget_alert_level && row.cost_alert !== false) {
        await this.sendBudgetAlertEmail({
          scope: "workspace",
          scopeId: row.scope_id,
          scopeName: row.scope_name,
          orgId: row.org_id,
          workspaceId: row.workspace_id,
          userId: row.owner_user_id,
          recipient: row.owner_email,
          spendCents: row.spend_cents,
          budgetCents: row.monthly_budget_cents,
          alertLevel: nextLevel,
          thresholdPercent: row.budget_alert_threshold_percent,
        });
      }
    }
  }

  private async processOrganizationBudgetAlerts(): Promise<void> {
    const rows = await this.sql.unsafe<BudgetAlertRow[]>(
      `
      select
        o.id as scope_id,
        o.name as scope_name,
        o.id as org_id,
        null::text as workspace_id,
        o.created_by_user_id as owner_user_id,
        u.email as owner_email,
        o.monthly_budget_cents,
        o.budget_alert_threshold_percent,
        o.budget_alert_level,
        o.budget_paused,
        floor(coalesce(spend.cost_cents, 0))::integer as spend_cents,
        np.cost_alert
      from organizations o
      join "user" u on u.id = o.created_by_user_id
      left join notification_prefs np on np.user_id = o.created_by_user_id
      -- The shared attribution rule (usage_attribution view, migration 0042):
      -- includes run-less search and chat spend whose writer stamped no org.
      left join (
        select au.org_id, sum(au.cost_cents)::double precision as cost_cents
        from usage_attribution au
        where au.created_at >= date_trunc('month', now())
        group by au.org_id
      ) spend on spend.org_id = o.id
      where o.monthly_budget_cents is not null
        and o.monthly_budget_cents > 0
      group by
        o.id,
        o.name,
        o.created_by_user_id,
        u.email,
        o.monthly_budget_cents,
        o.budget_alert_threshold_percent,
        o.budget_alert_level,
        o.budget_paused,
        spend.cost_cents,
        np.cost_alert
      `,
    );

    for (const row of rows) {
      const nextLevel = resolveBudgetAlertLevel(
        row.spend_cents,
        row.monthly_budget_cents,
        row.budget_alert_threshold_percent,
      );
      // A budget change resets budget_paused but not the level, so compare both.
      if (nextLevel === row.budget_alert_level && row.budget_paused === nextLevel >= 100) {
        continue;
      }

      await this.sql`
        update organizations
        set
          budget_alert_level = ${nextLevel},
          budget_paused = ${nextLevel >= 100},
          budget_alert_updated_at = case when ${nextLevel} > 0 then now() else null end,
          updated_at = now()
        where id = ${row.scope_id}
      `;

      if (nextLevel > row.budget_alert_level && row.cost_alert !== false) {
        await this.sendBudgetAlertEmail({
          scope: "organization",
          scopeId: row.scope_id,
          scopeName: row.scope_name,
          orgId: row.org_id,
          workspaceId: null,
          userId: row.owner_user_id,
          recipient: row.owner_email,
          spendCents: row.spend_cents,
          budgetCents: row.monthly_budget_cents,
          alertLevel: nextLevel,
          thresholdPercent: row.budget_alert_threshold_percent,
        });
      }
    }
  }

  private async sendBudgetAlertEmail(args: {
    scope: "workspace" | "organization";
    scopeId: string;
    scopeName: string;
    orgId: string | null;
    workspaceId: string | null;
    userId: string;
    recipient: string;
    spendCents: number;
    budgetCents: number;
    alertLevel: number;
    thresholdPercent: number;
  }): Promise<void> {
    const exceeded = args.alertLevel >= 100;
    const subject = exceeded
      ? `Budget exceeded: ${args.scopeName}`
      : `Budget alert: ${args.scopeName}`;
    const remainingCents = Math.max(args.budgetCents - args.spendCents, 0);
    const lines = [
      `${args.scope === "workspace" ? "Workspace" : "Organization"}: ${args.scopeName}`,
      `Scope ID: ${args.scopeId}`,
      `Spend this month: ${formatCurrency(args.spendCents)}`,
      `Budget this month: ${formatCurrency(args.budgetCents)}`,
      `Remaining budget: ${formatCurrency(remainingCents)}`,
      exceeded
        ? "Status: new runs are blocked until spend drops below the monthly cap."
        : `Status: monthly spend crossed ${args.thresholdPercent}% of budget.`,
    ];

    await this.deliverNotificationEmail({
      deliveryId: randomUUID(),
      userId: args.userId,
      orgId: args.orgId,
      workspaceId: args.workspaceId,
      event: "cost.alert",
      recipient: args.recipient,
      subject,
      text: lines.join("\n"),
      html: `<p>${lines.map((line) => escapeHtml(line)).join("<br />")}</p>`,
      metadata: {
        scope: args.scope,
        scopeId: args.scopeId,
        spendCents: args.spendCents,
        budgetCents: args.budgetCents,
        alertLevel: args.alertLevel,
        thresholdPercent: args.thresholdPercent,
      },
    });
  }

  private async deliverNotificationEmail(args: {
    deliveryId: string;
    userId: string;
    orgId?: string | null;
    workspaceId?: string | null;
    runId?: string | null;
    documentId?: string | null;
    event:
      | "run.completed"
      | "run.failed"
      | "plausibility.warning"
      | "cost.alert"
      | "workspace.invite";
    recipient: string;
    subject: string;
    text: string;
    html: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const resendApiKey = process.env.RESEND_API_KEY;
    let delivered = true;
    let provider = "console";
    let responseText: string | null = null;

    if (!resendApiKey) {
      console.log(
        `[notification] provider=console delivery=${args.deliveryId} event=${args.event} to=${args.recipient} subject=${JSON.stringify(args.subject)}`,
      );
    } else {
      provider = "resend";
      const response = await instrumentFetch("resend", "email")("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: process.env.EMAIL_FROM ?? "DocSlurp <noreply@docslurp.local>",
          to: [args.recipient],
          reply_to: process.env.EMAIL_REPLY_TO
            ? [process.env.EMAIL_REPLY_TO]
            : undefined,
          subject: args.subject,
          text: args.text,
          html: args.html,
        }),
      });
      delivered = response.ok;
      responseText = await response.text().catch(() => null);
      if (!response.ok) {
        console.error(
          `notification delivery failed for ${args.event} ${args.deliveryId}: ${responseText ?? response.statusText}`,
        );
      }
    }

    await this.sql`
      insert into notification_deliveries (
        id,
        user_id,
        org_id,
        workspace_id,
        event_type,
        provider,
        recipient,
        subject,
        delivered,
        metadata,
        created_at
      )
      values (
        ${args.deliveryId},
        ${args.userId},
        ${args.orgId ?? null},
        ${args.workspaceId ?? null},
        ${args.event},
        ${provider},
        ${args.recipient},
        ${args.subject},
        ${delivered},
        ${this.toJson({
          ...(args.metadata ?? {}),
          runId: args.runId ?? null,
          documentId: args.documentId ?? null,
          response: responseText,
        })}::jsonb,
        now()
      )
    `;

    await this.appendAuditLog({
      orgId: args.orgId ?? null,
      userId: args.userId,
      workspaceId: args.workspaceId ?? null,
      runId: args.runId ?? null,
      documentId: args.documentId ?? null,
      action: delivered ? "notification.sent" : "notification.failed",
      resourceType: "notification",
      resourceId: args.deliveryId,
      metadata: {
        event: args.event,
        provider,
        recipient: args.recipient,
        subject: args.subject,
        ...(args.metadata ?? {}),
        response: responseText,
      },
    });

    if (!delivered) {
      throw new Error(
        `email delivery failed: ${responseText ?? "unknown error"}`,
      );
    }
  }

  private async appendAuditLog(args: {
    orgId?: string | null;
    userId?: string | null;
    workspaceId?: string | null;
    runId?: string | null;
    documentId?: string | null;
    action: string;
    resourceType: string;
    resourceId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.sql`
      insert into audit_log (
        id,
        org_id,
        user_id,
        workspace_id,
        run_id,
        document_id,
        action,
        resource_type,
        resource_id,
        metadata,
        created_at
      )
      values (
        gen_random_uuid()::text,
        ${args.orgId ?? null},
        ${args.userId ?? null},
        ${args.workspaceId ?? null},
        ${args.runId ?? null},
        ${args.documentId ?? null},
        ${args.action},
        ${args.resourceType},
        ${args.resourceId ?? null},
        ${this.toJson(args.metadata ?? {})}::jsonb,
        now()
      )
    `;
  }
}

function mapRun(row: WorkspaceRunRow): WorkspaceRun {
  return {
    id: row.id,
    orgId: row.org_id ?? null,
    ...(row.org_funded !== undefined && row.org_funded !== null ? { orgFunded: row.org_funded } : {}),
    ...(row.org_allow_china_providers === false ? { orgAllowChinaProviders: false } : {}),
    userId: row.user_id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    status: row.status,
    stage: row.stage,
    totalDocuments: row.total_documents,
    processedDocuments: row.processed_documents,
    pagesTotal: row.pages_total,
    pagesProcessed: row.pages_processed,
    spentCents: Number(row.spent_cents ?? 0) || 0,
    // DOCSLURP_VISION_MODEL_URI replaces the built-in default vision model at run time, never in stored settings.
    pipeline: applyDefaultVisionOverride(mergePipelineFeatures(row.pipeline ?? defaultPipelineFeatures)),
    error: row.error,
    stats: row.stats ?? {},
    artifacts: row.artifacts ?? {},
    claimId: row.run_id,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    ...(row.storage_prefix ? { storagePrefix: row.storage_prefix, extractId: row.extract_id ?? null } : {}),
  };
}

export function buildStorageIntegrityReport(args: {
  bucket: string;
  prefix: string | null;
  maxKeys: number;
  references: StorageReference[];
  runChecks: StorageIntegrityRunCheck[];
  listedKeys: string[];
  listedKeysTruncated: boolean;
  nextContinuationToken: string | null;
  checkedKeys: string[];
  existingKeys: Set<string>;
}): StorageIntegrityReport {
  const generatedAt = new Date().toISOString();
  const referencesByKey = new Map<string, StorageReference[]>();

  for (const reference of args.references) {
    if (args.prefix && !reference.key.startsWith(args.prefix)) {
      continue;
    }

    const existing = referencesByKey.get(reference.key) ?? [];
    existing.push(reference);
    referencesByKey.set(reference.key, existing);
  }

  const findings: StorageIntegrityFinding[] = [];
  for (const key of args.checkedKeys) {
    if (args.existingKeys.has(key)) {
      continue;
    }

    const references = referencesByKey.get(key) ?? [];
    const reference = references[0] ?? null;
    findings.push({
      kind: "missing-storage-object",
      severity: "error",
      key,
      runId: reference?.runId ?? null,
      documentId: reference?.documentId ?? null,
      workspaceId: reference?.workspaceId ?? null,
      orgId: reference?.orgId ?? null,
      userId: reference?.userId ?? null,
      referenceKind: reference?.kind ?? null,
      referenceSource: reference?.source ?? null,
      message: `Expected ${reference?.kind ?? "storage"} object is missing from ${args.bucket}.`,
      metadata: {
        bucket: args.bucket,
        referenceCount: references.length,
      },
    });
  }

  const expectedKeySet = new Set(referencesByKey.keys());
  for (const key of collectOrphanedStorageKeys(
    args.listedKeys,
    expectedKeySet,
  )) {
    findings.push({
      kind: "orphaned-storage-object",
      severity: "warning",
      key,
      message: `Storage object is not referenced by documents, run artifacts, stage artifacts, or vector index metadata.`,
      metadata: {
        bucket: args.bucket,
      },
    });
  }

  for (const run of args.runChecks) {
    if (run.status !== "completed" || run.documentCount === 0) {
      continue;
    }

    const pipeline = mergePipelineFeatures(
      run.pipeline ?? defaultPipelineFeatures,
    );
    if ((pipeline.embed || pipeline.indexVectors) && run.chunkCount === 0) {
      findings.push({
        kind: "missing-index-rows",
        severity: "error",
        runId: run.runId,
        workspaceId: run.workspaceId,
        orgId: run.orgId,
        userId: run.userId,
        message:
          "Completed run is missing document chunk rows even though vector indexing was enabled.",
        metadata: {
          documentCount: run.documentCount,
          chunkCount: run.chunkCount,
          vectorIndexCount: run.vectorIndexCount,
        },
      });
    } else if (
      (pipeline.embed || pipeline.indexVectors) &&
      run.vectorIndexCount === 0
    ) {
      findings.push({
        kind: "missing-vector-index-metadata",
        severity: "warning",
        runId: run.runId,
        workspaceId: run.workspaceId,
        orgId: run.orgId,
        userId: run.userId,
        message:
          "Completed run has chunk rows but no vector index metadata records.",
        metadata: {
          documentCount: run.documentCount,
          chunkCount: run.chunkCount,
          vectorIndexCount: run.vectorIndexCount,
        },
      });
    }

    if (pipeline.summarize && run.summaryCount === 0) {
      findings.push({
        kind: "missing-summary-rows",
        severity: "warning",
        runId: run.runId,
        workspaceId: run.workspaceId,
        orgId: run.orgId,
        userId: run.userId,
        message:
          "Completed run enabled summaries but no document summary rows were found.",
        metadata: {
          documentCount: run.documentCount,
          summaryCount: run.summaryCount,
        },
      });
    }

    if (pipeline.propositionIndex && run.propositionCount === 0) {
      findings.push({
        kind: "missing-proposition-rows",
        severity: "warning",
        runId: run.runId,
        workspaceId: run.workspaceId,
        orgId: run.orgId,
        userId: run.userId,
        message:
          "Completed run enabled proposition indexing but no proposition rows were found.",
        metadata: {
          documentCount: run.documentCount,
          propositionCount: run.propositionCount,
        },
      });
    }

    if (
      (pipeline.graphRag ||
        pipeline.entityIndex ||
        pipeline.graphCommunitySummaries) &&
      run.graphNodeCount === 0 &&
      run.graphEdgeCount === 0 &&
      run.chunkEntityCount === 0 &&
      run.communityCount === 0
    ) {
      findings.push({
        kind: "missing-graph-rows",
        severity: "warning",
        runId: run.runId,
        workspaceId: run.workspaceId,
        orgId: run.orgId,
        userId: run.userId,
        message:
          "Completed run enabled graph features but no graph/entity rows were found.",
        metadata: {
          graphNodeCount: run.graphNodeCount,
          graphEdgeCount: run.graphEdgeCount,
          chunkEntityCount: run.chunkEntityCount,
          communityCount: run.communityCount,
        },
      });
    }
  }

  const affectedRuns = new Set(
    findings.map((finding) => finding.runId).filter(Boolean),
  );
  const affectedDocuments = new Set(
    findings.map((finding) => finding.documentId).filter(Boolean),
  );
  const missingObjectCount = findings.filter(
    (finding) => finding.kind === "missing-storage-object",
  ).length;
  const orphanedObjectCount = findings.filter(
    (finding) => finding.kind === "orphaned-storage-object",
  ).length;
  const danglingMetadataCount =
    findings.length - missingObjectCount - orphanedObjectCount;

  return {
    generatedAt,
    reportKey: null,
    reportUri: null,
    sweep: {
      bucket: args.bucket,
      prefix: args.prefix,
      maxKeys: args.maxKeys,
      listedKeys: args.listedKeys.length,
      listedKeysTruncated: args.listedKeysTruncated,
      nextContinuationToken: args.nextContinuationToken,
      expectedReferenceCount: expectedKeySet.size,
      checkedReferenceCount: args.checkedKeys.length,
      checkedReferenceTruncated: expectedKeySet.size > args.checkedKeys.length,
    },
    summary: {
      findingCount: findings.length,
      missingObjectCount,
      orphanedObjectCount,
      danglingMetadataCount,
      affectedRuns: affectedRuns.size,
      affectedDocuments: affectedDocuments.size,
    },
    findings,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatCurrency(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function mapDocument(row: DocumentRow): Document {
  return {
    id: row.id,
    userId: row.user_id,
    runId: row.run_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sourceKey: row.source_key,
    status: row.status,
    extractionMode: row.extraction_mode,
    pageCount: row.page_count,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    ...(row.run_storage_prefix ? { artifactRoot: row.run_storage_prefix } : {}),
  };
}

function mapStageState(row: StageStateRow): StageState {
  return {
    runId: row.run_id,
    documentId: row.document_id ?? undefined,
    stageName: row.stage_name,
    status: row.status,
    attempts: row.attempts,
    artifactUri: row.artifact_uri ?? "",
    stats: row.stats ?? {},
    error: row.error ?? "",
    startedAt: row.started_at ? toDate(row.started_at) : null,
    completedAt: row.completed_at ? toDate(row.completed_at) : null,
    updatedAt: toDate(row.updated_at),
  };
}

function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Groups referenced keys by their run prefix (`<user>/<run>/`, the artifact
 * layout), so each run can be listed once. Keys with fewer segments are left
 * for a HEAD each.
 */
export function groupReferencesByRunPrefix(keys: string[]): { byPrefix: Map<string, string[]>; ungrouped: string[] } {
  const byPrefix = new Map<string, string[]>();
  const ungrouped: string[] = [];
  for (const key of keys) {
    const parts = key.split("/");
    if (parts.length < 3 || !parts[0] || !parts[1]) { ungrouped.push(key); continue; }
    const prefix = `${parts[0]}/${parts[1]}/`;
    const list = byPrefix.get(prefix);
    if (list) list.push(key);
    else byPrefix.set(prefix, [key]);
  }
  return { byPrefix, ungrouped };
}

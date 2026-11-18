import { RUN_MILESTONE_COLUMNS, type RunMilestone, type RunMilestoneHit } from "../pipeline/run-milestones.js";
import { buildRunCompletedEvent } from "../pipeline/run-ledger.js";
import { assertPlanningOwnership, assertExecutionOwnership, type ExecutionOwner, StaleExecutionError } from "./execution-ownership.js";
import { type GeoFinalSource } from "./geo-final-source.js";
import { pipelineTransaction, pipelineInTransaction } from "./transaction-pipeline.js";
import { INFRASTRUCTURE_RETRIES_EXHAUSTED_TEXT } from "@docslurp/shared";
import { DocumentNotFoundError, DocumentOutOfScopeError, isMissingDocumentError } from "./missing-document.js";
import { recordPageBaseFee } from "./page-base-fee.js";
import { randomUUID } from "node:crypto";

import postgres, { type JSONValue, type PendingQuery, type Sql } from "postgres";
import { flushAssetLedger, postgresDocumentAssets, writeDocumentAssetLedger, type DocumentAssets } from "./document-asset-ledger.js";
import { applyDefaultVisionOverride, applyKillSwitchesToPipeline, applyLadderLimits, defaultPipelineFeatures, normalizeStoredPipelineFeatures, PII_BLOCKED_DOCUMENT_STATUS, planRunFailure, type PrivacyAuditEntry } from "@docslurp/shared";

import { adoptBackfillDocuments } from "../deferred/backfill-adoption.js";
import { completingDocumentStamp, runReusesExtraction, runStamp, runStampsIngestVersion, stampDocumentIngestVersion } from "./ingest-version.js";
import { insertPrivacyAuditRows } from "../lib/privacy-guard.js";
import type {
  Document,
  ProjectRun,
  ProjectRunEvent,
  JsonMap,
  StageState,
} from "../models.js";
import type { CheckpointStore, WorkflowState, VectorIndex } from "../pipeline/pipeline.js";
import { insertProjectRunEvents, RunEventPublisher, resolveRunEventPublisherOptions, type RunEventPublisherOptions } from "./run-event-store.js";
import { PostgresPageBasisLedger } from "./page-basis-ledger.js";
import { batchedRows, TableExistence } from "./sql-helpers.js";
import { PostgresDocumentContent } from "./document-content.js";
import { PostgresDocumentRecords } from "./document-records.js";
import { postgresFleetBudgets, type FleetBudgets } from "./fleet-budgets.js";
import { PostgresOcrEscalationReads } from "./ocr-escalation-reads.js";
import { PostgresKnowledgeGraph } from "../graph/knowledge-graph-store.js";
import { RunNotifications, type CanonicalReplacement } from "./run-notifications.js";
import type { PageBasisLedger } from "../pipeline/page-basis.js";
import { enforceRunSpend, spendCounterSql } from "./spend-check.js";
import { retryTransaction } from "./transaction-retry.js";
import { finalizePageExtracts, logFinalizeOutcome, pageExtractStatements } from "../pipeline/page-extracts.js";
import { consumeRunCreditLease, creditLeasesActive, RunCreditLeases, type LeaseObservation } from "./credit-lease.js";
import { bindDocumentUpload, resolveDocumentSource } from "../lib/parse-source.js";
import {
  debitRunUsageCredits,
  persistRunUsageEvents,
  runUsageEventStatements,
} from "./usage-event-store.js";

type ProjectRunRow = {
  id: string;
  execution_generation?: string | null;
  org_id: string;
  /**
   * The run's org, else its project's (runRowQuery): the one org admission, usage attribution and the
   * credit debit all use. Absent from other run queries.
   */
  canonical_org_id?: string | null;
  /** Joined from organizations by loadRun; absent from other run queries. */
  org_funded?: boolean | null;
  allow_china_providers?: boolean | null;
  project_id: string;
  user_id: string;
  kind: string;
  status: string;
  stage: string;
  total_documents: number;
  processed_documents: number;
  pages_total: number;
  pages_processed: number;
  spent_cents: number | string;
  pipeline: Partial<ProjectRun["pipeline"]> | null;
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
  source_sha256?: string | null;
  /** Quarantine's scanned copy of an encrypted PDF (migration 0134, lib/parse-source.ts). */
  parse_source_key?: string | null;
  parse_source_sha256?: string | null;
  /** The quarantine scan version that recorded the parse decision (migration 0134); null or stale: unscanned. */
  parse_source_scan_version?: number | null;
  status: string;
  extraction_mode: string;
  page_count: number;
  billing_pages?: number | null;
  billing_pages_method?: string | null;
  page_count_source?: string | null;
  intake_page_count?: number | null;
  file_facts?: import("@docslurp/shared").FileFacts | null;
  file_size?: string | number | null;
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

const HISTORICAL_PERFORMANCE_TTL_MS = 5 * 60_000;

/** A newer canonical version that took over search from older ones. */

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
  // factor for bonus plans in the usage ledger. A run without an org takes
  // its project's, as the vision attempt guard does (vision-attempt-store.ts),
  // so usage rows, the credit debit and admission agree on one org.
  return client<ProjectRunRow[]>`
    select r.*, c.org_id as canonical_org_id,
      (select o.funded_at is not null from organizations o where o.id = c.org_id) as org_funded,
      -- China-based providers only when the org and the run's project both allow them; no org is restricted.
      coalesce((select o.allow_china_providers from organizations o where o.id = c.org_id), false)
        and coalesce((select w.allow_china_providers from projects w where w.id = r.project_id), false) as allow_china_providers
    from project_runs r
    cross join lateral (
      select coalesce(r.org_id, (select w.org_id from projects w where w.id = r.project_id)) as org_id
    ) c
    where r.id = ${runId}
    limit 1
  `;
}

function runDocumentRowsQuery(client: Sql<Record<string, unknown>>, runId: string) {
  return client<DocumentRow[]>`
    select d.*, (select r.storage_prefix from project_runs r where r.id = d.run_id) as run_storage_prefix
    from documents d
    where d.run_id = ${runId}
      and d.superseded_at is null and d.status <> 'cancelled'
    order by d.created_at asc, d.id asc
  `;
}

function stageStateRowsQuery(client: Sql<Record<string, unknown>>, runId: string) {
  // Run and document checkpoints in one round trip; run rows have no document_id.
  return client<StageStateRows>`
    select 'run' as scope, run_id, null::text as document_id, stage_name, status, attempts, artifact_uri, stats, error,
      started_at, completed_at, updated_at
    from project_run_stage_states
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
export type PreloadedRunState = { run: ProjectRun; documents: Document[]; stageStates: StageStateRows };

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

async function completeRunDocuments(
  client: Sql<Record<string, unknown>>,
  runId: string,
  after: readonly [PendingQuery<any>, PendingQuery<{ run_found: number; changed: number }[]>],
): Promise<{ ids: string[]; finalized: Array<{ run_found: number; changed: number }> }> {
  const [retire, cancel, completed] = completeRunDocumentStatements(client, runId);
  await retire;
  await cancel;
  // Pipelined: sent together, run in order on the transaction's connection.
  completed.execute();
  for (const statement of after) statement.execute();
  const [rows, , finalized] = await Promise.all([completed, after[0], after[1]]);
  return { ids: rows.map((row) => row.id), finalized };
}

/**
 * The run ledger: a run's durable lifecycle in Postgres. It loads and hydrates a run's state, records run and stage
 * transitions and their progress checkpoints (with the usage, artifacts and vector indexes each checkpoint commits), page
 * checkpoints, milestones, sandbox strikes and the run's terminal outcome. It is the CheckpointStore every loaded state is
 * bound to: its own checkpoints plus the ports of the modules stages write through (content, records, assets, graph,
 * budgets, OCR escalation reads, page basis), all over the same pool. The worker process uses it through Store.
 */
export class PostgresRunLedger implements CheckpointStore {
  /** Use inside the transaction that performs init or terminal writes. */
  readonly assertExecutionOwnership = assertExecutionOwnership;
  private readonly plausibilityWarningThreshold: number;
  private readonly poisonRunFailureThreshold: number;
  protected readonly tables: TableExistence;
  /** Tail of each state's checkpoint queue (writeProgress runs one at a time per state). */
  private readonly progressQueues = new WeakMap<WorkflowState, Promise<unknown>>();
  protected readonly runEvents: RunEventPublisher;
  /** Webhook outbox rows and notification deliveries (run-notifications.ts). */
  readonly notifications: RunNotifications;
  /** Pages, chunks, propositions, summaries, page facts and embedding reuse refs (document-content.ts). */
  readonly content: PostgresDocumentContent;
  /** File facts, parse source, title, PII withheld list, geo attempts and document scopes (document-records.ts). */
  readonly records: PostgresDocumentRecords;
  /** Figure rows and host-rendered pages (document-asset-ledger.ts). */
  readonly assets: DocumentAssets;
  /** The project knowledge graph (graph/knowledge-graph-store.ts). */
  readonly graph: PostgresKnowledgeGraph;
  /** Reservations against fleet-wide caps (fleet-budgets.ts). */
  readonly budgets: FleetBudgets;
  /** OCR escalation calls, persisted as they return (ocr-escalation-reads.ts). */
  readonly ocrEscalation: PostgresOcrEscalationReads;
  /** This process's view of run credit leases (credit-lease.ts), shared with page tasks. */
  readonly creditLeases: RunCreditLeases;
  /** The page basis port over this database (db/page-basis-ledger.ts); bindStore gives every hydrated state a PageBasis over it. */
  readonly pageBasisLedger: PageBasisLedger;
  /** Historical stage timings per project/user; a 14-day aggregate does not need a fresh read per stage. */
  private readonly historicalPerformanceCache = new Map<string, { loadedAt: number; value: Record<string, unknown> | null }>();
  // One in-flight load per scope: after a fleet restart every activity misses
  // the cache at once (127 concurrent percentile queries in the 2026-10-09 re-run).
  private readonly historicalPerformanceLoads = new Map<string, Promise<Record<string, unknown> | null>>();

  constructor(
    protected readonly sql: Sql<Record<string, unknown>>,
    private readonly leaseTtlMs: number,
    options?: {
      plausibilityWarningThreshold?: number;
      poisonRunFailureThreshold?: number;
      /** Run event coalescing (run-event-store.ts). */
      runEvents?: RunEventPublisherOptions;
    },
  ) {
    this.pageBasisLedger = new PostgresPageBasisLedger(this.sql);
    this.tables = new TableExistence(this.sql);
    this.content = new PostgresDocumentContent(this.sql);
    this.records = new PostgresDocumentRecords(this.sql);
    this.assets = postgresDocumentAssets(this.sql);
    this.graph = new PostgresKnowledgeGraph(this.sql);
    this.budgets = postgresFleetBudgets(this.sql);
    this.ocrEscalation = new PostgresOcrEscalationReads(this.sql);
    this.plausibilityWarningThreshold =
      options?.plausibilityWarningThreshold ?? 0.3;
    this.notifications = new RunNotifications(this.sql, this.plausibilityWarningThreshold);
    this.runEvents = new RunEventPublisher(this.sql, options?.runEvents ?? resolveRunEventPublisherOptions());
    this.creditLeases = new RunCreditLeases(this.sql);
    this.poisonRunFailureThreshold = Math.max(
      1,
      options?.poisonRunFailureThreshold ?? 3,
    );
  }


  async loadRun(runId: string): Promise<ProjectRun> {
    const [row] = await runRowQuery(this.sql, runId);

    if (!row) {
      throw new Error(`run not found: ${runId}`);
    }

    return mapRun(row);
  }

  /**
   * One document, within a tenant scope: the run it belongs to, or (for a run that reads another run's document, such as a
   * deferred materialization) the run's organization. A row outside the scope throws DocumentOutOfScopeError; a missing
   * row throws DocumentNotFoundError.
   */
  async loadDocument(documentId: string, scope: { runId: string } | { orgId: string | null }): Promise<Document> {
    const [row] = "runId" in scope
      ? await this.sql<DocumentRow[]>`select d.*, (select r.storage_prefix from project_runs r where r.id = d.run_id) as run_storage_prefix from documents d where d.id = ${documentId} and d.run_id = ${scope.runId} limit 1`
      : await this.sql<DocumentRow[]>`select d.*, (select r.storage_prefix from project_runs r where r.id = d.run_id) as run_storage_prefix from documents d where d.id = ${documentId} and d.org_id = ${scope.orgId} limit 1`;
    if (!row) {
      // Only on a miss, and only whether the id exists (no column of the row): a row outside the scope is a scope error,
      // never a deletion, so a caller that stops quietly on a deleted document fails loudly instead.
      const [exists] = await this.sql<{ one: number }[]>`select 1 as one from documents where id = ${documentId} limit 1`;
      if (exists) {
        const kind = "runId" in scope ? "run" as const : "org" as const;
        console.error(`[run-ledger] document out of scope document=${documentId} mismatch=${kind}`);
        throw new DocumentOutOfScopeError(documentId, kind);
      }
      throw new DocumentNotFoundError(documentId);
    }
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
    state.bindStore(this);
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
    const filterScope = state.run.projectId
      ? { column: "project_id", value: state.run.projectId }
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
      join project_runs runs on runs.id = perf.run_id
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
      scope: filterScope.column === "project_id" ? "project" : "user",
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
      update project_runs
      set
        last_heartbeat_at = now(),
        lease_expires_at = case when project_runs.kind = 'materialize'
            then greatest(coalesce(project_runs.lease_expires_at, now()), now() + (${this.leaseTtlMs} * interval '1 millisecond'))
            else now() + (${this.leaseTtlMs} * interval '1 millisecond') end,
        updated_at = now()
      where id = ${runId} and status = 'processing'
    `;
  }

  async updateProgress(state: WorkflowState, init?: { executionGeneration?: string }): Promise<void> {
    if (init) {
      // Init has no paid usage to settle. Refuse the entire write when obsolete,
      // terminal, or cancelled, rather than allowing a late snapshot to revive it.
      const [row] = await this.sql<{ id: string }[]>`
        update project_runs set status = 'processing',
          stats = ${this.toJson(state.run.stats ?? {})}::jsonb,
          artifacts = ${this.toJson(state.artifacts)}::jsonb, updated_at = now()
        where id = ${state.run.id} and org_id = ${state.run.orgId ?? null}
          and project_id = ${state.run.projectId ?? null}
          and execution_generation is not distinct from ${init.executionGeneration ?? null}
          and status in ('queued', 'processing')
          and coalesce(control_state, '') not in ('cancelled', 'cancel_requested', 'paused', 'pause_requested', 'dead-letter')
        returning id
      `;
      if (!row) throw new StaleExecutionError();
      return;
    }
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
    // The asset ledger goes after the checkpoint commits: it may only describe Markdown and slots that are durable.
    const next = previous.then(async () => {
      const written = await this.writeProgressGuarded(state, prelude, options);
      if (state.pendingAssetLedger.size > 0) await flushAssetLedger(state, (write) => writeDocumentAssetLedger(this.sql, write));
      return written;
    });
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
    for (const row of state.pendingPageExtracts) referenced.add(row.document_id);
    if (referenced.size === 0) return false;
    const live = new Set((await this.sql<{ id: string }[]>`select id from documents where id = any(${[...referenced]})`).map((row) => row.id));
    const missing = new Set([...referenced].filter((id) => !live.has(id)));
    if (missing.size === 0) return false;
    console.warn(`[store] dropping checkpoint rows for deleted documents run=${state.run.id} documents=${[...missing].join(",")}`);
    state.vectorIndexes = state.vectorIndexes.filter((vector) => !missing.has(vector.documentId));
    state.pendingParserEvaluations = state.pendingParserEvaluations.filter((evaluation) => !missing.has(evaluation.documentId));
    state.pendingPageExtracts = state.pendingPageExtracts.filter((row) => !missing.has(row.document_id));
    state.pendingPageExtractTags = state.pendingPageExtractTags.filter((row) => !missing.has(row.document_id));
    // Performance samples stay (stage timings still describe real work), detached from the deleted document.
    state.pendingPerformance = state.pendingPerformance.map((event) => (event.documentId && missing.has(event.documentId) ? { ...event, documentId: undefined } : event));
    return true;
  }

  private async writeProgressNow(
    state: WorkflowState,
    prelude: ((client: Sql<Record<string, unknown>>) => readonly PendingQuery<any>[]) | undefined,
    options: { stageBoundary?: boolean; readControlState?: boolean; preloadRunState?: boolean },
    transaction?: { client: Sql<Record<string, unknown>>; afterCommit: Array<() => void> },
  ): Promise<ProgressWrite> {
    state.run.artifacts = state.artifacts;
    const usageBatch = state.usageLedger.checkpoint();
    const vectors = state.vectorIndexes.slice();
    const performance = state.pendingPerformance.slice();
    const pageExtracts = state.pendingPageExtracts.slice();
    const pageExtractTags = state.pendingPageExtractTags.slice();
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
    // project_runs.spent_cents once this checkpoint commits.
    let spentCents = state.run.spentCents;

    // Postgres rolls a deadlock victim back whole; every assignment below is
    // reset per attempt and the usage batch commits only after success.
    // The independent writes go out as one pipelined transaction (one round
    // trip, transaction-pipeline.ts); only the credit lease needs a result.
    const write = async () => {
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
      const results = await (transaction ? pipelineInTransaction : pipelineTransaction)(transaction?.client ?? this.sql, (client) => {
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
            stage = case when project_runs.status in ('completed', 'failed') then project_runs.stage else ${state.stage} end,
            processed_documents = greatest(project_runs.processed_documents, ${state.run.processedDocuments}),
            pages_processed = greatest(project_runs.pages_processed, ${state.run.pagesProcessed}),
            artifacts = coalesce(project_runs.artifacts, '{}'::jsonb) || ${this.toJson(shardDelta.artifacts)}::jsonb`
          : client`
            status = case when project_runs.status in ('completed', 'failed') then project_runs.status else ${state.run.status} end,
            stage = case when project_runs.status in ('completed', 'failed') then project_runs.stage else ${state.stage} end,
            processed_documents = ${state.run.processedDocuments},
            pages_total = ${state.run.pagesTotal},
            pages_processed = ${state.run.pagesProcessed},
            stats = ${this.toJson(state.run.stats ?? {})}::jsonb,
            artifacts = ${this.toJson(state.run.artifacts ?? {})}::jsonb`;
        // The run row is locked from this update to commit, so spent_cents
        // changes only by the trigger on this checkpoint's own usage inserts.
        const runUpdate = counter
          ? client<{ spend_check_due: boolean; no_unchecked_spend: boolean; spent_cents: number | string }[]>`
            update project_runs
            set
              ${counter.assignments},
              ${runAssignments},
              last_heartbeat_at = case when project_runs.status in ('completed', 'failed') then project_runs.last_heartbeat_at else now() end,
              lease_expires_at = case
                when project_runs.status in ('completed', 'failed') then project_runs.lease_expires_at
                when project_runs.kind = 'materialize'
                  then greatest(coalesce(project_runs.lease_expires_at, now()), now() + (${this.leaseTtlMs} * interval '1 millisecond'))
                else now() + (${this.leaseTtlMs} * interval '1 millisecond') end,
              updated_at = now()
            from ${counter.from}
            where project_runs.id = spend_prev.id
            returning ${counter.checkDue} as spend_check_due,
              project_runs.spend_unchecked_credits = 0 as no_unchecked_spend,
              project_runs.spent_cents
          `
          : client<{ spent_cents: number | string }[]>`
            update project_runs
            set
              ${runAssignments},
              last_heartbeat_at = case when project_runs.status in ('completed', 'failed') then project_runs.last_heartbeat_at else now() end,
              lease_expires_at = case
                when project_runs.status in ('completed', 'failed') then project_runs.lease_expires_at
                when project_runs.kind = 'materialize'
                  then greatest(coalesce(project_runs.lease_expires_at, now()), now() + (${this.leaseTtlMs} * interval '1 millisecond'))
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
        statements.push(...pageExtractStatements(client, pageExtracts, pageExtractTags));
        if (options.readControlState) {
          controlIndex = statements.length;
          statements.push(client<{ control_state: string | null }[]>`select control_state from project_runs where id = ${state.run.id}`);
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
        const [runRows, documentRows, stageRows] = results.slice(preloadIndex, preloadIndex + 3) as [ProjectRunRow[], DocumentRow[], StageStateRows];
        if (runRows[0]) preloaded = { run: mapRun(runRows[0]), documents: documentRows.map(mapDocument), stageStates: stageRows };
      }
      if (controlIndex >= 0) controlRequested = CONTROL_REQUEST_STATES.includes((results[controlIndex] as { control_state: string | null }[])[0]?.control_state ?? "");
    };
    if (transaction) await write();
    else await retryTransaction(`checkpoint run=${state.run.id}`, write);

    const commit = () => {
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
    state.pendingPageExtracts = without(state.pendingPageExtracts, pageExtracts);
    state.pendingPageExtractTags = without(state.pendingPageExtractTags, pageExtractTags);
    };
    if (transaction) {
      transaction.afterCommit.push(commit);
      return { unspentSinceCheck };
    }
    commit();
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

  async completeRun(state: WorkflowState, owner: ExecutionOwner = { runId: state.run.id, orgId: state.run.orgId!, projectId: state.run.projectId! }): Promise<void> {
    if (owner.runId !== state.run.id || owner.orgId !== state.run.orgId || owner.projectId !== state.run.projectId) throw new StaleExecutionError();
    // Resolve schema capabilities before reserving the terminal transaction connection.
    await this.creditLeases.active();
    if (state.pendingParserEvaluations.length) await this.tableExists("parser_eval_results");
    const afterCommit: Array<() => void> = [];
    const snapshot = { run: { ...state.run }, stage: state.stage, statuses: state.documents.map(document => document.status) };
    try {
      await this.finalizeRun(owner, "completed", async (client, logicalId) => {
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
        await this.writeProgressNow(state, undefined, {}, { client, afterCommit });
        const pageCharges = await recordPageBaseFee(client, state, { afterCommit });
        // Reported in the run's stats: the Fast pages charged now and the Rich pages their reads charged as they happened.
        state.run.stats = { ...state.run.stats, pageCharges };
        const adopted = state.run.kind === "full-index" ? new Set(await adoptBackfillDocuments(client, state.run.id)) : new Set<string>();
        // Documents completed here (pipelines without an index stage) get their page extract records' finals too: the two
        // finalization statements go out right behind the statement that completes the documents (one flight; the
        // documents UPDATE holds their row locks first).
        const finalizeScope = { orgId: owner.orgId, runId: state.run.id, documentIds: "completed-in-run" as const };
        const completed = await completeRunDocuments(client, state.run.id, finalizePageExtracts(client, finalizeScope));
        logFinalizeOutcome(completed.finalized, finalizeScope);
        const replacements = await supersededInThisTransaction(client, completed.ids.filter(id => !adopted.has(id)));
        await this.notifications.announceReplacements(state, replacements, client, logicalId);
        // The run's ingest stamp and its documents' (db/ingest-version.ts) ride on this statement: no extra round trip.
        const stamps = runStampsIngestVersion(state.run.kind);
        const stampMode = runReusesExtraction(state.run.pipeline) ? "inherited" as const : "extracted" as const;
        const stampDocuments = stamps ? client`with stamped as (${stampDocumentIngestVersion(client, state.run.id, stampMode)} returning 1)` : client``;
        const stampRun = stamps ? runStamp(client, stampMode) : client``;
        await client`${stampDocuments} update project_runs set status = 'completed', stage = 'completed',
          processed_documents = total_documents, pages_processed = pages_total,
          stats = coalesce(stats, '{}'::jsonb) || ${this.toJson({ pageCharges })}::jsonb,
          lease_expires_at = null, updated_at = now() ${stampRun} where id = ${state.run.id}`;
        await insertProjectRunEvents({ sql: client, events: [{ ...buildRunCompletedEvent(state, "pipeline completed"), id: logicalId }] });
        await this.notifications.triggerWebhooks(state.run.id, "run.completed", client, logicalId);
      });
    } catch (error) {
      Object.assign(state.run, snapshot.run);
      state.stage = snapshot.stage;
      state.documents.forEach((document, index) => { document.status = snapshot.statuses[index]!; });
      if (error instanceof StaleExecutionError) await this.settleLateUsage(state, owner);
      throw error;
    }
    for (const commit of afterCommit) commit();
  }

  private async settleLateUsage(state: WorkflowState, owner: ExecutionOwner): Promise<void> {
    // Settle real usage without applying the obsolete progress snapshot.
    const batch = state.usageLedger.checkpoint();
    if (batch.events.length) {
      await this.sql.begin(async tx => {
        const client = tx as unknown as typeof this.sql;
        const [run] = await client`select id from project_runs where id = ${owner.runId}
          and org_id = ${owner.orgId} and project_id = ${owner.projectId} for update`;
        if (!run) throw new StaleExecutionError();
        const costCents = await persistRunUsageEvents({ client, state, usageEvents: batch.events });
        await debitRunUsageCredits({ client, state, costCents });
      });
      batch.commit();
    }
  }

  /** Ownership lock and receipt share the caller's terminal mutations and commit. */
  async finalizeRun(owner: ExecutionOwner, outcome: "failed" | "completed",
    write: (client: Sql<Record<string, unknown>>, logicalId: string) => Promise<void>): Promise<void> {
    await this.sql.begin(async (tx) => {
      await assertExecutionOwnership(tx, owner);
      const logicalId = JSON.stringify(["run-terminal", owner.runId, owner.executionGeneration ?? null]);
      const [existing] = await tx`select id from run_terminal_receipts where id = ${logicalId}`;
      if (existing) return;
      const [eligible] = await tx`select id from project_runs where id = ${owner.runId}
        and status in ('queued', 'processing')
        and coalesce(control_state, '') not in ('cancelled', 'cancel_requested', 'paused', 'pause_requested', 'dead-letter')`;
      if (!eligible) throw new StaleExecutionError();
      const [receipt] = await tx`
        insert into run_terminal_receipts (id, run_id, execution_generation, outcome)
        values (${logicalId}, ${owner.runId}, ${owner.executionGeneration ?? null}, ${outcome})
        on conflict (id) do nothing returning id
      `;
      if (!receipt) return;
      await write(tx as unknown as Sql<Record<string, unknown>>, logicalId);
    });
  }

  async failRun(runId: string, stage: string, message: string, owner: ExecutionOwner, options: { infrastructureRetriesExhausted?: boolean } = {}): Promise<void> {
    if (owner.runId !== runId) throw new StaleExecutionError();
    await this.finalizeRun(owner, "failed", async (client, logicalId) => {
      const [current] = await client<
        {
          user_id: string;
          stats: JsonMap | null;
          failure_count: number;
        }[]
      >`
        select user_id, stats, coalesce(failure_count, 0) as failure_count
        from project_runs
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

      const [row] = await client<{ user_id: string; stats: JsonMap | null }[]>`
        update project_runs
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

      await client`select retire_replaced_pending_documents(${runId})`;
      // Exhausted infrastructure retries: each unfinished document gets the public reason marker (real-Modal P3); the raw
      // run error after it is for operators only (public APIs map stored errors to reviewed copy).
      await this.failProcessingDocumentStages(runId, stage,
        options.infrastructureRetriesExhausted ? `${INFRASTRUCTURE_RETRIES_EXHAUSTED_TEXT}: ${message}` : message, client);
      await this.failUnfinishedDocumentsForRun(runId, client);

      await insertProjectRunEvents({ sql: client, events: [{
        id: logicalId,
        userId: row.user_id,
        runId,
        stageName: stage,
        eventType: "run.failed",
        status: "failed",
        message: plan.eventMessage,
        progress: {},
        stats: row.stats ?? {},
        payload: plan.eventPayload,
      }] });
      await this.notifications.triggerWebhooks(runId, "run.failed", client, logicalId);
    });
  }

  async releaseRunLease(runId: string): Promise<boolean> {
    const [row] = await this.sql<RunReleaseRow[]>`
      update project_runs
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
    client: Sql<Record<string, unknown>> = this.sql,
  ): Promise<void> {
    await client`
      update document_run_stage_states
      set status = 'failed',
          error = ${message},
          updated_at = now()
      where run_id = ${runId}
        and stage_name = ${stage}
        and status = 'processing'
    `;

    await client`
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
  private async failUnfinishedDocumentsForRun(runId: string, client: Sql<Record<string, unknown>> = this.sql): Promise<void> {
    await client`
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

  /** The run has a pending pause or cancel request (project_runs.control_state). */
  async hasRunControlRequest(runId: string): Promise<boolean> {
    const [row] = await this.sql<{ control_state: string | null }[]>`
      select control_state from project_runs where id = ${runId}
    `;
    return ["pause_requested", "paused", "cancel_requested", "cancelled"].includes(row?.control_state ?? "");
  }

  /** Which of `stages` this run has completed (project_run_stage_states). */
  async completedRunStages(runId: string, stages: readonly string[]): Promise<Set<string>> {
    if (stages.length === 0) return new Set();
    const rows = await this.sql<{ stage_name: string }[]>`
      select stage_name from project_run_stage_states
      where run_id = ${runId} and status = 'completed' and stage_name = any(${this.sql.array([...stages])})
    `;
    return new Set(rows.map((row) => row.stage_name));
  }

  /** The stage the run last started (project_runs.stage). */
  async currentRunStage(runId: string): Promise<string | null> {
    const [row] = await this.sql<{ stage: string | null }[]>`select stage from project_runs where id = ${runId}`;
    return row?.stage ?? null;
  }

  /** Shards still pending for the run's current stage (the autoscaler turns them into machines). */
  async setRunShardDemand(runId: string, shards: number): Promise<void> {
    await this.sql`update project_runs set shard_demand = ${Math.max(0, Math.floor(shards))} where id = ${runId}`;
  }

  /** A shard's final checkpoint, then one shard less of fleet demand. */
  async finishShard(state: WorkflowState): Promise<void> {
    await this.writeProgress(state, (client) => [
      client`update project_runs set shard_demand = greatest(0, shard_demand - 1) where id = ${state.run.id}`,
    ]);
  }

  /** Marks a run stage processing and checkpoints run progress in the same transaction. */
  async startRunStage(state: WorkflowState, stage: string, owner?: ExecutionOwner): Promise<void> {
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

    const prelude = (client: Sql<Record<string, unknown>>) => [
      client`
        insert into project_run_stage_states (run_id, stage_name, status, attempts, stats, started_at, updated_at)
        values (${state.run.id}, ${stage}, 'processing', 1, '{}'::jsonb, now(), now())
        on conflict (run_id, stage_name) do update
        set status = 'processing',
            attempts = project_run_stage_states.attempts + 1,
            error = null,
            started_at = now(),
            completed_at = null,
            updated_at = now()
      `,
      // The stage's own pass starts once its shards are done.
      client`update project_runs set shard_demand = 0 where id = ${state.run.id} and shard_demand <> 0`,
    ];
    if (owner) {
      if (owner.runId !== state.run.id || owner.orgId !== state.run.orgId || owner.projectId !== state.run.projectId) throw new StaleExecutionError();
      await this.creditLeases.active();
      if (state.pendingParserEvaluations.length) await this.tableExists("parser_eval_results");
      const afterCommit: Array<() => void> = [];
      try {
        await this.sql.begin(async tx => {
          await assertPlanningOwnership(tx, owner);
          await this.writeProgressNow(state, prelude, {}, { client: tx as unknown as typeof this.sql, afterCommit });
        });
      } catch (error) {
        if (error instanceof StaleExecutionError) {
          await this.settleLateUsage(state, owner);
        }
        throw error;
      }
      for (const commit of afterCommit) commit();
    } else {
      await this.writeProgress(state, prelude);
    }

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
        update project_run_stage_states
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
      insert into project_run_stage_states (run_id, stage_name, status, attempts, error, stats, started_at, updated_at)
      values (${state.run.id}, ${stage}, 'failed', 1, ${message}, jsonb_build_object('ordinaryFailures', ${increment}::int), now(), now())
      on conflict (run_id, stage_name) do update
      set status = 'failed', error = ${message}, updated_at = now(),
          stats = jsonb_set(
            coalesce(project_run_stage_states.stats, '{}'::jsonb),
            '{ordinaryFailures}',
            to_jsonb(coalesce((project_run_stage_states.stats->>'ordinaryFailures')::int, 0) + ${increment}::int)
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

  /**
   * A strike another document's failure blames on `documentId` (council X #1): on that document's own row in this run, for
   * the stage it last ran. Returns its strikes, or null when it has no stage row in this run (nothing struck).
   */
  async noteBlamedSandboxStrike(state: WorkflowState, documentId: string): Promise<number | null> {
    const [row] = await this.sql<{ strikes: number }[]>`
      update document_run_stage_states s
      set stats = jsonb_set(s.stats, '{sandboxInfrastructureStrikes}',
            to_jsonb(coalesce((s.stats->>'sandboxInfrastructureStrikes')::int, 0) + 1)),
          updated_at = now()
      where s.run_id = ${state.run.id} and s.document_id = ${documentId}
        and s.stage_name = (
          select stage_name from document_run_stage_states
          where run_id = ${state.run.id} and document_id = ${documentId}
          order by started_at desc nulls last, updated_at desc limit 1)
      returning (s.stats->>'sandboxInfrastructureStrikes')::int as strikes
    `;
    return row ? Number(row.strikes) : null;
  }

  async noteSandboxInfrastructureStrike(state: WorkflowState, documentId: string, stage: string): Promise<number> {
    // In the stage checkpoint's stats, which startDocumentStage keeps across retries.
    const [row] = await this.sql<{ strikes: number }[]>`
      update document_run_stage_states
      set stats = jsonb_set(stats, '{sandboxInfrastructureStrikes}',
            to_jsonb(coalesce((stats->>'sandboxInfrastructureStrikes')::int, 0) + 1)),
          updated_at = now()
      where run_id = ${state.run.id} and document_id = ${documentId} and stage_name = ${stage}
      returning (stats->>'sandboxInfrastructureStrikes')::int as strikes
    `;
    return Number(row?.strikes ?? 0);
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
            failure = null,
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
    geoFinalSource?: GeoFinalSource,
  ): Promise<void> {
    if (geoFinalSource && (stage !== "structured-extract" || geoFinalSource.documentId !== documentId ||
      geoFinalSource.runId !== state.run.id || geoFinalSource.projectId !== state.run.projectId ||
      geoFinalSource.orgId !== state.run.orgId)) throw new Error("Geo checkpoint scope mismatch");
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
            failure = null,
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
            update documents d
            set status = case
                  when status = 'pii_blocked' then status
                  when status = 'completed' and ${indexedInRun(client, state.run.id, documentId)} then status
                  else 'completed'
                end,
                updated_at = now()
                ${runStampsIngestVersion(state.run.kind)
                  ? completingDocumentStamp(client, state.run.id, runReusesExtraction(state.run.pipeline) ? "inherited" : "extracted")
                  : client``}
            where d.id = ${documentId}`,
          // The document's page extract records get their one final row per page, in the transaction that publishes it
          // (after the documents UPDATE above, which holds the document's row lock: documents first, then extract rows).
          ...(state.run.orgId ? finalizePageExtracts(client, { orgId: state.run.orgId, runId: state.run.id, documentIds: [documentId] }) : []),
          supersededInThisTransactionQuery(client, [documentId]),
        ]);
        if (state.run.orgId) logFinalizeOutcome(results.at(-2) as Array<{ run_found: number; changed: number }>, { runId: state.run.id, documentIds: [documentId] });
        return mapSuperseded(results.at(-1) as Parameters<typeof mapSuperseded>[0]);
      });
    } else if (geoFinalSource) {
      const source = geoFinalSource;
      await retryTransaction(`complete-geo-stage run=${state.run.id}`, () => pipelineTransaction(this.sql, client => [
        client`select commit_geo_final_source(${source.documentId},${source.projectId},${source.orgId},
          ${source.revision}::bigint,${source.runId},${source.schemaDigest},${source.resultDigest},
          ${this.toJson(source.features)}::jsonb)`,
        stageStateUpdate(client),
      ]).then(() => undefined));
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
    await this.notifications.announceReplacements(state, cutover);

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
      await this.notifications.triggerPlausibilityWarningEmail(
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
    failure?: import("@docslurp/shared").DocumentFailure,
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
        failure,
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
        ${this.toJson(failure ?? null)}::jsonb,
        now(),
        now()
      )
      on conflict (run_id, document_id, stage_name) do update
      set status = 'failed',
          artifact_uri = ${artifactUri || null},
          stats = ${this.toJson(stats ?? {})}::jsonb,
          error = ${message},
          failure = ${this.toJson(failure ?? null)}::jsonb,
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

  /**
   * Buffers a run event for the next coalesced write (≤ WORKER_RUN_EVENT_FLUSH_MS);
   * terminal run events are written before this resolves. See run-event-store.ts.
   */
  async appendEvent(event: ProjectRunEvent): Promise<void> {
    await this.runEvents.append(event);
  }

  /** Writes buffered run events now. */
  async flushRunEvents(): Promise<void> {
    await this.runEvents.flush();
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
      embedding_model_uri: vector.embeddingModelUri ?? null,
      embedding_model_class: vector.embeddingModelClass ?? null,
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
        "embedding_model_uri",
        "embedding_model_class",
      )}
      on conflict (document_id, backend, embedding_model, dimension)
      do update set bucket = excluded.bucket, path = excluded.path,
        embedding_model_uri = excluded.embedding_model_uri, embedding_model_class = excluded.embedding_model_class
    `);
    // Search serves each document from the index config it was built with (projects.index_configs).
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

  /** Stamps a run milestone the first time it happens; null when it was already stamped (pipeline/run-milestones.ts). */
  async markRunMilestone(runId: string, milestone: RunMilestone): Promise<RunMilestoneHit | null> {
    const column = this.sql(RUN_MILESTONE_COLUMNS[milestone]);
    const [row] = await this.sql<{ seconds: number; pages: number }[]>`
      update project_runs set ${column} = now()
      where id = ${runId} and ${column} is null
      returning extract(epoch from (now() - created_at))::float8 as seconds, coalesce(pages_total, 0)::int as pages
    `;
    return row ? { seconds: Math.max(0, Number(row.seconds)), pages: Number(row.pages) } : null;
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
    owner: ExecutionOwner,
  ): Promise<{ seededDocuments: number; unavailable: Array<{ documentId: string; reason: string }> }> {
    if (reusedStages.length === 0) return { seededDocuments: 0, unavailable: [] };
    return await this.sql.begin(async (tx) => {
      if (owner.runId !== runId) throw new StaleExecutionError();
      await assertExecutionOwnership(tx, owner);
      const [eligible] = await tx<{ id: string }[]>`
        select id from project_runs where id = ${runId}
          and status in ('queued', 'processing')
          and coalesce(control_state, '') not in ('cancelled', 'cancel_requested', 'paused', 'pause_requested', 'dead-letter')`;
      if (!eligible) throw new StaleExecutionError();
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
        -- The source must be the same organization's document: another organization's is no source at all.
        left join documents source on source.id = d.reused_from_document_id and source.org_id = d.org_id
        left join project_runs source_run on source_run.id = source.run_id
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

      // Quarantine is never reused (council R7-H1): its parse decision and scanned copy belong to the run that made them,
      // and that run's retention purges the copy. Every partial plan re-runs it (stageDataFlow.quarantine.alwaysRerun);
      // an older stored plan that still lists it gets no checkpoint, so this run's quarantine runs.
      const reused = reusedStages.filter((stage) => stage !== "quarantine");
      for (const doc of docs) {
        const sourceId = doc.source_id!;
        const prefix = `${sourceId}:`;
        // Existing keys win: a retried start must not overwrite artifacts a
        // stage of this run already wrote.
        await client`
          update project_runs target
          set artifacts = coalesce((
                select jsonb_object_agg(${`${doc.id}:`}::text || substr(artifact.key, ${prefix.length + 1}), artifact.value)
                from project_runs source
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

  /** Records blocked hosted AI attempts for strict-privacy projects. */
  async recordPrivacyAudit(entries: readonly PrivacyAuditEntry[]): Promise<void> {
    await insertPrivacyAuditRows(this.sql, entries);
  }

  private toJson(value: unknown) {
    return this.sql.json(JSON.parse(JSON.stringify(value ?? {})) as JSONValue);
  }

  private toJsonText(value: unknown) {
    return JSON.stringify(JSON.parse(JSON.stringify(value ?? {})));
  }

  private tableExists(tableName: string): Promise<boolean> {
    return this.tables.exists(tableName);
  }

}

function mapRun(row: ProjectRunRow): ProjectRun {
  return {
    id: row.id,
    executionGeneration: row.execution_generation ?? null,
    orgId: row.canonical_org_id ?? row.org_id ?? null,
    ...(row.org_funded !== undefined && row.org_funded !== null ? { orgFunded: row.org_funded } : {}),
    allowChinaProviders: row.allow_china_providers === true,
    userId: row.user_id,
    projectId: row.project_id,
    kind: row.kind,
    status: row.status,
    stage: row.stage,
    totalDocuments: row.total_documents,
    processedDocuments: row.processed_documents,
    pagesTotal: row.pages_total,
    pagesProcessed: row.pages_processed,
    spentCents: Number(row.spent_cents ?? 0) || 0,
    // DOCSLURP_VISION_MODEL_URI replaces the built-in default vision model at run time, never in stored settings.
    // The Auto ladder's limits (pipeline.ladder) are applied once here: Auto capped at the fast rung reads as Fast, and
    // chart export below the intelligent rung keeps its free tier. Every stage reads this pipeline. DOCSLURP_DISABLE
    // lowers it last (`ai`: smart runs as balanced without rescue reads; `ai-rescue`; `charts`/`charts-ai`).
    pipeline: applyKillSwitchesToPipeline(applyLadderLimits(applyDefaultVisionOverride(normalizeStoredPipelineFeatures(row.pipeline ?? defaultPipelineFeatures, `run ${row.id}`))), process.env),
    error: row.error,
    stats: row.stats ?? {},
    artifacts: row.artifacts ?? {},
    claimId: row.run_id,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    ...(row.storage_prefix ? { storagePrefix: row.storage_prefix, extractId: row.extract_id ?? null } : {}),
  };
}

function mapDocument(row: DocumentRow): Document {
  const document: Document = {
    id: row.id,
    userId: row.user_id,
    runId: row.run_id,
    filename: row.filename,
    mimeType: row.mime_type,
    // The bytes for parsing as this build's quarantine decided them: its scanned copy of an encrypted PDF, the upload it
    // scanned, or (no decision) an unreadable key that every reader but quarantine refuses.
    ...resolveDocumentSource(row),
    status: row.status,
    extractionMode: row.extraction_mode,
    pageCount: row.page_count,
    billingPages: row.billing_pages ?? null,
    billingPagesMethod: row.billing_pages_method ?? null,
    pageCountSource: row.page_count_source === "assumed" || row.page_count_source === "counted" ? row.page_count_source : null,
    intakePageCount: row.intake_page_count === null || row.intake_page_count === undefined ? null : Number(row.intake_page_count),
    fileFacts: row.file_facts ?? null,
    ...(row.file_size === null || row.file_size === undefined ? {} : { sourceBytes: Number(row.file_size) }),
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
    ...(row.run_storage_prefix ? { artifactRoot: row.run_storage_prefix } : {}),
  };
  // The upload's key stays off the document unless quarantine decided parsers read it: only quarantine reaches it.
  bindDocumentUpload(document, row);
  return document;
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


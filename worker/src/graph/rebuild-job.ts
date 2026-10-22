
import type { Sql } from "postgres";
import {
  calculateAiUsageCostCents,
  graphConfigSchema,
  normalizePipelineFeatures,
  resolvePipelineTextModel,
  type GraphConfig,
  type PipelineFeatures,
} from "@docslurp/shared";

import type { Config } from "../config.js";
import type { WorkerAiUsageInput } from "../lib/ai-usage.js";
import type { CommandRunner } from "../tools/runner.js";
import { refreshWorkspaceCommunities } from "./communities.js";
import { extractDocumentGraph } from "./extract.js";
import { replaceDocumentGraph } from "./graph-store.js";
import { persistScopedUsageEvents } from "../db/usage-event-store.js";
import { allowHostedCallForWorkspace, openRouterTextCall, runWithPrivacyAuditScope } from "../lib/privacy-guard.js";
import { textFallbackCost, textModelApiKey, textUsageLabels } from "../lib/text-model-route.js";
import { DOCUMENT_FEATURE_METRICS, UNIT_CHARGE_PROVIDER, featureCredits, unitChargeMetadata } from "@docslurp/shared";

type Client = Sql<Record<string, unknown>>;

export interface GraphJobRunnerOptions {
  workerId: string;
  config: Config;
  runner?: CommandRunner;
  /** A crashed worker's job is resumed by another once its lease expires. */
  leaseMs?: number;
  /** Documents extracted at once. */
  concurrency?: number;
}

type GraphJobRow = {
  id: string;
  org_id: string;
  workspace_id: string;
  user_id: string;
  mode: "stale" | "full";
  phase: "queued" | "extracting" | "communities" | "done";
  config: unknown;
  config_hash: string;
  model: string;
  max_cost_cents: number | string | null;
  cost_cents: number | string;
  cursor: string | null;
};

type JobProgress = {
  processed: number;
  failed: number;
  windows: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
};

const DEFAULT_LEASE_MS = 15 * 60_000;

/** Number of documents a rebuild job of `mode` would extract right now. */
export async function countGraphJobDocuments(
  sql: Client,
  args: { workspaceId: string; mode: "stale" | "full"; configHash: string },
): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    select count(*)::int as count from documents d
    where d.workspace_id = ${args.workspaceId}
      and d.status = 'completed' and d.superseded_at is null
      and (${args.mode} = 'full' or not exists (
        select 1 from kg_document_state s where s.document_id = d.id and s.config_hash = ${args.configHash}
      ))
  `;
  return row?.count ?? 0;
}

/**
 * Claims one queued (or lease-expired) workspace graph rebuild and runs it to
 * the end: re-extract the target documents from their stored chunks, merging
 * each into the workspace graph as it goes, then re-cluster communities.
 * Progress, tokens and cost are written after every batch so the API can
 * stream them. Returns the number of jobs run (0 or 1).
 */
export async function runGraphJobs(sql: Client, options: GraphJobRunnerOptions): Promise<number> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const [job] = await sql<GraphJobRow[]>`
    update graph_jobs
    set status = 'running',
        phase = case when phase = 'queued' then 'extracting' else phase end,
        lease_owner = ${options.workerId},
        lease_expires_at = now() + ${`${leaseMs} milliseconds`}::interval,
        started_at = coalesce(started_at, now()),
        updated_at = now()
    where id = (
      select id from graph_jobs
      where status = 'queued' or (status = 'running' and lease_expires_at < now())
      order by created_at
      limit 1
      for update skip locked
    )
    returning id, org_id, workspace_id, user_id, mode, phase, config, config_hash, model, max_cost_cents, cost_cents, cursor
  `;
  if (!job) return 0;

  try {
    // Private endpoint calls in this job are attributed to its workspace (strict-privacy audit).
    await runWithPrivacyAuditScope({ workspaceId: job.workspace_id }, () => runClaimedJob(sql, job, options, leaseMs));
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error);
    console.error(`[graph-job] failed job=${job.id} workspace=${job.workspace_id} error=${message}`);
    await sql`
      update graph_jobs
      set status = 'failed', error = ${message.slice(0, 2000)}, finished_at = now(), updated_at = now(),
          lease_owner = null, lease_expires_at = null
      where id = ${job.id} and lease_owner = ${options.workerId}
    `;
  }
  return 1;
}

async function runClaimedJob(sql: Client, job: GraphJobRow, options: GraphJobRunnerOptions, leaseMs: number) {
  const [workspace] = await sql<{ name: string; pipeline: unknown }[]>`
    select name, pipeline from workspaces where id = ${job.workspace_id}
  `;
  if (!workspace) throw new Error("Workspace no longer exists");
  const pipeline = normalizePipelineFeatures(workspace.pipeline as PipelineFeatures);
  const graphConfig: GraphConfig = graphConfigSchema.parse(job.config);
  const scope = graphConfig.domain ?? `Workspace "${workspace.name}"`;
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const maxCostCents = job.max_cost_cents === null ? null : Number(job.max_cost_cents);
  let spentCents = Number(job.cost_cents);
  let cursor = job.cursor;
  const config = options.config;
  // Without a key both graph extraction and community summaries use heuristics;
  // a privacyMode block withholds the key so no chunk text reaches a hosted LLM.
  const graphApiKey = pipeline.graphRag && textModelApiKey(config.openRouterApiKey, job.model) && await allowHostedCallForWorkspace(sql, {
    privacyMode: pipeline.privacyMode,
    workspaceId: job.workspace_id,
    call: openRouterTextCall("graph-extraction", job.model),
  }) ? textModelApiKey(config.openRouterApiKey, job.model) : undefined;

  console.log(`[graph-job] started job=${job.id} workspace=${job.workspace_id} mode=${job.mode} depth=${graphConfig.depth}`);

  if (job.phase === "extracting" || job.phase === "queued") {
    for (;;) {
      const documents = await sql<{ id: string; filename: string; page_count: number | null }[]>`
        select d.id, d.filename, d.page_count from documents d
        where d.workspace_id = ${job.workspace_id}
          and d.status = 'completed' and d.superseded_at is null
          and (${cursor}::text is null or d.id > ${cursor})
          and (${job.mode} = 'full' or not exists (
            select 1 from kg_document_state s where s.document_id = d.id and s.config_hash = ${job.config_hash}
          ))
        order by d.id
        limit ${concurrency}
      `;
      if (documents.length === 0) break;

      const progress: JobProgress = { processed: 0, failed: 0, windows: 0, inputTokens: 0, outputTokens: 0, costCents: 0 };
      const usage: Array<WorkerAiUsageInput & { id?: string }> = [];
      await Promise.all(documents.map(async (document) => {
        try {
          const chunks = await sql<{ id: string; text: string; page_number: number | null }[]>`
            select id, text, page_number from document_chunks
            where document_id = ${document.id}
            order by chunk_index
          `;
          const graph = await extractDocumentGraph({
            filename: document.filename,
            chunks: chunks.map((chunk) => ({ id: chunk.id, text: chunk.text, pageNumber: chunk.page_number })),
            context: {
              config: graphConfig,
              scope,
              model: job.model,
              apiKey: graphApiKey,
              useLlm: pipeline.graphRag,
              privacyMode: pipeline.privacyMode,
              textGeneration: pipeline.textGeneration,
              deploymentProfile: config.textGenerationProfile,
              onUsage: (eventUsage, details) => {
                console.log(`[ai-usage] graphrag-extract model=${job.model} input_tokens=${eventUsage.inputTokens} output_tokens=${eventUsage.outputTokens}`);
                const costCents = eventUsage.costCents ?? textFallbackCost({
                  model: job.model,
                  inputTokens: eventUsage.inputTokens,
                  outputTokens: eventUsage.outputTokens,
                  costPer1kInputTokens: config.costPer1kInputTokens,
                  costPer1kOutputTokens: config.costPer1kOutputTokens,
                }).costCents;
                progress.inputTokens += eventUsage.inputTokens;
                progress.outputTokens += eventUsage.outputTokens;
                progress.costCents += costCents;
                if (eventUsage.inputTokens > 0 || eventUsage.outputTokens > 0) {
                  usage.push({
                    ...textUsageLabels(job.model),
                    metric: "graphrag-extract",
                    inputTokens: eventUsage.inputTokens,
                    outputTokens: eventUsage.outputTokens,
                    costCents,
                    metadata: { ...eventUsage.metadata, documentId: document.id, depth: graphConfig.depth, ...details },
                  });
                }
              },
            },
          });
          await replaceDocumentGraph(sql, {
            workspaceId: job.workspace_id,
            userId: job.user_id,
            runId: null,
            documentId: document.id,
            configHash: job.config_hash,
            graph,
          });
          progress.processed += 1;
          progress.windows += graph.windows;
          if (graph.source === "llm") {
            // Price card: knowledge graph per started 10 pages, once per document per rebuild job.
            const pages = Math.max(1, Number(document.page_count) || 0);
            usage.push({
              id: `feature:knowledgeGraph:job:${job.id}:${document.id}`,
              provider: UNIT_CHARGE_PROVIDER, model: "price-card", metric: DOCUMENT_FEATURE_METRICS.knowledgeGraph,
              amount: 1, unit: "document", costCents: featureCredits("knowledgeGraph", pages), inputTokens: 0, outputTokens: 0,
              metadata: unitChargeMetadata({ documentId: document.id, feature: "knowledgeGraph", pages }),
            });
          }
        } catch (error) {
          progress.failed += 1;
          console.warn(`[graph-job] document failed job=${job.id} document=${document.id} error=${error instanceof Error ? error.message : String(error)}`);
        }
      }));
      await persistJobUsage(sql, job, usage);

      cursor = documents[documents.length - 1]!.id;
      spentCents += progress.costCents;
      const [state] = await sql<{ cancel_requested_at: Date | null }[]>`
        update graph_jobs
        set documents_processed = documents_processed + ${progress.processed},
            documents_failed = documents_failed + ${progress.failed},
            windows_processed = windows_processed + ${progress.windows},
            input_tokens = input_tokens + ${progress.inputTokens},
            output_tokens = output_tokens + ${progress.outputTokens},
            cost_cents = cost_cents + ${progress.costCents},
            cursor = ${cursor},
            lease_expires_at = now() + ${`${leaseMs} milliseconds`}::interval,
            updated_at = now()
        where id = ${job.id} and lease_owner = ${options.workerId}
        returning cancel_requested_at
      `;
      if (!state) {
        console.warn(`[graph-job] lease lost job=${job.id}`);
        return;
      }
      if (state.cancel_requested_at) {
        await finishJob(sql, job.id, options.workerId, "cancelled", "Cancelled by request");
        return;
      }
      if (maxCostCents !== null && spentCents >= maxCostCents) {
        await finishJob(sql, job.id, options.workerId, "cancelled", `Stopped at the ${formatCents(maxCostCents)} cost cap`);
        return;
      }
    }
    await sql`
      update graph_jobs set phase = 'communities', updated_at = now()
      where id = ${job.id} and lease_owner = ${options.workerId}
    `;
  }

  if (pipeline.graphRag || pipeline.graphCommunitySummaries) {
    const communityModel = resolvePipelineTextModel(pipeline, "community-summary", config.textGenerationModel);
    const usage: WorkerAiUsageInput[] = [];
    const communityApiKey = textModelApiKey(config.openRouterApiKey, communityModel) && await allowHostedCallForWorkspace(sql, {
      privacyMode: pipeline.privacyMode,
      workspaceId: job.workspace_id,
      call: openRouterTextCall("community-summary", communityModel),
    }) ? textModelApiKey(config.openRouterApiKey, communityModel) : undefined;
    const communities = await refreshWorkspaceCommunities({
      sql,
      workspaceId: job.workspace_id,
      userId: job.user_id,
      runId: null,
      context: {
        scope,
        model: communityModel,
        apiKey: communityApiKey,
        privacyMode: pipeline.privacyMode,
        textGeneration: pipeline.textGeneration,
        deploymentProfile: config.textGenerationProfile,
      },
    });
    const costCents = textFallbackCost({
      model: communityModel,
      inputTokens: communities.inputTokens,
      outputTokens: communities.outputTokens,
      costPer1kInputTokens: config.costPer1kInputTokens,
      costPer1kOutputTokens: config.costPer1kOutputTokens,
    }).costCents;
    if (communities.inputTokens > 0 || communities.outputTokens > 0) {
      usage.push({
        ...textUsageLabels(communityModel),
        metric: "community-summary",
        inputTokens: communities.inputTokens,
        outputTokens: communities.outputTokens,
        costCents,
        metadata: { communities: communities.communities, summarized: communities.summarized, reused: communities.reused },
      });
    }
    await persistJobUsage(sql, job, usage);
    const usageCost = usage.reduce((sum, event) => sum + (event.costCents ?? 0), 0);
    await sql`
      update graph_jobs
      set input_tokens = input_tokens + ${usage.reduce((sum, event) => sum + (event.inputTokens ?? 0), 0)},
          output_tokens = output_tokens + ${usage.reduce((sum, event) => sum + (event.outputTokens ?? 0), 0)},
          cost_cents = cost_cents + ${usageCost},
          updated_at = now()
      where id = ${job.id} and lease_owner = ${options.workerId}
    `;
  }
  await finishJob(sql, job.id, options.workerId, "completed", null);
  console.log(`[graph-job] completed job=${job.id} workspace=${job.workspace_id}`);
}

async function finishJob(
  sql: Client,
  jobId: string,
  workerId: string,
  status: "completed" | "cancelled",
  error: string | null,
) {
  await sql`
    update graph_jobs
    set status = ${status}, phase = 'done', error = ${error}, finished_at = now(), updated_at = now(),
        lease_owner = null, lease_expires_at = null
    where id = ${jobId} and lease_owner = ${workerId}
  `;
}

/**
 * Rebuild spend is run-less: it is stamped with the job's workspace and org
 * (usage_events tenant columns) and `graphJobId` ties it to the job.
 */
async function persistJobUsage(sql: Client, job: GraphJobRow, events: Array<WorkerAiUsageInput & { id?: string }>) {
  if (events.length === 0) return;
  await persistScopedUsageEvents({
    client: sql,
    userId: job.user_id,
    scope: { orgId: job.org_id, workspaceId: job.workspace_id },
    usageEvents: events.map((event) => ({
      ...(event.id ? { id: event.id } : {}),
      provider: event.provider,
      model: event.model,
      metric: event.metric,
      amount: event.amount ?? (event.inputTokens ?? 0) + (event.outputTokens ?? 0),
      unit: event.unit ?? "token",
      costCents: event.costCents ?? 0,
      inputTokens: event.inputTokens ?? 0,
      outputTokens: event.outputTokens ?? 0,
      metadata: { ...event.metadata, graphJobId: job.id },
    })),
    debitMetadata: { graphJobId: job.id },
  });
}

function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

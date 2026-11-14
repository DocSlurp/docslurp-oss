import { randomUUID } from "node:crypto";

import {
  detectFileFormat,
  normalizeStoredPipelineFeatures,
  resolveAllowedPipelineTextModel,
  SUMMARY_TREE_BUILD_STALE_MS,
  SUMMARY_TREE_JOB_NOTES,
  SUMMARY_TREE_MIN_DOCUMENT_LEAVES,
  SUMMARY_TREE_SERVE_ENV_FLAG,
  summaryTreeBuildAvailable,
  summaryTreeEnabled,
  summaryTreeServeAvailable,
  summaryTreeVectorProblem,
  type PipelineFeatures,
  type SummaryTreeJobBlockedReason,
} from "@docslurp/shared";
import type { Sql } from "postgres";

import type { Config } from "../config.js";
import { persistScopedUsageEvents } from "../db/usage-event-store.js";
import { resolveEmbeddingModel } from "../embeddings/resolver.js";
import type { WorkerAiUsageInput } from "../lib/ai-usage.js";
import { createConcurrencyLimiter } from "../lib/bounded-concurrency.js";
import { allowHostedCallForProject, openRouterTextCall, runWithPrivacyAuditScope } from "../lib/privacy-guard.js";
import { providerBalanceProbe, readProviderBalance, type ProviderBalanceProbe } from "../lib/provider-balance-probe.js";
import { projectProviderScope, runWithProviderRateScope } from "../lib/provider-rate-limit.js";
import { textUsageLabels } from "../lib/text-model-route.js";
import { deleteDocumentSummaryRows } from "../stages/lancedb-summaries.js";
import {
  runSummaryTreeForDocument,
  SUMMARY_TREE_USAGE_METRIC,
  summaryTreeConcurrency,
  type SummaryTreeOverrides,
  type SummaryTreeStorage,
} from "../stages/summary-tree.js";
import type { CommandRunner } from "../tools/runner.js";
import { summaryTreeArtifactRoot } from "./artifact.js";
import type { SummaryTreeBuildResult } from "./build.js";
import { SUMMARY_TREE_TEXT_OPERATION } from "./limits.js";
import { markSummaryTreesSkipped, registerSummaryTreeArtifact } from "./state-store.js";

/*
 * Summary tree backfill job (summary_tree_jobs, migration 0165): builds trees for a project's already indexed
 * documents. The build stage only sees new uploads, stops after its time budget, and never returns to a document it
 * left partial; this job does. It is a sibling of the graph rebuild job (graph/rebuild-job.ts): leased, with a
 * cursor, cancellable, capped. Each document is built by `runSummaryTreeForDocument`, the same function the stage
 * calls, with the document's own run id, run root and embed artifact, so the model route, the fleet rate limiter,
 * the privacy decision, the artifact, the registry and the summary rows are the stage's own.
 *
 * What it guarantees:
 *
 * - Scope. Every statement that reads or writes documents names the job's organization and project. The cursor is
 *   only a position inside that scope: a cursor naming another tenant's document selects nothing of theirs.
 * - Cap. The cap is mandatory. A model call is admitted only while the spend so far, plus a reserve for every call
 *   in flight, is under the cap, so the job passes it by less than one group. The check runs before each group
 *   (the build's `stopReason` hook), not after a batch.
 * - Usage. Every model attempt and embedding request is written to `usage_events`, and added to the job's own
 *   totals, in one transaction as soon as it returns: a worker that dies loses no record of a paid call, and the
 *   worker that takes the job over starts from the true spend.
 * - Resume. The lease is renewed while the job runs. When it expires the next worker claims the job, starts after
 *   the cursor and resumes the document in progress from its artifact: groups whose call returned are read back,
 *   never called again. A worker that lost its lease stops at its next call.
 * - Switches. Both deployment switches are read before the claim and before every batch, and the build reads the
 *   build switch before every call. Build off parks the job (`blocked`, `build-off`) with no further call.
 * - Balance. The deployment's provider balance probe, when one is configured, is asked before the claim and before
 *   every batch; below its floor (or unable to answer) the job parks (`blocked`, `balance`).
 * - No fallback text. A group whose call fails is retried by the build and once more by the job; then the document
 *   stays `partial`, is not served, and the next job picks it up. Nothing is written in a summary's place.
 *
 * A parked job holds no lease. It is looked at again after `resume_after`, by any worker.
 */

type Client = Sql<Record<string, unknown>>;
type Env = Readonly<Record<string, string | undefined>>;

export const SUMMARY_TREE_JOB_DEFAULT_LEASE_MS = 5 * 60_000;
/** Documents selected per batch. Most are small and are marked skipped in one statement. */
export const SUMMARY_TREE_JOB_DEFAULT_BATCH_SIZE = 200;
/** Documents built at once; their model calls share one limiter. */
export const SUMMARY_TREE_JOB_DEFAULT_DOCUMENT_CONCURRENCY = 2;
/** How long a parked job waits before it is looked at again. */
export const SUMMARY_TREE_JOB_DEFAULT_PARK_MS = 60_000;
/** A sufficient balance reading is reused this long, so a run of small batches does not ask the probe each time. */
export const SUMMARY_TREE_JOB_DEFAULT_PROBE_TTL_MS = 15_000;
/** A reserve of this many times the largest call seen so far is held for every call in flight. */
const RESERVE_FACTOR = 2;
/** This many documents in a row failing with an error ends the job: the fault is not the documents'. */
const MAX_CONSECUTIVE_DOCUMENT_ERRORS = 5;

export interface SummaryTreeJobRunnerOptions {
  workerId: string;
  config: Config;
  /** The artifact bucket: embed artifacts are read from it and tree artifacts written to it. */
  storage: SummaryTreeStorage;
  runner?: CommandRunner;
  /** A crashed worker's job is resumed by another once its lease expires. */
  leaseMs?: number;
  batchSize?: number;
  documentConcurrency?: number;
  /** Model calls in flight at once across the job (`WORKER_SUMMARY_TREE_CONCURRENCY`). */
  concurrency?: number;
  parkMs?: number;
  probeTtlMs?: number;
  /** Replaces the deployment's balance probe. Null: no probe. */
  balanceProbe?: ProviderBalanceProbe | null;
  env?: Env;
  /** Model, embedder and storage seams of the build (tests). */
  overrides?: SummaryTreeOverrides;
  /** Replaces `SUMMARY_TREE_BUILD_STALE_MS` in the document selection (tests). */
  buildStaleMs?: number;
}

type JobRow = {
  id: string;
  org_id: string;
  project_id: string;
  user_id: string;
  max_cost_cents: number | string;
  cost_cents: number | string;
  cursor: string | null;
  estimate: { costCents?: number; modelCalls?: number } | null;
};

type DocumentRow = {
  id: string;
  user_id: string;
  run_id: string;
  filename: string | null;
  mime_type: string | null;
  storage_prefix: string | null;
  pii_blocked: boolean;
  embed_artifact_uri: string | null;
  has_tree: boolean;
  /** The document's `building` row is this job's own, from an earlier claim. */
  own_build: boolean;
  chunk_count: number;
};

type Outcome = "ready" | "skipped" | "partial";
type Halt =
  | { kind: "park"; reason: SummaryTreeJobBlockedReason }
  | { kind: "finish"; status: "cancelled"; note: string }
  | { kind: "lease-lost" };

const claimable = (sql: Client) => sql`(
  status = 'queued'
  or (status = 'running' and lease_expires_at < now())
  or (status = 'blocked' and (resume_after is null or resume_after <= now()))
)`;

const interval = (ms: number) => `${Math.max(0, Math.round(ms))} milliseconds`;

/** `blocked` reasons of a build that made no call, as the job's parking reason. */
function blockedReason(reason: string | undefined): SummaryTreeJobBlockedReason {
  return reason === "privacy-mode" || reason === "no-text-model-key" ? "policy" : "credits";
}

/**
 * Claims one queued, parked or lease-expired summary tree job and runs it until it ends, parks or loses its lease.
 * Returns the number of jobs it ran (0 or 1); a job parked before the claim counts as 0.
 */
export async function runSummaryTreeJobs(sql: Client, options: SummaryTreeJobRunnerOptions): Promise<number> {
  const env = options.env ?? options.overrides?.env ?? process.env;
  const leaseMs = options.leaseMs ?? SUMMARY_TREE_JOB_DEFAULT_LEASE_MS;
  const parkMs = options.parkMs ?? SUMMARY_TREE_JOB_DEFAULT_PARK_MS;
  const [candidate] = await sql<{ id: string; project_id: string }[]>`
    select id, project_id from summary_tree_jobs where ${claimable(sql)} order by created_at limit 1
  `;
  if (!candidate) return 0;

  /** Parks the candidate without taking its lease. */
  const parkUnclaimed = async (reason: SummaryTreeJobBlockedReason, waitMs = parkMs) => {
    await sql`
      update summary_tree_jobs
      set status = 'blocked', blocked_reason = ${reason}, resume_after = now() + ${interval(waitMs)}::interval,
          lease_owner = null, lease_expires_at = null, updated_at = now()
      where id = ${candidate.id} and ${claimable(sql)}
    `;
    console.log(`[summary-tree-job] parked job=${candidate.id} project=${candidate.project_id} reason=${reason} before=claim`);
  };

  // Both kill switches, before the claim. Build off: nothing is claimed and nothing is called.
  if (!summaryTreeBuildAvailable(env)) {
    await parkUnclaimed("build-off");
    return 0;
  }
  const probe = options.balanceProbe === undefined ? await providerBalanceProbe(env) : options.balanceProbe;
  const gate = balanceGate(probe, options.probeTtlMs ?? SUMMARY_TREE_JOB_DEFAULT_PROBE_TTL_MS);
  const first = probe ? await gate.check(await candidateRouteLabels(sql, candidate.project_id, options.config)) : { sufficient: true };
  if (!first.sufficient) {
    await parkUnclaimed("balance", first.retryAfterSeconds ? first.retryAfterSeconds * 1_000 : parkMs);
    return 0;
  }

  const [job] = await sql<JobRow[]>`
    update summary_tree_jobs
    set status = 'running', blocked_reason = null, resume_after = null,
        lease_owner = ${options.workerId},
        lease_expires_at = now() + ${interval(leaseMs)}::interval,
        started_at = coalesce(started_at, now()),
        updated_at = now()
    where id = (
      select id from summary_tree_jobs where id = ${candidate.id} and ${claimable(sql)} for update skip locked
    )
    returning id, org_id, project_id, user_id, max_cost_cents, cost_cents, cursor, estimate
  `;
  if (!job) return 0;

  try {
    const providers = await projectProviderScope(sql, job.project_id);
    await runWithPrivacyAuditScope({ projectId: job.project_id },
      () => runWithProviderRateScope(providers, () => runClaimedJob(sql, job, { ...options, env, leaseMs, parkMs }, gate)));
  } catch (error) {
    // The first line only, to the worker log and the job row; API callers get closed copy (raw errors stay in telemetry).
    const message = error instanceof Error ? error.message.split("\n")[0] ?? "" : String(error);
    console.error(`[summary-tree-job] failed job=${job.id} project=${job.project_id} error=${message}`);
    await sql`
      update summary_tree_jobs
      set status = 'failed', error = ${message.slice(0, 2000)}, finished_at = now(), updated_at = now(),
          lease_owner = null, lease_expires_at = null
      where id = ${job.id} and lease_owner = ${options.workerId}
    `;
  }
  return 1;
}

/**
 * The usage-ledger labels of the summary route the candidate's project would call, for the probe before the claim.
 * A project whose pipeline cannot be resolved here is asked about under the deployment's default text route; the
 * claimed job resolves (and polices) the route again.
 */
async function candidateRouteLabels(sql: Client, projectId: string, config: Config): Promise<{ provider: string; model: string }> {
  try {
    const [project] = await sql<{ pipeline: unknown }[]>`select pipeline from projects where id = ${projectId}`;
    if (project) {
      const pipeline = normalizeStoredPipelineFeatures(project.pipeline as PipelineFeatures, `project ${projectId}`);
      return textUsageLabels(resolveAllowedPipelineTextModel(pipeline, SUMMARY_TREE_TEXT_OPERATION, config.textGenerationModel));
    }
  } catch { /* the default route below */ }
  return textUsageLabels(config.textGenerationModel ?? "");
}

function balanceGate(probe: ProviderBalanceProbe | null, ttlMs: number) {
  let goodUntil = 0;
  return {
    async check(labels: { provider: string; model: string }): Promise<{ sufficient: boolean; retryAfterSeconds?: number }> {
      if (!probe) return { sufficient: true };
      if (Date.now() < goodUntil) return { sufficient: true };
      const reading = await readProviderBalance(probe, { ...labels, purpose: "summary-tree-backfill" });
      if (reading.sufficient) goodUntil = Date.now() + ttlMs;
      return reading;
    },
  };
}

async function runClaimedJob(
  sql: Client,
  job: JobRow,
  options: SummaryTreeJobRunnerOptions & { env: Env; leaseMs: number; parkMs: number },
  gate: ReturnType<typeof balanceGate>,
): Promise<void> {
  const { env, leaseMs, parkMs, workerId, config } = options;
  const scope = { orgId: job.org_id, projectId: job.project_id };
  // The builder name on a document's `building` row: the job, then this claim. A worker that lost the lease still
  // carries the earlier claim's name, so nothing it writes after the takeover lands on the new holder's rows.
  const ownerPrefix = `job:${job.id}#`;
  const owner = `${ownerPrefix}${randomUUID()}`;
  const cap = Number(job.max_cost_cents);
  if (!(cap > 0)) throw new Error("summary tree job has no cost cap");

  // --- Job row writes. Counters and the cursor move only while this worker holds the lease. ---
  let leaseLost = false;
  let cancelRequested = false;
  const abort = new AbortController();
  const renewLease = async (): Promise<void> => {
    if (leaseLost) return;
    const [row] = await sql<{ cancel_requested_at: Date | null }[]>`
      update summary_tree_jobs
      set lease_expires_at = now() + ${interval(leaseMs)}::interval, updated_at = now()
      where id = ${job.id} and lease_owner = ${workerId} and status = 'running'
      returning cancel_requested_at
    `;
    if (!row) {
      leaseLost = true;
      console.warn(`[summary-tree-job] lease lost job=${job.id}`);
      return;
    }
    if (row.cancel_requested_at) cancelRequested = true;
  };
  const leaseTimer = setInterval(() => { void renewLease().catch(() => undefined); }, Math.max(1, Math.floor(leaseMs / 3)));
  leaseTimer.unref?.();

  const finish = async (status: "completed" | "cancelled", note: string | null) => {
    await sql`
      update summary_tree_jobs
      set status = ${status}, error = ${note}, blocked_reason = null, resume_after = null, finished_at = now(), updated_at = now(),
          lease_owner = null, lease_expires_at = null
      where id = ${job.id} and lease_owner = ${workerId}
    `;
    console.log(`[summary-tree-job] ${status} job=${job.id} project=${job.project_id}${note ? ` note="${note}"` : ""}`);
  };
  const park = async (reason: SummaryTreeJobBlockedReason, waitMs = parkMs) => {
    await sql`
      update summary_tree_jobs
      set status = 'blocked', blocked_reason = ${reason}, resume_after = now() + ${interval(waitMs)}::interval,
          lease_owner = null, lease_expires_at = null, updated_at = now()
      where id = ${job.id} and lease_owner = ${workerId}
    `;
    console.log(`[summary-tree-job] parked job=${job.id} project=${job.project_id} reason=${reason}`);
  };

  // --- Spend. Recorded per call; the cap is checked against it before every call. ---
  let spentCents = Number(job.cost_cents);
  let inFlight = 0;
  // Until a call has reported its cost the reserve is unknown: calls are admitted one at a time.
  const estimatedCallCents = job.estimate?.costCents && job.estimate.modelCalls ? job.estimate.costCents / job.estimate.modelCalls : 0;
  let largestCallCents = estimatedCallCents > 0 ? estimatedCallCents : null as number | null;
  let settled: Array<() => void> = [];
  const wake = () => { const waiting = settled; settled = []; for (const resolve of waiting) resolve(); };
  const reserved = () => (largestCallCents === null ? (inFlight > 0 ? Number.POSITIVE_INFINITY : 0) : inFlight * largestCallCents * RESERVE_FACTOR);
  const acquireCall = async (): Promise<() => void> => {
    // Wait while calls in flight could still take the job past its cap; with none in flight the next call is the one
    // the cap is allowed to be passed by.
    while (inFlight > 0 && spentCents < cap && spentCents + reserved() >= cap && !leaseLost && !cancelRequested) {
      await new Promise<void>((resolve) => settled.push(resolve));
    }
    inFlight += 1;
    return () => { inFlight -= 1; wake(); };
  };
  let halt: Halt | null = null;
  const stopReason = (): string | null => {
    if (leaseLost) return "lease-lost";
    if (cancelRequested) return "cancelled";
    if (halt) return "job-halted";
    return spentCents >= cap ? "cost-cap" : null;
  };

  let persisting: Promise<void> = Promise.resolve();
  let persistError: unknown = null;
  const record = (input: WorkerAiUsageInput) => {
    const inputTokens = input.inputTokens ?? 0;
    const outputTokens = input.outputTokens ?? 0;
    const costCents = input.costCents ?? 0;
    const isModelCall = input.metric === SUMMARY_TREE_USAGE_METRIC;
    console.log(`[ai-usage] ${input.metric} model=${input.model} input_tokens=${inputTokens}${input.logOutputTokens === false ? "" : ` output_tokens=${outputTokens}`}`);
    // The cap sees the call the moment it returns, before anything is awaited.
    spentCents += costCents;
    // Known from the first call on, also when calls cost nothing (an unpriced deployment reserves nothing).
    if (isModelCall) largestCallCents = Math.max(largestCallCents ?? 0, costCents);
    persisting = persisting.then(async () => {
      try {
        await sql.begin(async (tx) => {
          const client = tx as unknown as Client;
          await persistScopedUsageEvents({
            client,
            userId: job.user_id,
            scope,
            usageEvents: [{
              id: randomUUID(),
              provider: input.provider,
              model: input.model,
              metric: input.metric,
              amount: input.amount ?? inputTokens + outputTokens,
              unit: input.unit ?? "token",
              costCents,
              inputTokens,
              outputTokens,
              metadata: { ...input.metadata, summaryTreeJobId: job.id },
            }],
            debitMetadata: { summaryTreeJobId: job.id },
          });
          // Not fenced by the lease: the call was paid for, whoever holds the job now.
          const [row] = await client<{ cancel_requested_at: Date | null; lease_owner: string | null }[]>`
            update summary_tree_jobs
            set cost_cents = cost_cents + ${costCents}, input_tokens = input_tokens + ${inputTokens},
                output_tokens = output_tokens + ${outputTokens}, model_calls = model_calls + ${isModelCall ? 1 : 0}, updated_at = now()
            where id = ${job.id}
            returning cancel_requested_at, lease_owner
          `;
          if (row?.cancel_requested_at) cancelRequested = true;
          if (row && row.lease_owner !== workerId) leaseLost = true;
        });
      } catch (error) {
        // A call whose usage could not be recorded ends the job: nothing more is spent unrecorded.
        persistError ??= error;
        abort.abort(error);
      }
    });
  };
  const flush = async () => {
    await persisting;
    if (persistError) throw persistError instanceof Error ? persistError : new Error("summary tree usage could not be recorded");
  };

  try {
    const [project] = await sql<{ pipeline: unknown }[]>`
      select pipeline from projects where id = ${job.project_id} and org_id = ${job.org_id}
    `;
    if (!project) throw new Error("Project no longer exists");
    const pipeline: PipelineFeatures = normalizeStoredPipelineFeatures(project.pipeline as PipelineFeatures, `project ${job.project_id}`);
    if (!summaryTreeEnabled(pipeline) || summaryTreeVectorProblem(pipeline)) {
      await finish("cancelled", SUMMARY_TREE_JOB_NOTES.disabled);
      return;
    }
    const model = resolveAllowedPipelineTextModel(pipeline, SUMMARY_TREE_TEXT_OPERATION, config.textGenerationModel);
    const labels = textUsageLabels(model);
    const profile = resolveEmbeddingModel(config, pipeline);
    const space = { model: profile.model, dimensions: profile.dimensions };
    // One decision for the job: outside `standard` privacy mode a hosted summary model is not called.
    const hostedAllowed = options.overrides?.summarize ? true : await allowHostedCallForProject(sql, {
      privacyMode: pipeline.privacyMode, projectId: job.project_id, call: openRouterTextCall(SUMMARY_TREE_TEXT_OPERATION, model),
    });
    if (!hostedAllowed) {
      await park("policy");
      return;
    }
    const concurrency = Math.max(1, options.concurrency ?? options.overrides?.concurrency ?? summaryTreeConcurrency(env));
    const callLimiter = createConcurrencyLimiter(concurrency);
    const batchSize = Math.max(1, options.batchSize ?? SUMMARY_TREE_JOB_DEFAULT_BATCH_SIZE);
    const documentConcurrency = Math.max(1, options.documentConcurrency ?? SUMMARY_TREE_JOB_DEFAULT_DOCUMENT_CONCURRENCY);
    const staleMs = options.buildStaleMs ?? options.overrides?.buildStaleMs ?? SUMMARY_TREE_BUILD_STALE_MS;
    let cursor = job.cursor;
    let consecutiveErrors = 0;
    console.log(`[summary-tree-job] started job=${job.id} project=${job.project_id} serve=${summaryTreeServeAvailable(env) ? "on" : "off"}`);

    /** Builds one document; the outcome it is counted under, or null when the job has to stop first. */
    const buildDocument = async (document: DocumentRow): Promise<{ outcome: Outcome; result?: SummaryTreeBuildResult } | null> => {
      const runRoot = document.storage_prefix ?? `${document.user_id}/${document.run_id}`;
      for (let attempt = 1; ; attempt++) {
        let result: SummaryTreeBuildResult;
        try {
          result = await runSummaryTreeForDocument({
            sql,
            storage: options.storage,
            config,
            runner: options.runner,
            pipeline,
            scope,
            runId: document.run_id,
            runRoot,
            document: {
              id: document.id,
              normalizedFormat: detectFileFormat({ filename: document.filename, mimeType: document.mime_type }),
              mimeType: document.mime_type,
              chunkCount: document.chunk_count,
              piiBlocked: document.pii_blocked,
            },
            embeddingArtifactUri: document.embed_artifact_uri ?? options.storage.uri(`${runRoot}/embeddings/${document.id}.json`),
            usage: { record, flush },
            // The job decided once; the build asks before its first call.
            hostedCallRefusal: async () => null,
            stopReason,
            acquireCall,
            callLimiter,
            owner,
            // A build of this job's earlier claim is this job's to resume; any other live build is left alone.
            takeOverLiveBuild: document.own_build,
            signal: abort.signal,
            overrides: { ...options.overrides, env, buildStaleMs: staleMs },
          });
        } finally {
          await persisting;
        }
        if (result.artifactUri) {
          // Where the delete paths and the next version's reuse lookup find the text.
          await registerSummaryTreeArtifact(sql, { scope, documentId: document.id, runId: document.run_id, artifactUri: result.artifactUri, stats: { ...result.stats } })
            .catch((error: unknown) => {
              if (!(error instanceof Error && error.name === "SummaryTreeStateRefused")) throw error;
            });
        }
        console.log(
          `[summary-tree-job] job=${job.id} document=${document.id} status=${result.status}` +
            `${result.skipReason ? ` skip=${result.skipReason}` : ""}${result.reason ? ` reason=${result.reason}` : ""}` +
            ` leaves=${result.stats.leaves} nodes=${result.stats.nodes} model_calls=${result.stats.modelCalls}` +
            ` reused_resume=${result.stats.reusedFromResume} failed_groups=${result.stats.failedGroups}`,
        );
        switch (result.status) {
          case "ready": return { outcome: "ready", result };
          case "skipped": return { outcome: "skipped", result };
          case "off":
            halt ??= { kind: "park", reason: "build-off" };
            return null;
          case "refused":
            await removeIfGone(document, runRoot);
            return { outcome: "skipped", result };
          case "blocked":
            // Another build holds it and still reports: left to that build (and to the next job if it dies).
            if (result.reason === "build-in-progress") return { outcome: "partial", result };
            halt ??= { kind: "park", reason: blockedReason(result.reason) };
            return null;
          case "partial": {
            const reason = result.reason ?? "";
            if (reason === "stopped:build-switch-off") halt ??= { kind: "park", reason: "build-off" };
            else if (reason === "stopped:cost-cap") halt ??= { kind: "finish", status: "cancelled", note: SUMMARY_TREE_JOB_NOTES.costCap };
            else if (reason === "stopped:cancelled") halt ??= { kind: "finish", status: "cancelled", note: SUMMARY_TREE_JOB_NOTES.cancelled };
            else if (reason === "stopped:lease-lost") halt ??= { kind: "lease-lost" };
            // Stopped by the job itself (its own halt or another document's): not finished, the cursor stays before it.
            if (halt && reason.startsWith("stopped:") && reason !== "stopped:build-taken-over") return null;
            // A failed group: the build already retried it once; one more pass pays only for what is still missing.
            if (reason.startsWith("group-failed:") && attempt === 1 && !stopReason()) continue;
            return { outcome: "partial", result };
          }
        }
      }
    };

    /**
     * A document that left the project while its tree was being built leaves nothing behind: the delete removed its
     * state and registry rows, and what this build wrote after that (summary rows, artifact parts) is removed here.
     * A document that still exists (superseded or archived) is left to the purge paths, which own its rows.
     */
    const removeIfGone = async (document: DocumentRow, runRoot: string) => {
      const [live] = await sql<{ id: string }[]>`select id from documents where id = ${document.id} and org_id = ${job.org_id} and project_id = ${job.project_id}`;
      if (live) return;
      await (options.overrides?.deleteDocumentRows ?? deleteDocumentSummaryRows)({ scope, space, documentIds: [document.id], root: options.overrides?.lanceRoot });
      const listed = await options.storage.listKeys({ prefix: `${summaryTreeArtifactRoot(runRoot, document.id)}/`, maxKeys: 100_000 });
      if (listed.keys.length > 0) await options.storage.deleteKeys(listed.keys);
      console.log(`[summary-tree-job] job=${job.id} document=${document.id} removed=rows-of-deleted-document artifacts=${listed.keys.length}`);
    };

    for (;;) {
      // --- Gates, every batch. ---
      await renewLease();
      if (leaseLost) return;
      if (cancelRequested) {
        await finish("cancelled", SUMMARY_TREE_JOB_NOTES.cancelled);
        return;
      }
      if (!summaryTreeBuildAvailable(env)) {
        await park("build-off");
        return;
      }
      if (!summaryTreeServeAvailable(env)) {
        // Building while search does not read trees yet is a normal rollout order; it is logged, not a reason to stop.
        console.log(`[summary-tree-job] job=${job.id} note=serve-switch-off flag=${SUMMARY_TREE_SERVE_ENV_FLAG}`);
      }
      const balance = await gate.check(labels);
      if (!balance.sufficient) {
        await park("balance", balance.retryAfterSeconds ? balance.retryAfterSeconds * 1_000 : parkMs);
        return;
      }
      if (spentCents >= cap) {
        await finish("cancelled", SUMMARY_TREE_JOB_NOTES.costCap);
        return;
      }

      // --- The next documents of this project without a servable tree, in id order. ---
      // A corrected document is never selected: the correction leaves its state row `skipped` (state-store.ts), and
      // a `skipped` row of the document's current run ends the selection below. The corrections table itself is not
      // readable by the worker's database role.
      const documents = await sql<DocumentRow[]>`
        select d.id, d.user_id, d.run_id, d.filename, d.mime_type, r.storage_prefix,
          coalesce((d.metadata->'pii'->>'blocked')::boolean, false) as pii_blocked,
          e.artifact_uri as embed_artifact_uri,
          exists (select 1 from document_summary_trees t where t.document_id = d.id) as has_tree,
          exists (
            select 1 from document_summary_trees t
            where t.document_id = d.id and t.status = 'building' and starts_with(coalesce(t.build_owner, ''), ${ownerPrefix})
          ) as own_build,
          coalesce(
            case when jsonb_typeof(e.stats->'chunks') = 'number' then (e.stats->>'chunks')::numeric::int end,
            (select count(*)::int from document_chunks c where c.document_id = d.id)
          ) as chunk_count
        from documents d
        join project_runs r on r.id = d.run_id and r.project_id = d.project_id
        left join document_run_stage_states e
          on e.run_id = d.run_id and e.document_id = d.id and e.stage_name = 'embed' and e.status = 'completed'
        where d.org_id = ${job.org_id} and d.project_id = ${job.project_id}
          and d.status = 'completed' and d.superseded_at is null and d.purged_at is null and d.archived_at is null
          and (${cursor}::text is null or d.id > ${cursor})
          and not exists (
            select 1 from document_summary_trees t
            where t.document_id = d.id and t.org_id = d.org_id and t.project_id = d.project_id and t.run_id = d.run_id
              and (
                t.status = 'skipped'
                or (t.status = 'ready' and t.built_at is not null
                  and t.embedding_model = ${space.model} and t.dimension = ${space.dimensions})
                or (t.status = 'building' and not starts_with(coalesce(t.build_owner, ''), ${ownerPrefix})
                  and t.updated_at > now() - ${interval(staleMs)}::interval)
              )
          )
        order by d.id
        limit ${batchSize}
      `;
      if (documents.length === 0) {
        await flush();
        await finish("completed", null);
        return;
      }

      // --- The many small documents: one statement, no artifact read. ---
      const outcomes = new Map<string, { outcome: Outcome; nodes: number } | null>();
      const small = documents.filter((document) => !document.has_tree && document.chunk_count < SUMMARY_TREE_MIN_DOCUMENT_LEAVES);
      if (small.length > 0) {
        await markSummaryTreesSkipped(sql, { scope, documentIds: small.map((document) => document.id), skipReason: "short" });
        // One that was not marked got a state row or left the project meanwhile: either way this job is done with it.
        for (const document of small) outcomes.set(document.id, { outcome: "skipped", nodes: 0 });
      }

      // --- The rest, a few at a time, sharing the job's call slots. ---
      const large = documents.filter((document) => !outcomes.has(document.id));
      let next = 0;
      let fatal: unknown = null;
      const worker = async () => {
        while (next < large.length && !halt && !leaseLost && !cancelRequested && !fatal) {
          const document = large[next++]!;
          try {
            const built = await buildDocument(document);
            outcomes.set(document.id, built ? { outcome: built.outcome, nodes: built.result?.stats.generatedNodes ?? 0 } : null);
            if (built) consecutiveErrors = 0;
          } catch (error) {
            // Unrecorded usage, an aborted job, or one failure after another: the job itself fails. Otherwise the
            // fault is this document's (an unreadable artifact, say): it stays unserved for a later job, and the
            // rest of the project is still built. The error's name only; its message may quote the document.
            consecutiveErrors += 1;
            if (persistError || abort.signal.aborted || consecutiveErrors >= MAX_CONSECUTIVE_DOCUMENT_ERRORS) {
              fatal ??= error;
              abort.abort(error);
              return;
            }
            console.warn(`[summary-tree-job] document failed job=${job.id} document=${document.id} error=${error instanceof Error ? error.name : "error"}`);
            outcomes.set(document.id, { outcome: "partial", nodes: 0 });
          }
        }
      };
      // Every worker settles before anything else happens: no build keeps running behind a failed job.
      await Promise.allSettled(Array.from({ length: Math.min(documentConcurrency, Math.max(1, large.length)) }, worker));
      if (fatal) throw fatal;
      await flush();

      // --- Progress: the documents of the batch's finished prefix, with the cursor, in one fenced write. ---
      const delta = { ready: 0, skipped: 0, partial: 0, nodes: 0 };
      let reached = cursor;
      for (const document of documents) {
        const done = outcomes.get(document.id);
        if (!done) break;
        delta[done.outcome] += 1;
        delta.nodes += done.nodes;
        reached = document.id;
      }
      const [state] = await sql<{ cancel_requested_at: Date | null }[]>`
        update summary_tree_jobs
        set documents_ready = documents_ready + ${delta.ready},
            documents_skipped = documents_skipped + ${delta.skipped},
            documents_partial = documents_partial + ${delta.partial},
            nodes_built = nodes_built + ${delta.nodes},
            cursor = ${reached},
            lease_expires_at = now() + ${interval(leaseMs)}::interval,
            updated_at = now()
        where id = ${job.id} and lease_owner = ${workerId}
        returning cancel_requested_at
      `;
      if (!state || leaseLost) {
        console.warn(`[summary-tree-job] lease lost job=${job.id}`);
        return;
      }
      cursor = reached;
      if (state.cancel_requested_at || cancelRequested) {
        await finish("cancelled", SUMMARY_TREE_JOB_NOTES.cancelled);
        return;
      }
      const stopped = halt as Halt | null;
      if (stopped?.kind === "lease-lost") return;
      if (stopped?.kind === "finish") {
        await finish(stopped.status, stopped.note);
        return;
      }
      if (stopped?.kind === "park") {
        await park(stopped.reason);
        return;
      }
    }
  } finally {
    clearInterval(leaseTimer);
    wake();
    await persisting;
  }
}

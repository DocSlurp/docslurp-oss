import {
  isPrivateModelUri,
  resolveAllowedPipelineTextModel,
  resolvePipelineTextGenerationOptions,
  resolveSupportedModelIdWithWarning,
  SUMMARY_TREE_BUILD_ENV_FLAG,
  summaryTreeBuildActive,
  summaryTreeEnabled,
  type PipelineFeatures,
} from "@docslurp/shared";
import type { Sql } from "postgres";

import type { Config } from "../config.js";
import { orgSpendRefusal } from "../db/spend-check.js";
import { resolveEmbeddingModel } from "../embeddings/resolver.js";
import { generateOpenRouterText } from "../lib/ai.js";
import type { WorkerAiUsageInput } from "../lib/ai-usage.js";
import { artifactReadFailureKind } from "../lib/artifact-read-error.js";
import { runArtifactRoot } from "../lib/artifact-root.js";
import { createConcurrencyLimiter, type ConcurrencyLimiter } from "../lib/bounded-concurrency.js";
import { allowHostedCall, openRouterTextCall } from "../lib/privacy-guard.js";
import { runWithProviderRateLimit } from "../lib/provider-rate-limit.js";
import { toProviderRetryableError } from "../lib/provider-retry.js";
import { textFallbackCost, textModelApiKey, textUsageLabels } from "../lib/text-model-route.js";
import { noteWorkProgress } from "../lib/work-progress.js";
import { isCostCapExceeded, runDocumentStage, runDocuments } from "../pipeline/checkpoints.js";
import { hasFailedDocumentStage } from "../pipeline/document-health.js";
import { isPiiBlockedDocument } from "../pipeline/pii-gate.js";
import type { Stage, WorkflowState } from "../pipeline/pipeline.js";
import {
  buildDocumentSummaryTree,
  SUMMARY_TREE_REASONING_EFFORT,
  SUMMARY_TREE_TEXT_OPERATION,
  summaryOutputTokenBudget,
  type SummaryCallUsage,
  type SummaryTreeArtifactIO,
  type SummaryTreeBuildDeps,
  type SummaryTreeBuildResult,
  type SummaryTreeEmbedder,
  type SummaryTreeLimits,
  type SummaryTreeModel,
  type SummaryTreeUsageDetail,
} from "../summary-tree/index.js";
import { DEFAULT_SUMMARY_TREE_LIMITS } from "../summary-tree/limits.js";
import type { CommandRunner } from "../tools/runner.js";
import { keyFromStorageUri } from "../tools/storage.js";
import { embedTextChunks, embeddingCallCostCents, estimateTokens } from "./embedding-runtime.js";
import { deleteDocumentSummaryRows, deleteSummaryRowsById, scheduleSummariesMaintenance, writeSummaryRows } from "./lancedb-summaries.js";

/**
 * The `summary-tree` stage: section summaries of long documents (packages/shared summary-tree.ts,
 * docs/summary-tree.md).
 *
 * It is the last stage of a run, after `index`, so a document is searchable before its tree is built. It runs only
 * when the project turned the tree on, the pipeline embeds and indexes vectors and the deployment's build switch
 * (`DOCSLURP_SUMMARY_TREE_BUILD`) is on; otherwise it makes no model call and writes nothing.
 *
 * "The project turned the tree on" is read twice. The run's own pipeline is a snapshot from when the run was created
 * (the API stamps it with the project's stored setting, also on reprocess and retry). The project's stored setting is
 * then read again before every document: a project that turned the tree off after the run was created, or whose run
 * replays an older snapshot, builds nothing more.
 *
 * This file is the adapter: the model route (fleet rate limiter, privacy mode, lowest reasoning), the embedder,
 * the usage ledger and the spend decision. The build itself is `buildDocumentSummaryTree` (summary-tree/build.ts),
 * which the backfill job calls through `runSummaryTreeForDocument` as well.
 */

export const SUMMARY_TREE_STAGE = "summary-tree";
/** Usage metric of one summary model attempt. */
export const SUMMARY_TREE_USAGE_METRIC = "summary-tree-generation";
/** Usage metric of one summary embedding request. */
export const SUMMARY_TREE_EMBEDDING_USAGE_METRIC = "summary-tree-embedding";
/** Model calls in flight at once across the stage (`WORKER_SUMMARY_TREE_CONCURRENCY`). */
export const SUMMARY_TREE_DEFAULT_CONCURRENCY = 4;
/**
 * How long one stage activity keeps starting model calls (`WORKER_SUMMARY_TREE_STAGE_BUDGET_SECONDS`). The stage's
 * activity has the ordinary stage timeout, and a run must not fail or wait hours on an optional index: past the
 * budget, a document in progress ends `partial` (its committed groups are kept and a later build resumes them) and
 * a document not started is left without a tree for the backfill job.
 */
export const SUMMARY_TREE_DEFAULT_STAGE_BUDGET_MS = 20 * 60_000;
/** Documents built at once inside one stage activity. */
const SUMMARY_TREE_MAX_DOCUMENT_CONCURRENCY = 4;
/** The stage flushes its usage to the run at most this often; the run's stage checkpoint flushes the rest. */
const USAGE_FLUSH_INTERVAL_MS = 2_000;
/** A tree artifact object larger than this is not read (a pack holds a few kilobytes per node). */
const ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
/** Requests the fleet limiter retries inline on a throttled or unavailable provider before the group fails. */
const MODEL_REQUEST_RETRIES = 2;

type Client = Sql<Record<string, unknown>>;
type Env = Readonly<Record<string, string | undefined>>;

/** The object-storage calls the stage needs; `ArtifactStore` provides them. */
export interface SummaryTreeStorage {
  readonly bucket: string;
  uri(key: string): string;
  getBytes(key: string, options?: { maxBytes?: number }): Promise<Buffer>;
  putBytes(key: string, data: Uint8Array, contentType: string): Promise<void>;
  listKeys(options?: { prefix?: string; maxKeys?: number }): Promise<{ keys: string[]; truncated: boolean }>;
  deleteKeys(keys: string[]): Promise<void>;
  openStream(key: string, signal?: AbortSignal): Promise<{ stream: AsyncIterable<Uint8Array> }>;
}

/** Test and job seams. Production passes none. */
export interface SummaryTreeOverrides {
  /** Replaces the model route. No provider request is made. */
  summarize?: SummaryTreeModel;
  /** Replaces the embedding route. */
  embed?: SummaryTreeEmbedder;
  writeRows?: SummaryTreeBuildDeps["writeRows"];
  deleteRowsById?: SummaryTreeBuildDeps["deleteRowsById"];
  deleteDocumentRows?: SummaryTreeBuildDeps["deleteDocumentRows"];
  /** Replaces the background compaction request made when a tree becomes ready. */
  tableChanged?: SummaryTreeBuildDeps["tableChanged"];
  lanceRoot?: string;
  tmpDirectory?: string;
  /** Replace the staleness age and heartbeat interval of a `building` row. */
  buildStaleMs?: number;
  heartbeatMs?: number;
  limits?: Partial<SummaryTreeLimits>;
  env?: Env;
  concurrency?: number;
  /** Replaces the stage's time budget and clock. */
  stageBudgetMs?: number;
  now?: () => number;
}

/** The text artifact's storage calls over the run bucket. A missing object is null; an incomplete listing throws. */
export function summaryTreeArtifactIO(storage: SummaryTreeStorage): SummaryTreeBuildDeps["artifacts"] {
  const io: SummaryTreeArtifactIO = {
    async getText(key) {
      try {
        return (await storage.getBytes(key, { maxBytes: ARTIFACT_MAX_BYTES })).toString("utf8");
      } catch (error) {
        if (artifactReadFailureKind(error) === "missing") return null;
        throw error;
      }
    },
    async putText(key, text) {
      await storage.putBytes(key, Buffer.from(text, "utf8"), "application/x-ndjson");
    },
    async listKeys(prefix) {
      const listed = await storage.listKeys({ prefix, maxKeys: 100_000 });
      if (listed.truncated) throw new Error("summary tree artifact listing is incomplete");
      return listed.keys;
    },
    async deleteKeys(keys) {
      if (keys.length > 0) await storage.deleteKeys(keys);
    },
  };
  return { ...io, uri: (key) => storage.uri(key), keyFromUri: (uri) => keyFromStorageUri(uri, storage.bucket) };
}

/**
 * The project's stored `pipeline.summaryTree.enabled`, read now. Fails closed: a project that does not exist, is not
 * this organization's, or stores anything but an explicit `true` is off.
 */
export async function projectSummaryTreeEnabled(sql: Client, scope: { orgId: string; projectId: string }): Promise<boolean> {
  const [row] = await sql<{ enabled: boolean | null }[]>`
    select (pipeline -> 'summaryTree' -> 'enabled') = 'true'::jsonb as enabled
    from projects where id = ${scope.projectId} and org_id = ${scope.orgId}
  `;
  return row?.enabled === true;
}

export function summaryTreeConcurrency(env: Env = process.env): number {
  const parsed = Number.parseInt(env.WORKER_SUMMARY_TREE_CONCURRENCY ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 32) : SUMMARY_TREE_DEFAULT_CONCURRENCY;
}

export function summaryTreeStageBudgetMs(env: Env = process.env): number {
  const seconds = Number.parseFloat(env.WORKER_SUMMARY_TREE_STAGE_BUDGET_SECONDS ?? "");
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : SUMMARY_TREE_DEFAULT_STAGE_BUDGET_MS;
}

export interface SummaryTreeDocumentRun {
  sql: Client;
  storage: SummaryTreeStorage;
  config: Config;
  runner?: CommandRunner;
  /** The project's pipeline (the run's snapshot, or the project's current settings for a backfill). */
  pipeline: PipelineFeatures;
  scope: { orgId: string; projectId: string };
  /** The run the summary rows are stamped with: the run that indexed the document's current chunks. */
  runId: string;
  /** `<run root>` of that run (`runArtifactRoot` / `documentArtifactRoot`); the text artifact goes under it. */
  runRoot: string;
  document: { id: string; normalizedFormat?: string | null; mimeType?: string | null; chunkCount?: number | null; piiBlocked?: boolean };
  /** The embed stage's artifact for this document (its `embed` checkpoint's `artifactUri`). */
  embeddingArtifactUri: string | null;
  /** Records usage with the caller's scope. Every model attempt and every embedding request goes through it. */
  usage: { record(input: WorkerAiUsageInput): void; flush?(): Promise<void> };
  /** A named reason hosted calls are not allowed for this project (privacy mode), or null. */
  hostedCallRefusal?: () => Promise<string | null>;
  /**
   * Replaces the organization balance check (the default reads `org_spend_status`). Like the default, it is asked
   * before the first model call and again before every commit window of the build.
   */
  spendRefusal?: () => Promise<string | null>;
  /**
   * A named reason of the caller's own to refuse or stop the build (the run was paused or cancelled, the project
   * turned the tree off), or null. Asked with the balance check: before the first call and before every window.
   */
  gate?: () => Promise<string | null>;
  /** A named reason to stop before the next model call (the caller's cost cap), or null. */
  stopReason?: () => string | null;
  /** Admission of one model call (may wait); the returned function is called when the call has settled. */
  acquireCall?: () => Promise<() => void>;
  /** Who builds (`job:<jobId>`); default `run:<runId>`. */
  owner?: string;
  /** False: leave a document another builder is working on (`blocked`, `build-in-progress`). Default true. */
  takeOverLiveBuild?: boolean;
  /** Shares model-call slots with other documents built by the same caller. */
  callLimiter?: ConcurrencyLimiter;
  signal?: AbortSignal;
  overrides?: SummaryTreeOverrides;
}

/**
 * Builds (or resumes, or rebuilds) the summary tree of one document. The stage calls it for each document of a
 * run; a backfill job calls it for an already indexed document with that document's own run id, run root and
 * embed artifact, and must then register the returned `artifactUri` as the document's `summary-tree` stage
 * artifact (`document_run_stage_states`), which is where the purge paths and the next version's reuse lookup
 * find it.
 *
 * Returns without reading or writing anything (`status: "off"`) unless `summaryTreeBuildActive(pipeline, env)`.
 */
export async function runSummaryTreeForDocument(args: SummaryTreeDocumentRun): Promise<SummaryTreeBuildResult> {
  const overrides = args.overrides ?? {};
  const env = overrides.env ?? process.env;
  const buildActive = () => summaryTreeBuildActive(args.pipeline, env);
  const limits = overrides.limits;
  const lengthTargetWords = limits?.summaryLengthWords ?? DEFAULT_SUMMARY_TREE_LIMITS.summaryLengthWords;
  const { scope, document } = args;
  const artifacts = summaryTreeArtifactIO(args.storage);

  // Resolved (and policed) only when the build runs: an inert setting never fails on its model.
  const model = buildActive()
    ? resolveAllowedPipelineTextModel(args.pipeline, SUMMARY_TREE_TEXT_OPERATION, args.config.textGenerationModel)
    : "";
  const profile = buildActive() ? resolveEmbeddingModel(args.config, args.pipeline) : null;
  const settings = resolvePipelineTextGenerationOptions({
    operation: SUMMARY_TREE_TEXT_OPERATION,
    config: undefined,
    deploymentProfile: args.pipeline.textGeneration?.profile ?? args.config.textGenerationProfile,
    maxOutputTokens: summaryOutputTokenBudget(lengthTargetWords),
  });
  const labels = model ? textUsageLabels(model) : { provider: "openrouter", model: "" };
  const usageMetadata = { orgId: scope.orgId, projectId: scope.projectId, runId: args.runId, documentId: document.id, operation: SUMMARY_TREE_TEXT_OPERATION };

  const recordUsage = (usage: SummaryCallUsage, detail: SummaryTreeUsageDetail) => {
    args.usage.record({
      ...labels,
      metric: SUMMARY_TREE_USAGE_METRIC,
      amount: 1,
      unit: "node",
      costCents: usage.costCents ?? textFallbackCost({
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costPer1kInputTokens: args.config.costPer1kInputTokens,
        costPer1kOutputTokens: args.config.costPer1kOutputTokens,
      }).costCents,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      metadata: { ...usage.metadata, ...usageMetadata, nodeId: detail.nodeId, level: detail.level, attempt: detail.attempt, finishReason: detail.finishReason },
    });
  };

  const summarize: SummaryTreeModel = overrides.summarize ?? (async (request) => {
    const call = () => runWithProviderRateLimit({
      provider: labels.provider,
      model: labels.model,
      tokens: estimateTokens(request.system) + estimateTokens(request.prompt) + request.maxOutputTokens,
      label: "summary-tree request",
      signal: request.signal,
      maxRetries: MODEL_REQUEST_RETRIES,
      classify: (error) => toProviderRetryableError(error, labels.provider, "summary-tree request"),
      actualTokens: (result: { usage: { inputTokens: number; outputTokens: number } }) => result.usage.inputTokens + result.usage.outputTokens,
    }, () => generateOpenRouterText({
      operation: SUMMARY_TREE_TEXT_OPERATION,
      apiKey: textModelApiKey(args.config.openRouterApiKey, model),
      privacyMode: args.pipeline.privacyMode,
      model,
      maxOutputTokens: request.maxOutputTokens,
      // The tree's settings are the server's: the project's model choice applies, its reasoning effort and output
      // limits for other operations do not. Reasoning stays at the floor; a cut-off answer gets output tokens.
      textGeneration: {
        model: null,
        models: {},
        profile: settings.profile,
        reasoningEfforts: { [SUMMARY_TREE_TEXT_OPERATION]: SUMMARY_TREE_REASONING_EFFORT },
        maxOutputTokens: { [SUMMARY_TREE_TEXT_OPERATION]: request.maxOutputTokens },
      },
      deploymentProfile: settings.profile,
      system: request.system,
      prompt: request.prompt,
      signal: request.signal,
    }));
    const result = await (args.callLimiter ? args.callLimiter.run(call) : call());
    return { text: result.text, finishReason: result.finishReason, usage: result.usage };
  });

  const embed: SummaryTreeEmbedder = async (texts, signal) => {
    if (!profile) throw new Error("summary tree embedding has no profile");
    // An override replaces the provider request only: the usage of every embedding request is recorded here.
    const embedded = overrides.embed
      ? { vectors: await overrides.embed(texts, signal), totalTokens: undefined, costCents: undefined }
      : await embedTextChunks({ chunks: texts, profile, config: args.config, privacyMode: args.pipeline.privacyMode, signal, runner: args.runner });
    const tokens = embedded.totalTokens ?? texts.reduce((sum, text) => sum + estimateTokens(text), 0);
    args.usage.record({
      provider: profile.provider,
      model: profile.model,
      metric: SUMMARY_TREE_EMBEDDING_USAGE_METRIC,
      amount: tokens,
      unit: "token",
      costCents: embeddingCallCostCents(profile, embedded, tokens, args.config.costPer1kInputTokens),
      inputTokens: tokens,
      outputTokens: 0,
      logOutputTokens: false,
      metadata: { ...usageMetadata, runtime: profile.runtime, summaries: texts.length },
    });
    return embedded.vectors;
  };

  // Asked before the first call and before every commit window (build.ts `spendRefusal`): a balance that runs out,
  // a budget pause or the caller's own gate stops the build at its next window, not only before its first call.
  const spendRefusal = async (): Promise<string | null> => {
    const hosted = await args.hostedCallRefusal?.();
    if (hosted) return hosted;
    if (!overrides.summarize && !textModelApiKey(args.config.openRouterApiKey, model)) return "no-text-model-key";
    const gated = await args.gate?.();
    if (gated) return gated;
    return await (args.spendRefusal ? args.spendRefusal() : orgSpendRefusal(args.sql, scope));
  };

  const embeddingKey = args.embeddingArtifactUri ? keyFromStorageUri(args.embeddingArtifactUri, args.storage.bucket) : null;
  return await buildDocumentSummaryTree({
    sql: args.sql,
    artifacts,
    openEmbeddingArtifact: async (signal) => {
      if (!embeddingKey) return null;
      try {
        return (await args.storage.openStream(embeddingKey, signal)).stream;
      } catch (error) {
        if (artifactReadFailureKind(error) === "missing") return null;
        throw error;
      }
    },
    summarize,
    embed,
    recordUsage,
    flushUsage: args.usage.flush,
    buildActive,
    spendRefusal,
    stopReason: args.stopReason,
    acquireCall: args.acquireCall,
    writeRows: overrides.writeRows ?? ((write) => writeSummaryRows(write)),
    deleteRowsById: overrides.deleteRowsById ?? deleteSummaryRowsById,
    deleteDocumentRows: overrides.deleteDocumentRows ?? deleteDocumentSummaryRows,
    tableChanged: overrides.tableChanged ?? ((changed) => { scheduleSummariesMaintenance(changed); }),
    lanceRoot: overrides.lanceRoot,
    tmpDirectory: overrides.tmpDirectory,
    noteProgress: noteWorkProgress,
  }, {
    scope,
    documentId: document.id,
    runId: args.runId,
    document,
    runRoot: args.runRoot,
    space: { model: profile?.model ?? "", dimensions: profile?.dimensions ?? 0 },
    hashContext: {
      // The id the request is sent with; a private route keeps its full reference.
      modelId: !model || isPrivateModelUri(model) ? model || "unresolved" : resolveSupportedModelIdWithWarning(model),
      textGeneration: { profile: settings.profile, reasoningEffort: SUMMARY_TREE_REASONING_EFFORT, maxOutputTokens: summaryOutputTokenBudget(lengthTargetWords) },
      lengthTargetWords,
    },
    limits,
    concurrency: overrides.concurrency ?? args.callLimiter?.limit ?? summaryTreeConcurrency(env),
    owner: args.owner,
    takeOverLiveBuild: args.takeOverLiveBuild,
    buildStaleMs: overrides.buildStaleMs,
    heartbeatMs: overrides.heartbeatMs,
    signal: args.signal,
  });
}

export class SummaryTreeStage implements Stage {
  readonly name = SUMMARY_TREE_STAGE;

  constructor(
    private readonly runner: CommandRunner,
    private readonly storage: SummaryTreeStorage,
    private readonly config: Config,
    private readonly sql: () => Client,
    private readonly overrides: SummaryTreeOverrides = {},
  ) {}

  async run(state: WorkflowState, signal?: AbortSignal): Promise<void> {
    const pipeline = state.run.pipeline;
    if (!summaryTreeEnabled(pipeline)) return;
    const env = this.overrides.env ?? process.env;
    if (!summaryTreeBuildActive(pipeline, env)) {
      // A stored "on" stays inert while the deployment's switch is off (or the pipeline has no vectors).
      console.log(`[summary-tree] run=${state.run.id} status=off reason=build-inactive switch=${SUMMARY_TREE_BUILD_ENV_FLAG}`);
      return;
    }
    const orgId = state.run.orgId;
    const projectId = state.run.projectId;
    if (!orgId || !projectId) {
      console.warn(`[summary-tree] run=${state.run.id} status=refused reason=tenant-scope`);
      return;
    }
    const sql = this.sql();
    const model = resolveAllowedPipelineTextModel(pipeline, SUMMARY_TREE_TEXT_OPERATION, this.config.textGenerationModel);
    const documents = state.documents.filter((document) => !hasFailedDocumentStage(state, document.id));
    // One decision for the run: outside `standard` privacy mode a hosted summary model is not called.
    let hosted: Promise<boolean> | null = null;
    const hostedCallRefusal = async () => {
      if (this.overrides.summarize) return null;
      hosted ??= allowHostedCall(state, openRouterTextCall(SUMMARY_TREE_TEXT_OPERATION, model), documents.map((document) => document.id));
      return (await hosted) ? null : "privacy-mode";
    };
    const callLimiter = createConcurrencyLimiter(this.overrides.concurrency ?? summaryTreeConcurrency(env));
    const now = this.overrides.now ?? Date.now;
    const deadline = now() + (this.overrides.stageBudgetMs ?? summaryTreeStageBudgetMs(env));
    // A pause or cancel of the run, and the project turning the tree off, are read from Postgres with the balance
    // before every commit window (`gate`). Once seen they also stop the calls of every other document of this
    // stage at their next call (`stopReason`), not only the document whose window asked.
    let runStop: string | null = null;
    const stopReason = () => runStop ?? (isCostCapExceeded(state) ? "run-cost-cap" : now() >= deadline ? "stage-time-budget" : null);
    const gate = async (): Promise<string | null> => {
      const [row] = await sql<{ enabled: boolean | null; control_state: string | null }[]>`
        select (p.pipeline -> 'summaryTree' -> 'enabled') = 'true'::jsonb as enabled, r.control_state
        from projects p
        left join project_runs r on r.id = ${state.run.id} and r.project_id = p.id
        where p.id = ${projectId} and p.org_id = ${orgId}
      `;
      if (row?.enabled !== true) runStop ??= "project-setting-off";
      else if (row.control_state === "cancel_requested" || row.control_state === "cancelled") runStop ??= "run-cancelled";
      else if (row.control_state === "pause_requested" || row.control_state === "paused") runStop ??= "run-paused";
      return runStop;
    };
    let lastFlushAt = Date.now();
    let flushing: Promise<void> | null = null;
    const flush = async () => {
      if (!state.store || Date.now() - lastFlushAt < USAGE_FLUSH_INTERVAL_MS || state.usageLedger.pendingCount === 0) return;
      lastFlushAt = Date.now();
      const previous = flushing;
      const next = (async () => {
        await previous?.catch(() => undefined);
        await state.store!.updateProgress(state);
      })();
      flushing = next;
      await next;
    };

    await runDocuments(documents, Math.min(state.docConcurrency, SUMMARY_TREE_MAX_DOCUMENT_CONCURRENCY), async (document) => {
      await runDocumentStage(
        state,
        document,
        this.name,
        `${document.id}:${SUMMARY_TREE_STAGE}`,
        "summary tree ready",
        async () => {
          if (now() >= deadline) {
            // Not started: no artifact is read and no state row is written, so the document counts as having no tree yet.
            console.log(`[summary-tree] run=${state.run.id} document=${document.id} status=blocked reason=stage-time-budget`);
            return { stats: { summaryTreeStatus: "blocked", summaryTreeReason: "stage-time-budget", modelCalls: 0 }, message: "Summary tree not started (stage-time-budget)" };
          }
          // The project's setting as it is stored now, not as the run's snapshot has it.
          if (!(await projectSummaryTreeEnabled(sql, { orgId, projectId }))) {
            console.log(`[summary-tree] run=${state.run.id} document=${document.id} status=off reason=project-setting-off`);
            return { stats: { summaryTreeStatus: "off", summaryTreeReason: "project-setting-off", modelCalls: 0 }, message: "Summary tree off (project-setting-off)" };
          }
          const embedStage = state.documentStage(document.id, "embed");
          const chunks = (embedStage?.stats as { chunks?: unknown } | undefined)?.chunks;
          const result = await runSummaryTreeForDocument({
            sql,
            storage: this.storage,
            config: this.config,
            runner: this.runner,
            pipeline,
            scope: { orgId, projectId },
            runId: state.run.id,
            runRoot: runArtifactRoot(state.run, document.userId),
            document: {
              id: document.id,
              normalizedFormat: state.artifactLedger.readDocument(document.id, "normalizedFormat") ?? null,
              mimeType: document.mimeType,
              chunkCount: typeof chunks === "number" ? chunks : null,
              piiBlocked: isPiiBlockedDocument(state, document),
            },
            embeddingArtifactUri: embedStage?.artifactUri || state.artifactLedger.readDocument(document.id, "embeddings")
              || this.storage.uri(`${runArtifactRoot(state.run, document.userId)}/embeddings/${document.id}.json`),
            usage: { record: (input) => { state.usageLedger.record(input); }, flush },
            hostedCallRefusal,
            gate,
            stopReason,
            callLimiter,
            signal,
            overrides: this.overrides,
          });
          console.log(
            `[summary-tree] run=${state.run.id} document=${document.id} status=${result.status}` +
              `${result.skipReason ? ` skip=${result.skipReason}` : ""}${result.reason ? ` reason=${result.reason}` : ""}` +
              ` leaves=${result.stats.leaves} nodes=${result.stats.nodes} levels=${result.stats.levels} model_calls=${result.stats.modelCalls}` +
              ` reused_resume=${result.stats.reusedFromResume} reused_predecessor=${result.stats.reusedFromPredecessor} failed_groups=${result.stats.failedGroups}`,
          );
          return {
            artifactUri: result.artifactUri,
            stats: { ...result.stats },
            message: `Summary tree ${result.status}${result.skipReason ? ` (${result.skipReason})` : result.reason ? ` (${result.reason})` : ""}`,
          };
        },
        signal,
      );
    });
  }
}

import { flushErrorReporting, initializeWorkerErrorReporting, reportException } from "@docslurp/shared/error-reporting";
import { initializeObservability, shutdownObservability, withBackgroundSpan } from "@docslurp/shared/observability";
/**
 * Temporal worker entry point.
 *
 * Replaces the polling loop in index.ts. Starts a Temporal worker that
 * listens for pipeline workflows on the docslurp-pipeline task queue.
 *
 * Also runs the same background maintenance tasks (budget alerts,
 * retention sweeps, storage integrity checks) as the legacy worker.
 */

import { setMeteringEnforced } from "../pipeline/local-compute-cost.js";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { getHeapStatistics } from "node:v8";

import { NativeConnection, Worker, type WorkerOptions } from "@temporalio/worker";
import { formatTemporalConnectionError, retryTemporalConnect } from "@docslurp/shared/temporal-connection";
import { createTemporalSecurityConfig } from "@docslurp/shared/temporal-security";

import { fromEnv } from "../config.js";
import { Store } from "../db/store.js";
import { workerInstanceId } from "../db/worker-capabilities.js";
import { CommandRunner } from "../tools/runner.js";
import { createSandboxActivityInterceptor } from "../sandbox/activity-interceptor.js";
import { initializeParserSandbox, setDefaultParserSandbox } from "../sandbox/startup.js";
import { ArtifactStore } from "../tools/storage.js";
import { createStages } from "../stages/index.js";
import { createActivities } from "./activities.js";
import { resolveWorkerVersioning } from "./worker-versioning.js";
import { evaluateWorkerHealth, resolveWorkerHealthPort, startWorkerHealthServer } from "./health-server.js";
import { ScalerPublisher } from "./scaler-publisher.js";
import { UtilizationMeter } from "./utilization.js";
import { activitySlotOptions, maxActivitySlots, resolveActivitySlotTuning } from "./slot-tuning.js";
import { markWorkerShuttingDown } from "../lib/worker-lifecycle.js";
import { IndexStage } from "../stages/index-vectors.js";
import { drainLanceMaintenancePool, lanceMaintenanceSweepIntervalMs } from "../stages/lancedb-maintenance-pool.js";
import { resolveWorkerScalerConfig, resolveWorkerScalerQueryParams } from "@docslurp/shared";
import { warmLocalEmbedding } from "../stages/embedding-runtime.js";
import { closeSharedLocalEmbeddingPool } from "../stages/local-embedding-thread.js";
import { resolveEmbeddingModel } from "../embeddings/resolver.js";
import { DEFAULT_MATERIALIZE_TASK_QUEUE, defaultPipelineFeatures, deferredProfilesEnabled } from "@docslurp/shared";
import { purgeConfig } from "../db/superseded-purge.js";
import { prefetchVendorBundles } from "../tools/vendor-bundles.js";
import { initializePrivateModelEndpoints } from "../lib/privacy-guard.js";

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function defaultWorkerIdentity(): string {
  const hostId = readOptionalEnv("FLY_MACHINE_ID") ?? hostname();
  return `docslurp-worker-${hostId}-${process.pid}`;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = readOptionalEnv(name);
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const cfg = fromEnv();
  initializeObservability({ serviceName: "docslurp-worker" });
  initializeWorkerErrorReporting();
  const temporal = createTemporalSecurityConfig({
    TEMPORAL_ADDRESS: cfg.temporalAddress,
    TEMPORAL_NAMESPACE: cfg.temporalNamespace,
    TEMPORAL_TASK_QUEUE: cfg.temporalTaskQueue,
    TEMPORAL_TLS_ENABLED: String(cfg.temporalTlsEnabled),
    TEMPORAL_TLS_SERVER_NAME: cfg.temporalTlsServerName ?? undefined,
    TEMPORAL_TLS_CA_CERT_PEM: cfg.temporalTlsCaCertPem ?? undefined,
    TEMPORAL_TLS_CA_CERT_PATH: cfg.temporalTlsCaCertPath ?? undefined,
    TEMPORAL_TLS_CLIENT_CERT_PEM: cfg.temporalTlsClientCertPem ?? undefined,
    TEMPORAL_TLS_CLIENT_CERT_PATH: cfg.temporalTlsClientCertPath ?? undefined,
    TEMPORAL_TLS_CLIENT_KEY_PEM: cfg.temporalTlsClientKeyPem ?? undefined,
    TEMPORAL_TLS_CLIENT_KEY_PATH: cfg.temporalTlsClientKeyPath ?? undefined
  });
  const controller = new AbortController();
  const workflowsUrl = existsSync(new URL("./workflows.ts", import.meta.url))
    ? new URL("./workflows.ts", import.meta.url)
    : new URL("./workflows.js", import.meta.url);

  // Failures after this point are infrastructure interruptions, not document
  // failures (temporal/failure-classification.ts, OP-07).
  process.on("SIGINT", () => { markWorkerShuttingDown("SIGINT"); controller.abort(new Error("SIGINT")); });
  process.on("SIGTERM", () => { markWorkerShuttingDown("SIGTERM"); controller.abort(new Error("SIGTERM")); });

  // Shared infrastructure — reused across all activity invocations
  const store = new Store(cfg.databaseUrl, cfg.workerLeaseTtlMs, {
    plausibilityWarningThreshold: cfg.plausibilityWarningThreshold,
    apiKeyUsageRetentionDays: cfg.apiKeyUsageRetentionDays,
    perfLogRetentionDays: cfg.perfLogRetentionDays,
    poisonRunFailureThreshold: cfg.poisonRunFailureThreshold,
    poolMax: cfg.workerDbPoolMax,
  });
  // Invalid private endpoint config fails startup; the /models probe never blocks it.
  initializePrivateModelEndpoints((entries) => store.recordPrivacyAudit(entries));
  // Fail before connecting if the parser sandbox is unavailable or violates the production policy.
  const sandbox = await initializeParserSandbox(process.env, process.platform);
  // Every CommandRunner in this process (stages, local-artifact adapters) shares this provider.
  setDefaultParserSandbox(sandbox);
  const openSession = (activityId: string) => sandbox.provider.openSession(sandbox.config, { activityId });
  const runner = new CommandRunner({ openSession });
  const storage = new ArtifactStore(cfg);
  const stages = createStages({ runner, storage, config: cfg, mediaJournal: store.mediaJournal, capacityStore: store.capacityLeaseStore([]), sql: store.stageSql });

  // Create activity implementations with injected dependencies
  const activities = createActivities({ store, storage, stages, config: cfg, runner });

  // Connect to Temporal server
  let connection: NativeConnection | null = null;
  try {
    connection = await retryTemporalConnect(() =>
      NativeConnection.connect({
        address: temporal.address,
        tls: temporal.tls,
      })
    );
  } catch (error) {
    throw new Error(
      formatTemporalConnectionError(
        {
          address: temporal.address,
          namespace: temporal.namespace,
          taskQueue: temporal.taskQueue,
        },
        "Temporal worker",
        error
      )
    );
  }

  const workerIdentity = readOptionalEnv("TEMPORAL_WORKER_IDENTITY") ?? defaultWorkerIdentity();
  // Build ID = image git SHA; versioned routing stays opt-in (docs/temporal-workflow-changes.md).
  const versioning = resolveWorkerVersioning();
  // Workflow tasks are tiny; 125 machines × 8 pollers would be 1,000 idle long-polls.
  const workflowTaskPollers = readPositiveIntegerEnv("WORKER_WORKFLOW_TASK_POLLERS", 2);
  const workflowTaskSlots = Math.max(workflowTaskPollers, readPositiveIntegerEnv("WORKER_WORKFLOW_TASK_EXECUTIONS", 8));
  // Activity slots follow machine CPU and memory unless WORKER_SLOT_TUNER=fixed (slot-tuning.ts).
  const slotTuning = resolveActivitySlotTuning(process.env, cfg.workerActivityConcurrency);
  // Temporal requires pollers <= execution slots; do not reserve work beyond capacity.
  const activityTaskPollers = Math.min(maxActivitySlots(slotTuning), readPositiveIntegerEnv(
    "WORKER_ACTIVITY_TASK_POLLERS",
    Math.min(4, maxActivitySlots(slotTuning)),
  ));
  const activityTaskQueue = cfg.temporalActivityTaskQueue && cfg.temporalActivityTaskQueue !== temporal.taskQueue
    ? cfg.temporalActivityTaskQueue
    : null;
  const common = {
    connection,
    namespace: temporal.namespace,
    identity: workerIdentity,
    ...versioning.options,
    interceptors: { activity: [createSandboxActivityInterceptor(openSession)] },
    // Drain in-flight activities on SIGTERM / max runtime; Fly kill_timeout must exceed this.
    shutdownGraceTime: cfg.workerShutdownGraceMs,
  } satisfies Partial<WorkerOptions>;
  const workflowOptions = {
    workflowsPath: workflowsUrl.pathname,
    // Keep bounded sticky workflow state instead of replaying every page completion.
    maxCachedWorkflows: Math.max(0, Math.min(128, Number.parseInt(process.env.WORKER_CACHED_WORKFLOWS ?? "32", 10) || 0)),
    reuseV8Context: true,
    maxConcurrentWorkflowTaskExecutions: workflowTaskSlots,
    maxConcurrentWorkflowTaskPolls: workflowTaskPollers,
  } satisfies Partial<WorkerOptions>;
  const activityOptions = {
    activities,
    // Let the shared queue distribute pages instead of reserving them on the workflow host.
    maxEagerActivityReservationsPerWorkflowTask: 0,
    // One activity execution = one worker slot (docs/scaling-1000-workers.md).
    ...activitySlotOptions(slotTuning, activityTaskQueue ? undefined : workflowTaskSlots),
    maxConcurrentActivityTaskPolls: activityTaskPollers,
  } satisfies Partial<WorkerOptions>;
  // A tuner owns every slot type, so a combined worker drops the fixed workflow slot count.
  const { maxConcurrentWorkflowTaskExecutions: _workflowSlots, ...workflowOptionsForTuner } = workflowOptions;
  const combinedWorkflowOptions = "tuner" in activityOptions ? workflowOptionsForTuner : workflowOptions;
  // With TEMPORAL_ACTIVITY_TASK_QUEUE set, workflow tasks never queue behind
  // page activities (and vice versa): one worker per queue, same process.
  const workers: Worker[] = activityTaskQueue
    ? [
        await Worker.create({ ...common, ...workflowOptions, taskQueue: temporal.taskQueue }),
        await Worker.create({ ...common, ...activityOptions, taskQueue: activityTaskQueue }),
      ]
    : [await Worker.create({ ...common, ...combinedWorkflowOptions, ...activityOptions, taskQueue: temporal.taskQueue })];
  // Deferred indexing: materializePages runs on its own queue and slot budget so
  // on-demand page work never starves (or is starved by) the main pipeline.
  if (deferredProfilesEnabled()) {
    const materializeQueue = cfg.temporalMaterializeTaskQueue ?? DEFAULT_MATERIALIZE_TASK_QUEUE;
    workers.push(await Worker.create({
      ...common,
      ...workflowOptions,
      activities: {
        materializePageRangeActivity: activities.materializePageRangeActivity,
        completeMaterializeRun: activities.completeMaterializeRun,
      },
      maxConcurrentActivityTaskExecutions: cfg.materializeConcurrency,
      maxConcurrentActivityTaskPolls: Math.min(cfg.materializeConcurrency, 2),
      taskQueue: materializeQueue,
    }));
    console.log(`[temporal-worker] materialize queue=${materializeQueue} concurrency=${cfg.materializeConcurrency}`);
  }
  // UI raster requests have a small independent budget, even when deferred indexing is off.
  workers.push(await Worker.create({
    ...common, ...workflowOptions,
    activities: { renderDocumentPageActivity: activities.renderDocumentPageActivity },
    maxConcurrentActivityTaskExecutions: 2, maxConcurrentActivityTaskPolls: 2,
    taskQueue: process.env.TEMPORAL_PAGE_RENDER_TASK_QUEUE?.trim() || "docslurp-page-render",
  }));
  // A machine the autoscaler just started should be ready to embed when its first shard arrives.
  const defaultEmbedding = resolveEmbeddingModel(cfg, defaultPipelineFeatures);
  if (defaultEmbedding.runtime === "local" && process.env.LOCAL_EMBEDDING_WARMUP !== "false") {
    const warmStartedAt = Date.now();
    void warmLocalEmbedding(defaultEmbedding.model)
      .then(() => console.log(`[temporal-worker] local embedding warm model=${defaultEmbedding.model} ms=${Date.now() - warmStartedAt}`))
      .catch((error) => console.warn(`[temporal-worker] local embedding warm-up failed: ${error instanceof Error ? error.message : String(error)}`));
  }
  // Optional background install of vendor bundles (about 95 s to unpack); never blocks readiness.
  void prefetchVendorBundles();
  // The maintenance leader publishes the autoscaler target (the app may be
  // suspended) and keeps the app awake while work exists (scaler-publisher.ts).
  const scalerParams = resolveWorkerScalerQueryParams();
  const scaler = new ScalerPublisher({
    isLeader: () => maintenanceLeader,
    read: () => store.readWorkerScalerSnapshot(scalerParams),
    config: resolveWorkerScalerConfig(process.env, cfg.workerActivityConcurrency),
    params: scalerParams,
    keepAliveUrl: readOptionalEnv("WORKER_APP_KEEPALIVE_URL"),
  });
  // The autoscaler sizes the fleet assuming DOCSLURP_WORKER_SLOTS_PER_MACHINE
  // activities per machine. A Fly secret silently overrides fly.worker.toml, and
  // a stale WORKER_ACTIVITY_CONCURRENCY=1 secret once left every machine running
  // one activity while the scaler counted eight.
  const assumedSlots = resolveWorkerScalerConfig(process.env, cfg.workerActivityConcurrency).slotsPerMachine;
  if (assumedSlots !== slotTuning.nominalSlots) {
    console.error(
      `[temporal-worker] WORKER_ACTIVITY_CONCURRENCY=${slotTuning.nominalSlots} but the autoscaler assumes ` +
        `${assumedSlots} slots per machine (DOCSLURP_WORKER_SLOTS_PER_MACHINE); the fleet will be mis-sized. ` +
        `Check for a Fly secret overriding fly.worker.toml.`,
    );
  }
  // Slot and CPU utilization of this machine (utilization.ts), on /metrics and in a log line a minute.
  const activityWorkers = activityTaskQueue ? workers.slice(1) : workers;
  // Capacity is the nominal slot count the autoscaler plans with; resource-tuned machines may run above it.
  const utilization = new UtilizationMeter(slotTuning.nominalSlots,
    () => activityWorkers.reduce((sum, worker) => sum + worker.getStatus().numInFlightActivities, 0));
  setInterval(() => utilization.sample(), 1_000).unref();
  setInterval(() => console.log(`[worker-utilization] ${JSON.stringify(utilization.snapshot())}`), 60_000).unref();
  // Liveness for the Fly machine check and the post-deploy assertion; /metrics for Fly's scraper.
  const healthPort = resolveWorkerHealthPort();
  const healthServer = healthPort
    ? startWorkerHealthServer({
        port: healthPort,
        health: () => evaluateWorkerHealth(workers.map((worker) => worker.getStatus())),
        metrics: async () => `${await scaler.metrics()}${utilization.metricLines().join("\n")}\n`,
      })
    : null;
  const shutdownWorkers = () => {
    for (const worker of workers) {
      try {
        worker.shutdown();
      } catch {
        // Already stopping.
      }
    }
  };
  const maxRuntimeTimer = cfg.workerMaxRuntimeMs > 0
    ? setTimeout(() => {
        console.warn(
          `[temporal-worker] status=max-runtime-reached maxRuntimeMs=${cfg.workerMaxRuntimeMs} ` +
          `action=drain graceMs=${cfg.workerShutdownGraceMs}`
        );
        markWorkerShuttingDown("max-runtime");
        shutdownWorkers();
      }, cfg.workerMaxRuntimeMs)
    : null;

  // Fleet maintenance runs on one worker: "auto" elects a leader through a
  // row lease, "true" always runs (single-worker setups), "false" never.
  const maintenanceLeaseMs = 90_000;
  let maintenanceLeader = cfg.workerRunMaintenance === "true";
  const refreshMaintenanceLeadership = async () => {
    if (cfg.workerRunMaintenance !== "auto") return;
    const leader = await withBackgroundSpan("worker.maintenance-lease", () =>
      store.tryMaintenanceLease("worker-maintenance", workerIdentity, maintenanceLeaseMs))
      .catch((err) => {
        console.warn(`[temporal-worker] maintenance lease check failed: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      });
    if (leader !== maintenanceLeader) {
      console.log(`[temporal-worker] maintenance_leader=${leader} identity=${workerIdentity}`);
    }
    maintenanceLeader = leader;
  };
  const leaderTimer = cfg.workerRunMaintenance === "auto"
    ? setInterval(() => void refreshMaintenanceLeadership(), maintenanceLeaseMs / 3)
    : null;
  leaderTimer?.unref();
  await refreshMaintenanceLeadership();
  const onLeader = (task: () => void) => () => {
    if (maintenanceLeader) task();
  };
  const scalerTimer = setInterval(onLeader(() => void withBackgroundSpan("worker.autoscaler", () => scaler.tick())), 60_000);
  scalerTimer.unref();

  // Every worker (not just the leader) mirrors the app's billing enforcement so
  // compute is billed whenever Stripe is configured.
  const refreshMeteringEnforcement = () =>
    withBackgroundSpan("worker.metering-enforcement", () => store.loadMeteringEnforced()).then(setMeteringEnforced).catch((err) => {
      console.error(`[billing] metering enforcement refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  await refreshMeteringEnforcement();
  const meteringTimer = setInterval(() => void refreshMeteringEnforcement(), 60_000);
  meteringTimer.unref();

  // Continue sampling while idle so retained memory can be distinguished from active work.
  const memoryTimer = setInterval(() => {
    const memory = process.memoryUsage();
    console.log(`[worker-memory] ${JSON.stringify({ pid: process.pid, uptimeSeconds: Math.round(process.uptime()),
      rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external, arrayBufferBytes: memory.arrayBuffers,
      heapLimitBytes: getHeapStatistics().heap_size_limit })}`);
  }, 30_000);
  memoryTimer.unref();

  // Background maintenance tasks (same as legacy worker)
  const budgetTimer = setInterval(onLeader(() => {
    withBackgroundSpan("worker.budget-alerts", () => store.processBudgetAlerts()).catch((err) => {
      console.error(
        "budget alert sweep failed:",
        err instanceof Error ? err.message : String(err)
      );
    });
    withBackgroundSpan("worker.secret-expiry-alerts", () => store.processSecretExpiryAlerts()).catch((err) => {
      console.error(
        "secret expiry sweep failed:",
        err instanceof Error ? err.message : String(err)
      );
    });
  }), cfg.budgetSweepIntervalMs);

  // Pending credit debits (migration 0030): the leader applies them to org
  // pools every few seconds. The app's maintenance sweeper flushes too, so
  // billing keeps up when no worker leads; concurrent flushes are safe.
  const creditDebitFlushMs = cfg.creditDebitFlushIntervalMs ?? 2_000;
  let creditFlushRunning = false;
  const flushCreditDebits = () => {
    if (creditFlushRunning) return;
    creditFlushRunning = true;
    withBackgroundSpan("worker.credit-debit-flush", () => store.flushPendingCreditDebits())
      .then((result) => {
        if (result.debits > 0) {
          console.log(`[billing] credit-debit-flush orgs=${result.orgs} debits=${result.debits} credits=${result.credits.toFixed(6)}`);
        }
      })
      .catch((err) => {
        console.error(`[billing] credit-debit flush failed: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        creditFlushRunning = false;
      });
  };
  const creditFlushTimer = creditDebitFlushMs > 0
    ? setInterval(onLeader(flushCreditDebits), creditDebitFlushMs)
    : null;
  creditFlushTimer?.unref();

  // Replaced canonical versions: delete derived data once the grace period passes.
  const purgeOptions = purgeConfig();
  const purgeSuperseded = () =>
    withBackgroundSpan("worker.superseded-purge", () => store.purgeSupersededDocuments(storage, purgeOptions)).catch((err) => {
      console.error(
        "superseded purge sweep failed:",
        err instanceof Error ? err.message : String(err)
      );
    });
  const purgeTimer = purgeOptions.intervalMs > 0
    ? setInterval(onLeader(() => void purgeSuperseded()), purgeOptions.intervalMs)
    : null;
  purgeTimer?.unref();

  // Workspace graph rebuilds (graph_jobs): one job at a time per worker,
  // leased so a crashed worker's job resumes elsewhere.
  let graphJobRunning = false;
  const runGraphJobs = () => {
    if (graphJobRunning) return;
    graphJobRunning = true;
    withBackgroundSpan("worker.graph-jobs", () => store.runGraphJobs({
      workerId: workerIdentity,
      config: cfg,
      concurrency: cfg.graphJobConcurrency,
    }))
      .catch((err) => {
        console.error(
          "graph job sweep failed:",
          err instanceof Error ? err.message : String(err)
        );
      })
      .finally(() => {
        graphJobRunning = false;
      });
  };
  const graphJobPollIntervalMs = cfg.graphJobPollIntervalMs ?? 5_000;
  const graphJobTimer = graphJobPollIntervalMs > 0
    ? setInterval(onLeader(runGraphJobs), graphJobPollIntervalMs)
    : null;
  graphJobTimer?.unref();

  // LanceDB maintenance runs off the index stage's critical path (lancedb-maintenance-pool.ts).
  // Drainers schedule it as they commit; this sweep catches tables that became due with no
  // drainer coming (traffic stopped) and checks lost to a crash or a shutdown drain timeout.
  const indexStage = stages.find((stage): stage is IndexStage => stage instanceof IndexStage);
  const lanceSweepMs = lanceMaintenanceSweepIntervalMs();
  let lanceSweepRunning = false;
  const lanceSweepTimer = indexStage && lanceSweepMs > 0
    ? setInterval(onLeader(() => {
        if (lanceSweepRunning) return;
        lanceSweepRunning = true;
        withBackgroundSpan("worker.lancedb-maintenance-sweep", () => indexStage.sweepLanceDbMaintenance())
          .then((scheduled) => {
            if (scheduled > 0) console.log(`[lancedb] maintenance sweep scheduled=${scheduled}`);
          })
          .catch((err) => console.error(`[lancedb] maintenance sweep failed: ${err instanceof Error ? err.message : String(err)}`))
          .finally(() => {
            lanceSweepRunning = false;
          });
      }), lanceSweepMs)
    : null;
  lanceSweepTimer?.unref();

  const retentionTimer = setInterval(onLeader(() => {
    withBackgroundSpan("worker.retention-sweep", () => store.runRetentionSweep(storage, cfg.retentionSweepBatchSize)).catch((err) => {
      console.error(
        "retention sweep failed:",
        err instanceof Error ? err.message : String(err)
      );
    });
    withBackgroundSpan("worker.storage-integrity-sweep", () => store.runStorageIntegritySweep(storage, {
      maxKeys: cfg.storageIntegritySweepMaxKeys,
      prefix: cfg.storageIntegritySweepPrefix,
    }))
      .catch((err) => {
        console.error(
          "integrity sweep failed:",
          err instanceof Error ? err.message : String(err)
        );
      });
  }), cfg.retentionSweepIntervalMs);

  console.log(
    `[temporal-worker] status=started ` +
    `taskQueue=${temporal.taskQueue} ` +
    `namespace=${temporal.namespace} ` +
    `temporalAddress=${temporal.address} ` +
    `identity=${workerIdentity} ` +
    `buildId=${versioning.buildId ?? "auto"} ` +
    `versioning=${versioning.mode}${versioning.deploymentVersion ? `:${versioning.deploymentVersion}` : ""} ` +
    `docConcurrency=${cfg.workerDocConcurrency} ` +
    `activitySlots=${slotTuning.mode === "fixed" ? `fixed:${slotTuning.nominalSlots}` : `resource:${slotTuning.minimumSlots}-${slotTuning.maximumSlots} cpu<${slotTuning.targetCpuUsage} mem<${slotTuning.targetMemoryUsage} ramp=${slotTuning.rampThrottleMs}ms`} ` +
    `maxRuntimeMs=${cfg.workerMaxRuntimeMs} ` +
    `workflowPollers=${workflowTaskPollers} ` +
    `activityPollers=${activityTaskPollers} ` +
    `activityTaskQueue=${activityTaskQueue ?? temporal.taskQueue} ` +
    `shutdownGraceMs=${cfg.workerShutdownGraceMs} ` +
    `dbPoolMax=${cfg.workerDbPoolMax} ` +
    `maintenance=${cfg.workerRunMaintenance} maintenanceLeader=${maintenanceLeader}`
  );

  // Capability handshake (db/worker-capabilities.ts): register before polling
  // so the app never counts this worker's pollers as an unknown older build.
  const capabilityRegistry = store.capabilityRegistry({
    instanceId: workerInstanceId(process.env, hostname(), process.pid),
    identity: workerIdentity,
    taskQueue: temporal.taskQueue,
    buildId: versioning.buildId ?? null,
    intervalMs: readPositiveIntegerEnv("WORKER_CAPABILITY_HEARTBEAT_MS", 20_000),
  });
  await capabilityRegistry.start();

  try {
    // Run initial maintenance sweep (leader only)
    if (maintenanceLeader) {
      await store.processBudgetAlerts().catch(() => {});
      await store.processSecretExpiryAlerts().catch(() => {});
      await store
        .runRetentionSweep(storage, cfg.retentionSweepBatchSize)
        .catch(() => {});
      await store
        .runStorageIntegritySweep(storage, {
          maxKeys: cfg.storageIntegritySweepMaxKeys,
          prefix: cfg.storageIntegritySweepPrefix,
        })
        .catch(() => {});
    }

    // A failing worker stops its siblings, but resources stay open until every
    // worker has finished draining. Preserve the first failure for the caller.
    let workerFailed = false;
    let firstWorkerError: unknown;
    await Promise.allSettled(workers.map((worker) => Promise.resolve().then(() => worker.run()).catch((error) => {
      if (!workerFailed) {
        workerFailed = true;
        firstWorkerError = error;
      }
      shutdownWorkers();
      throw error;
    })));
    if (workerFailed) throw firstWorkerError;
  } finally {
    if (maxRuntimeTimer) {
      clearTimeout(maxRuntimeTimer);
    }
    if (leaderTimer) clearInterval(leaderTimer);
    healthServer?.close();
    clearInterval(scalerTimer);
    clearInterval(memoryTimer);
    clearInterval(meteringTimer);
    clearInterval(budgetTimer);
    clearInterval(retentionTimer);
    if (purgeTimer) clearInterval(purgeTimer);
    if (graphJobTimer) clearInterval(graphJobTimer);
    if (creditFlushTimer) clearInterval(creditFlushTimer);
    if (lanceSweepTimer) clearInterval(lanceSweepTimer);
    // Activities have drained; let background LanceDB maintenance finish (bounded) before
    // closing its database pool. Anything left stays due in Postgres for another worker.
    const lanceDrain = await drainLanceMaintenancePool();
    console.log(
      `[lancedb] maintenance drain completed=${lanceDrain.completed} running=${lanceDrain.running.length} dropped=${lanceDrain.dropped.length}`,
    );
    await indexStage?.close();
    await runner.close().catch((err) => {
      console.error(
        "runner shutdown failed:",
        err instanceof Error ? err.message : String(err)
      );
    });
    // Activities have drained, so no embedding batch is in flight; stop the model threads.
    await closeSharedLocalEmbeddingPool().catch((err) => {
      console.error("local embedding pool shutdown failed:", err instanceof Error ? err.message : String(err));
    });
    await shutdownObservability();
    await flushErrorReporting();
    await capabilityRegistry.stop();
    await store.close();
    await connection?.close().catch((err) => {
      console.error(
        "temporal connection shutdown failed:",
        err instanceof Error ? err.message : String(err)
      );
    });
  }
}

main().catch(async (error) => {
  initializeWorkerErrorReporting();
  reportException(error, { operation: "worker-startup-or-shutdown" });
  await flushErrorReporting();
  process.exitCode = 1;
});

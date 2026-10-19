import "./env.js";

import { existsSync } from "node:fs";
import { defaultDocConcurrency, resolveActivityConcurrency } from "./concurrency.js";
import {
  inferenceLaneOptions,
  textGenerationProfileSchema,
  pageRouterModeSchema,
  type PageRouterMode,
  type TextGenerationProfile,
  type InferenceLane,
} from "@docslurp/shared";
import { resolveLanceDbConfig, resolveObjectStorageConfig, type LanceDbConfig, type ObjectStorageConfig } from "@docslurp/shared";
import { lanceDbMaintenanceSettings } from "./stages/lancedb-maintenance.js";

const defaultDatabaseUrl =
  "postgres://docslurp:docslurp@localhost:5432/docslurp";

function isContainerRuntime(): boolean {
  return existsSync("/.dockerenv");
}

function readEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Unknown or unset values fall back to off so a typo never enables routing. */
export function readPageRouterMode(value: string | undefined): PageRouterMode {
  const parsed = pageRouterModeSchema.safeParse(readEnv(value)?.toLowerCase());
  return parsed.success ? parsed.data : "off";
}

function isProductionEnvironment(): boolean {
  return (readEnv(process.env.NODE_ENV) ?? "").toLowerCase() === "production";
}

function rewriteDockerHostname(
  rawUrl: string | undefined,
  fromHost: string,
  toHost: string,
): string | undefined {
  if (!rawUrl || isContainerRuntime()) {
    return rawUrl;
  }

  try {
    const url = new URL(rawUrl);
    if (url.hostname !== fromHost) {
      return rawUrl;
    }

    url.hostname = toHost;
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function resolveDatabaseUrl(): string {
  const sharedUrl = readEnv(process.env.DATABASE_URL) ?? defaultDatabaseUrl;
  return (
    rewriteDockerHostname(sharedUrl, "postgres", "localhost") ??
    defaultDatabaseUrl
  );
}


export interface Config {
  databaseUrl: string;
  /** Object storage from STORAGE_URI. */
  storage: ObjectStorageConfig;
  s3Bucket: string;
  /** LanceDB root, storage options and query tuning from LANCEDB_URI. */
  lancedb: LanceDbConfig;
  openAiApiKey: string;
  deepInfraApiKey?: string;
  openAiBaseUrl: string;
  defaultInferenceLane: InferenceLane;
  vectorBackends: string[];
  /** Max pages per LanceDB write window (direct write mode). Maintenance follows the cadence policy, not windows. LANCEDB_URI ?reindexPages= (default 20). */
  lancedbReindexPages: number;
  /** Run optimize/index maintenance after LanceDB writes. LANCEDB_URI ?maintenance=false disables. */
  lancedbMaintenanceEnabled: boolean;
  /** Minimum table rows before maintenance builds the first ANN vector index. LANCEDB_URI ?vectorIndexMinRows= (default 5000). */
  lancedbVectorIndexMinRows: number;
  workerLeaseTtlMs: number;
  workerMaxRuntimeMs: number;
  workerDocConcurrency: number;
  workerActivityConcurrency: number;
  workerAdaptiveTuning: boolean;
  serializePdfCandidateExtraction: boolean;
  visionDensityThreshold: number;
  /**
   * PAGE_ROUTER_MODE=off|shadow|active (default off). Ceiling over each workspace's
   * `pageRouter.mode`: nothing routes unless both opt in. Optional so partial
   * Config literals (tests) read as off.
   */
  pageRouterMode?: PageRouterMode;
  pythonPoolSize: number;
  parserArtifactTimeoutMs: number;
  unstructuredParserChunkTimeoutMs: number;
  unstructuredParserInitialChunkPages: number;
  unstructuredParserMaxChunkPages: number;
  unstructuredParserMaxConcurrency: number;
  costPer1kInputTokens: number;
  costPer1kOutputTokens: number;
  openRouterApiKey: string;
  perplexityApiKey?: string;
  /** Deployment fallback; workspaces and tasks can override it. */
  textGenerationModel?: string;
  textGenerationProfile?: TextGenerationProfile;
  plausibilityWarningThreshold: number;
  budgetSweepIntervalMs: number;
  /** How often the maintenance leader applies pending credit debits; 0 disables. */
  creditDebitFlushIntervalMs?: number;
  retentionSweepIntervalMs: number;
  /** How often idle workers look for queued workspace graph rebuilds; 0 disables. */
  graphJobPollIntervalMs?: number;
  /** Documents a graph rebuild extracts at once. */
  graphJobConcurrency?: number;
  retentionSweepBatchSize: number;
  apiKeyUsageRetentionDays: number;
  perfLogRetentionDays: number;
  storageIntegritySweepMaxKeys: number;
  storageIntegritySweepPrefix: string | null;
  quarantineEnabled: boolean;
  quarantineFailOpenOnToolMissing: boolean;
  quarantineMaxArchiveEntries: number;
  quarantineMaxArchiveDepth: number;
  quarantineMaxTotalUncompressedBytes: number;
  quarantineMaxSingleEntryBytes: number;
  quarantineMaxExpansionRatio: number;
  /** Postgres connections per worker process (WORKER_DB_POOL_MAX). */
  workerDbPoolMax: number;
  /** "auto" = one leader-elected worker runs fleet maintenance; "true"/"false" force it. */
  workerRunMaintenance: "auto" | "true" | "false";
  /** Drain time for in-flight activities on shutdown (WORKER_SHUTDOWN_GRACE). */
  workerShutdownGraceMs: number;
  /** Optional separate queue for activities; workflows stay on temporalTaskQueue. */
  temporalActivityTaskQueue: string | null;
  poisonRunFailureThreshold: number;
  temporalAddress: string;
  temporalNamespace: string;
  temporalTaskQueue: string;
  temporalTlsEnabled: boolean;
  temporalTlsServerName: string | null;
  temporalTlsCaCertPem: string | null;
  temporalTlsCaCertPath: string | null;
  temporalTlsClientCertPem: string | null;
  temporalTlsClientCertPath: string | null;
  temporalTlsClientKeyPem: string | null;
  temporalTlsClientKeyPath: string | null;
}

export { defaultDocConcurrency };

function readNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function readList(value: string | undefined, fallback: string[]): string[] {
  if (!value) {
    return [...fallback];
  }

  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return items.length > 0 ? items : [...fallback];
}

function readEnumOption<T extends readonly string[]>(
  value: string | undefined,
  options: T,
  fallback: T[number],
): T[number] {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  return options.find((option) => option === normalized) ?? fallback;
}

function readNonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseDurationMs(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const input = value.trim();
  const matches = [...input.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h)/g)];
  if (matches.length === 0) {
    return fallback;
  }

  const total = matches.reduce((sum, match) => {
    const amount = Number.parseFloat(match[1] ?? "0");
    const unit = match[2];
    const multiplier =
      unit === "ms"
        ? 1
        : unit === "s"
          ? 1_000
          : unit === "m"
            ? 60_000
            : unit === "h"
              ? 3_600_000
              : 0;
    return sum + amount * multiplier;
  }, 0);

  return Number.isFinite(total) && total > 0 ? total : fallback;
}

export function fromEnv(): Config {
  const storage = resolveObjectStorageConfig();
  const lancedb = resolveLanceDbConfig(process.env, storage);
  const maintenance = lanceDbMaintenanceSettings(lancedb.params);
  return {
    databaseUrl: resolveDatabaseUrl(),
    storage,
    s3Bucket: storage.bucket,
    lancedb,
    openAiApiKey: process.env.OPENAI_API_KEY ?? "",
    deepInfraApiKey: process.env.DEEPINFRA_API_KEY ?? "",
    openAiBaseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    defaultInferenceLane: readEnumOption(
      process.env.DEFAULT_INFERENCE_LANE ?? process.env.INFERENCE_LANE,
      inferenceLaneOptions,
      "standard",
    ) as InferenceLane,
    vectorBackends: readList(process.env.VECTOR_BACKENDS, ["lancedb"]),
    // Maintenance tuning rides on LANCEDB_URI, e.g. s3://bucket/lancedb?reindexPages=20&vectorIndexMinRows=5000.
    lancedbReindexPages: maintenance.reindexPages,
    lancedbMaintenanceEnabled: maintenance.enabled,
    lancedbVectorIndexMinRows: maintenance.vectorIndexMinRows,
    workerLeaseTtlMs: parseDurationMs(process.env.WORKER_LEASE_TTL, 45_000),
    workerMaxRuntimeMs: parseDurationMs(process.env.WORKER_MAX_RUNTIME, 0),
    workerDocConcurrency: readNumber(process.env.WORKER_DOC_CONCURRENCY, defaultDocConcurrency()),
    workerActivityConcurrency: resolveActivityConcurrency(process.env),
    workerAdaptiveTuning: readBoolean(
      process.env.WORKER_ADAPTIVE_TUNING,
      true,
    ),
    serializePdfCandidateExtraction: readBoolean(
      process.env.WORKER_SERIALIZE_PDF_CANDIDATES,
      false,
    ),
    visionDensityThreshold: Number.parseFloat(
      process.env.VISION_DENSITY_THRESHOLD ?? "0.25",
    ),
    pageRouterMode: readPageRouterMode(process.env.PAGE_ROUTER_MODE),
    pythonPoolSize: readNumber(process.env.WORKER_PYTHON_POOL_SIZE, 2),
    parserArtifactTimeoutMs: readNumber(
      process.env.PARSER_ARTIFACT_TIMEOUT_MS,
      30_000,
    ),
    unstructuredParserChunkTimeoutMs: readNumber(
      process.env.UNSTRUCTURED_PARSER_CHUNK_TIMEOUT_MS,
      20_000,
    ),
    unstructuredParserInitialChunkPages: Math.max(
      1,
      readNumber(process.env.UNSTRUCTURED_PARSER_INITIAL_CHUNK_PAGES, 1),
    ),
    unstructuredParserMaxChunkPages: Math.min(
      100,
      Math.max(1, readNumber(process.env.UNSTRUCTURED_PARSER_MAX_CHUNK_PAGES, 2)),
    ),
    unstructuredParserMaxConcurrency: Math.max(
      1,
      readNumber(process.env.UNSTRUCTURED_PARSER_MAX_CONCURRENCY, 3),
    ),
    costPer1kInputTokens: Number.parseFloat(
      process.env.COST_PER_1K_INPUT_TOKENS ?? "0.01",
    ),
    costPer1kOutputTokens: Number.parseFloat(
      process.env.COST_PER_1K_OUTPUT_TOKENS ?? "0.03",
    ),
    textGenerationModel: readEnv(process.env.DOCSLURP_TEXT_MODEL),
    textGenerationProfile: textGenerationProfileSchema.optional().parse(readEnv(process.env.DOCSLURP_TEXT_PROFILE)),
    perplexityApiKey: process.env.PERPLEXITY_API_KEY ?? process.env.PERPLEXITYAI_API_KEY,
    openRouterApiKey:
      process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_KEY ?? "",
    plausibilityWarningThreshold: Number.parseFloat(
      process.env.PLAUSIBILITY_WARNING_THRESHOLD ?? "0.3",
    ),
    creditDebitFlushIntervalMs: readNonNegativeInt(process.env.CREDIT_DEBIT_FLUSH_INTERVAL_MS, 2_000),
    budgetSweepIntervalMs: parseDurationMs(
      process.env.WORKER_BUDGET_SWEEP_INTERVAL,
      3_600_000,
    ),
    retentionSweepIntervalMs: parseDurationMs(
      process.env.WORKER_RETENTION_SWEEP_INTERVAL,
      21_600_000,
    ),
    graphJobPollIntervalMs: parseDurationMs(
      process.env.WORKER_GRAPH_JOB_POLL_INTERVAL,
      5_000,
    ),
    graphJobConcurrency: Math.max(1, readNumber(process.env.WORKER_GRAPH_JOB_CONCURRENCY, 4)),
    retentionSweepBatchSize: readNumber(
      process.env.WORKER_RETENTION_SWEEP_BATCH_SIZE,
      25,
    ),
    apiKeyUsageRetentionDays: Math.max(
      1,
      readNumber(process.env.API_KEY_USAGE_RETENTION_DAYS, 30),
    ),
    perfLogRetentionDays: Math.max(
      1,
      readNumber(process.env.PERF_LOG_RETENTION_DAYS, 90),
    ),
    storageIntegritySweepMaxKeys: Math.max(
      100,
      readNumber(process.env.WORKER_INTEGRITY_SWEEP_MAX_KEYS, 20_000),
    ),
    storageIntegritySweepPrefix:
      process.env.WORKER_INTEGRITY_SWEEP_PREFIX?.trim() || null,
    quarantineEnabled: isProductionEnvironment() || readBoolean(process.env.QUARANTINE_ENABLED, true),
    quarantineFailOpenOnToolMissing: !isProductionEnvironment() && readBoolean(
      process.env.QUARANTINE_FAIL_OPEN_ON_TOOL_MISSING,
      !isProductionEnvironment(),
    ),
    quarantineMaxArchiveEntries: readNumber(
      process.env.QUARANTINE_MAX_ARCHIVE_ENTRIES,
      2_000,
    ),
    quarantineMaxArchiveDepth: readNumber(
      process.env.QUARANTINE_MAX_ARCHIVE_DEPTH,
      12,
    ),
    quarantineMaxTotalUncompressedBytes: readNumber(
      process.env.QUARANTINE_MAX_TOTAL_UNCOMPRESSED_BYTES,
      512 * 1024 * 1024,
    ),
    quarantineMaxSingleEntryBytes: readNumber(
      process.env.QUARANTINE_MAX_SINGLE_ENTRY_BYTES,
      128 * 1024 * 1024,
    ),
    quarantineMaxExpansionRatio: readNumber(
      process.env.QUARANTINE_MAX_EXPANSION_RATIO,
      250,
    ),
    workerDbPoolMax: Math.max(1, readNumber(process.env.WORKER_DB_POOL_MAX, 10)),
    workerRunMaintenance: readMaintenanceMode(process.env.WORKER_RUN_MAINTENANCE),
    workerShutdownGraceMs: parseDurationMs(process.env.WORKER_SHUTDOWN_GRACE, 240_000),
    temporalActivityTaskQueue: readEnv(process.env.TEMPORAL_ACTIVITY_TASK_QUEUE) ?? null,
    poisonRunFailureThreshold: readNumber(
      process.env.POISON_RUN_FAILURE_THRESHOLD,
      3,
    ),
    // Workers may dial Temporal directly over 6PN (.internal) while the app keeps Flycast.
    temporalAddress: readEnv(process.env.TEMPORAL_WORKER_ADDRESS) ?? readEnv(process.env.TEMPORAL_ADDRESS) ?? "localhost:7233",
    temporalNamespace: readEnv(process.env.TEMPORAL_NAMESPACE) ?? "default",
    temporalTaskQueue:
      readEnv(process.env.TEMPORAL_TASK_QUEUE) ?? "docslurp-pipeline",
    temporalTlsEnabled: readBoolean(process.env.TEMPORAL_TLS_ENABLED, false),
    temporalTlsServerName:
      readEnv(process.env.TEMPORAL_TLS_SERVER_NAME) ?? null,
    temporalTlsCaCertPem: readEnv(process.env.TEMPORAL_TLS_CA_CERT_PEM) ?? null,
    temporalTlsCaCertPath:
      readEnv(process.env.TEMPORAL_TLS_CA_CERT_PATH) ?? null,
    temporalTlsClientCertPem:
      readEnv(process.env.TEMPORAL_TLS_CLIENT_CERT_PEM) ?? null,
    temporalTlsClientCertPath:
      readEnv(process.env.TEMPORAL_TLS_CLIENT_CERT_PATH) ?? null,
    temporalTlsClientKeyPem:
      readEnv(process.env.TEMPORAL_TLS_CLIENT_KEY_PEM) ?? null,
    temporalTlsClientKeyPath:
      readEnv(process.env.TEMPORAL_TLS_CLIENT_KEY_PATH) ?? null,
  };
}

function readMaintenanceMode(value: string | undefined): "auto" | "true" | "false" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes") return "true";
  if (normalized === "false" || normalized === "0" || normalized === "no") return "false";
  return "auto";
}

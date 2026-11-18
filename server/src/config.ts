import "./env.js";
import { validateEncryptionConfiguration } from "./lib/encryption.js";

import { existsSync } from "node:fs";

import { resolveLanceDbConfig, resolveObjectStorageConfig } from "@docslurp/shared";

import { storageAccessKeyIdProblem } from "./lib/storage-credentials.js";

const defaultDatabaseUrl = "postgres://docslurp:docslurp@localhost:5432/docslurp";

function isContainerRuntime(): boolean {
  return existsSync("/.dockerenv");
}

function readEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function rewriteDockerHostname(rawUrl: string | undefined, fromHost: string, toHost: string): string | undefined {
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
  const selected = readEnv(process.env.DATABASE_URL) ?? defaultDatabaseUrl;

  return rewriteDockerHostname(selected, "postgres", "localhost") ?? defaultDatabaseUrl;
}


function readNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readList(value: string | undefined): string[] | undefined {
  const items = value?.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return items?.length ? items : undefined;
}

/**
 * Web Capabilities (search, fetch, map, crawl) through third-party providers.
 * Off unless WEB_TOOLS_ENABLED=true; a provider is used only when its key is set.
 */
function resolveWebConfig() {
  const strategy = readEnv(process.env.WEB_PROVIDER_STRATEGY);
  return {
    enabled: readBoolean(process.env.WEB_TOOLS_ENABLED, false),
    /** Offer webSearch/webFetch to the chat assistant (guarded; never crawl, map or ingest). */
    chatEnabled: readBoolean(process.env.WEB_TOOLS_CHAT_ENABLED, true),
    strategy: (strategy === "round-robin" || strategy === "ordered" ? strategy : "cheapest") as "cheapest" | "round-robin" | "ordered",
    order: readList(process.env.WEB_PROVIDER_ORDER) ?? ["jina", "firecrawl", "exa", "tavily"],
    perCapability: {
      search: readList(process.env.WEB_PROVIDERS_SEARCH),
      fetch: readList(process.env.WEB_PROVIDERS_FETCH),
      map: readList(process.env.WEB_PROVIDERS_MAP),
      crawl: readList(process.env.WEB_PROVIDERS_CRAWL),
    },
    /** Provider calls per web call (failover and render escalation steps). */
    maxAttempts: Math.max(1, Math.min(6, readNumber(process.env.WEB_PROVIDER_MAX_ATTEMPTS, 4))),
    /** Never try an option estimated at this many times the cheapest eligible option, or more. */
    maxCostRatio: Math.max(1, readNumber(process.env.WEB_MAX_COST_RATIO, 15)),
    /** Same-option retries after a transient (5xx/network) failure. */
    transientRetries: Math.max(0, Math.min(3, readNumber(process.env.WEB_TRANSIENT_RETRIES, 1))),
    /** Options switched off, as provider.option (e.g. "exa.live,firecrawl.rendered-wait"). */
    disabledOptions: readList(process.env.WEB_DISABLED_OPTIONS) ?? [],
    keys: {
      tavily: readEnv(process.env.TAVILY_API_KEY),
      exa: readEnv(process.env.EXA_API_KEY),
      firecrawl: readEnv(process.env.FIRECRAWL_API_KEY),
      jina: readEnv(process.env.JINA_API_KEY),
    },
    pricing: {
      tavilyUsdPerCredit: readNumber(process.env.TAVILY_USD_PER_CREDIT, 0.008),
      firecrawlUsdPerCredit: readNumber(process.env.FIRECRAWL_USD_PER_CREDIT, 0.00099),
      jinaUsdPerMillionTokens: readNumber(process.env.JINA_USD_PER_MILLION_TOKENS, 0.05),
    },
    /** Web calls per organization per minute, across surfaces. */
    orgPerMinute: Math.max(1, readNumber(process.env.WEB_TOOLS_ORG_PER_MINUTE, 60)),
    cacheTtlMs: Math.max(0, readNumber(process.env.WEB_CACHE_TTL_SECONDS, 900)) * 1000,
    cacheMaxEntries: Math.max(0, readNumber(process.env.WEB_CACHE_MAX_ENTRIES, 500)),
  };
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

/** STORAGE_PUBLIC_ENDPOINT: an http(s) URL without path, query or credentials. */
function readPublicEndpoint(value: string | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error(`Invalid STORAGE_PUBLIC_ENDPOINT: ${raw}`); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error(`STORAGE_PUBLIC_ENDPOINT must be a bare http(s) origin such as https://storage.example.com: ${raw}`);
  }
  return url.origin;
}

function readOrigins(value: string | undefined, fallback: string[]): string[] {
  const raw = value?.trim();
  const candidates = raw
    ? raw.split(",").map((entry) => entry.trim()).filter(Boolean)
    : fallback;

  return candidates.map((origin) => {
    try {
      return new URL(origin).origin;
    } catch {
      throw new Error(`Invalid CORS_ALLOWED_ORIGINS entry: ${origin}`);
    }
  });
}

const weakSecretValues = new Set([
  "docslurp",
  "minioadmin",
  "metrics-secret",
  "dev-secret-change-me",
  "dev-oauth-key-change-me",
  "testtest",
  "password",
  "changeme",
]);

function assertProductionSecret(
  name: string,
  value: string | undefined,
  options: { required?: boolean; minLength?: number } = {},
): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  const required = options.required ?? true;
  const minLength = options.minLength ?? 24;
  const trimmed = value?.trim();
  if (!trimmed) {
    if (required) {
      throw new Error(`${name} is required in production`);
    }
    return;
  }

  if (trimmed.length < minLength || weakSecretValues.has(trimmed)) {
    throw new Error(`${name} must be a strong, non-default value in production`);
  }
}

function validateProductionSecrets(): void {
  // Object-storage credentials come from STORAGE_URI userinfo or AWS_* variables.
  const storage = resolveObjectStorageConfig();
  if (process.env.NODE_ENV === "production") {
    const problem = storageAccessKeyIdProblem(storage.accessKeyId);
    if (problem) {
      throw new Error(`STORAGE_URI access key ${problem} in production`);
    }
  }
  assertProductionSecret("STORAGE_URI secret key", storage.secretAccessKey);
  assertProductionSecret("METRICS_SECRET", process.env.METRICS_SECRET);
  assertProductionSecret("BETTER_AUTH_SECRET", process.env.BETTER_AUTH_SECRET, { minLength: 32 });
  // Optional override of the evidence-tag key (else derived from BETTER_AUTH_SECRET); weak when set fails.
  assertProductionSecret("EVIDENCE_TAG_KEY", process.env.EVIDENCE_TAG_KEY, { required: false, minLength: 32 });
  assertProductionSecret("CREDENTIALS_ENCRYPTION_KEY", process.env.CREDENTIALS_ENCRYPTION_KEY, { minLength: 32 });
  assertProductionSecret("SECRETS_ENCRYPTION_KEY", process.env.SECRETS_ENCRYPTION_KEY, { minLength: 32 });
  if (process.env.NODE_ENV === "production") {
    validateEncryptionConfiguration("CREDENTIALS_ENCRYPTION_KEY");
    validateEncryptionConfiguration("SECRETS_ENCRYPTION_KEY");
  }
  assertProductionSecret("OAUTH_TOKEN_ENCRYPTION_KEY", process.env.OAUTH_TOKEN_ENCRYPTION_KEY, {
    required: Boolean(process.env.GITHUB_CLIENT_ID || process.env.GOOGLE_CLIENT_ID),
    minLength: 32,
  });
}

validateProductionSecrets();

const storage = resolveObjectStorageConfig();

export const env = {
  chatMcpEnabled: readBoolean(process.env.DOCSLURP_CHAT_MCP_ENABLED, true),
  /** Public chat APIs (/v1/chat, its stream, chat completions) may run the bounded search agent. */
  publicChatAgentEnabled: readBoolean(process.env.DOCSLURP_PUBLIC_CHAT_AGENT_ENABLED, true),
  webMcpEnabled: readBoolean(process.env.DOCSLURP_WEBMCP_ENABLED, true),
  /** MCP Apps: the openUploader tool and its ui:// widget resource. Off removes both from every MCP surface. */
  mcpAppsUiEnabled: readBoolean(process.env.DOCSLURP_MCP_APPS_UI_ENABLED, false),
  /** Extra http(s) origins the widget sandbox may connect to (comma list), appended to the storage origins. */
  mcpUiConnectDomains: process.env.MCP_UI_CONNECT_DOMAINS ?? "",
  port: readNumber(process.env.PORT, 8787),
  databaseUrl: resolveDatabaseUrl(),
  apiUrl: process.env.API_URL ?? process.env.APP_URL ?? "http://localhost:4321",
  appUrl: process.env.APP_URL ?? "http://localhost:4321",
  corsAllowedOrigins: readOrigins(process.env.CORS_ALLOWED_ORIGINS, [
    process.env.APP_URL ?? "http://localhost:4321",
    "http://localhost:4321",
    "http://127.0.0.1:4321"
  ]),
  /** Object storage from STORAGE_URI (see @docslurp/shared connection-uri). */
  storage,
  /**
   * Browser-reachable endpoint that presigned upload URLs are signed against, for when
   * STORAGE_URI's endpoint only resolves inside the deployment (e.g. http://minio:9000).
   * Server-side storage calls keep using STORAGE_URI.
   */
  storagePublicEndpoint: readPublicEndpoint(process.env.STORAGE_PUBLIC_ENDPOINT),
  s3Bucket: storage.bucket,
  /** LanceDB root and storage options from LANCEDB_URI. */
  lancedb: resolveLanceDbConfig(process.env, storage),
  maxUploadBytes: readNumber(process.env.MAX_UPLOAD_BYTES, 500 * 1024 * 1024),
  /**
   * How many files of one direct-upload session are verified and sealed at once (a batched `files/complete` call, the
   * reconciler, a recovery read). Storage operations per file are independent; the session lock is held for the batch.
   */
  directUploadFinalizeConcurrency: Math.min(32, Math.max(1, Math.floor(readNumber(process.env.DOCSLURP_UPLOAD_FINALIZE_CONCURRENCY, 8)))),
  /**
   * Direct database connections (to DATABASE_URL, opened lazily as needed) that one API process may hold for
   * upload-session advisory locks: default 5, which is also the minimum (smaller values are raised to 5), maximum 64.
   * Two are kept for short operations; at 5 the rest are one slot each for batch, run-start and reconcile holders.
   * 8 (3 batch, 2 run-start slots) suits deployments with connection headroom. See lib/direct-upload-locks.ts. Count
   * them in the database's max_connections budget per API machine, twice during a deploy's overlap.
   */
  directUploadLockPoolMax: readNumber(process.env.DOCSLURP_UPLOAD_LOCK_POOL_MAX, 5),
  /** Concurrent run starts (confirms, idempotent intakes) holding a lock connection per process (default 1 at pool 5, 2 at 8). */
  directUploadLockStartMax: process.env.DOCSLURP_UPLOAD_LOCK_START_MAX ? readNumber(process.env.DOCSLURP_UPLOAD_LOCK_START_MAX, 2) : undefined,
  /** Concurrent run starts per organization in one process (default 1). */
  directUploadLockStartPerOrg: readNumber(process.env.DOCSLURP_UPLOAD_LOCK_START_PER_ORG, 1),
  /** Short lock holders (part signing, abort) per organization in one process (default 1 of the 2 short connections). */
  directUploadLockShortPerOrg: process.env.DOCSLURP_UPLOAD_LOCK_SHORT_PER_ORG ? readNumber(process.env.DOCSLURP_UPLOAD_LOCK_SHORT_PER_ORG, 1) : undefined,
  /** Concurrent idempotent bulk, URL and website intakes holding their Idempotency-Key lock per process (default 1 at pool 5, 2 at 8). */
  directUploadLockIntakeMax: process.env.DOCSLURP_UPLOAD_LOCK_INTAKE_MAX ? readNumber(process.env.DOCSLURP_UPLOAD_LOCK_INTAKE_MAX, 1) : undefined,
  /** Of those, per organization in one process (default 1). */
  directUploadLockIntakePerOrg: readNumber(process.env.DOCSLURP_UPLOAD_LOCK_INTAKE_PER_ORG, 1),
  /** Concurrent files/complete holders per process (default 1 at pool 5, 3 at 8). */
  directUploadLockBatchMax: process.env.DOCSLURP_UPLOAD_LOCK_BATCH_MAX ? readNumber(process.env.DOCSLURP_UPLOAD_LOCK_BATCH_MAX, 3) : undefined,
  /** Concurrent files/complete holders per organization in one process (default 2, at most the batch cap). */
  directUploadLockBatchPerOrg: readNumber(process.env.DOCSLURP_UPLOAD_LOCK_BATCH_PER_ORG, 2),
  /**
   * How long one lock hold keeps starting new files (default 5 s); files not started are answered retryable
   * `upload_session_busy`. Work already started may run to the hard cap below.
   */
  directUploadLockHoldBudgetMs: Math.max(250, readNumber(process.env.DOCSLURP_UPLOAD_LOCK_HOLD_BUDGET_MS, 5_000)),
  /** Hard cap on one lock hold's storage work: in-flight calls are cancelled after it (default 30 s). */
  directUploadLockHoldMaxMs: Math.max(1_000, readNumber(process.env.DOCSLURP_UPLOAD_LOCK_HOLD_MAX_MS, 30_000)),
  /**
   * Cap for the buffered multipart path (POST /v1/uploads/bulk). Hono's
   * parseBody holds the whole body in memory, so larger files must use direct
   * upload sessions (/v1/uploads/direct/sessions), which go straight to storage.
   */
  maxMultipartUploadBytes: Math.min(
    readNumber(process.env.MAX_MULTIPART_UPLOAD_BYTES, 25 * 1024 * 1024),
    readNumber(process.env.MAX_UPLOAD_BYTES, 500 * 1024 * 1024),
  ),
  remoteIngestComplexFormatsEnabled: readBoolean(process.env.REMOTE_INGEST_COMPLEX_FORMATS_ENABLED, false),
  web: resolveWebConfig(),
  metricsSecret: process.env.METRICS_SECRET?.trim() || null,
  mcpServerId: process.env.MCP_SERVER_ID ?? "docslurp-mcp"
};

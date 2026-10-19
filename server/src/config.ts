import "./env.js";

import { existsSync } from "node:fs";

import { resolveLanceDbConfig, resolveObjectStorageConfig } from "@docslurp/shared";

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
  assertProductionSecret("STORAGE_URI access key", storage.accessKeyId);
  assertProductionSecret("STORAGE_URI secret key", storage.secretAccessKey);
  assertProductionSecret("METRICS_SECRET", process.env.METRICS_SECRET);
  assertProductionSecret("BETTER_AUTH_SECRET", process.env.BETTER_AUTH_SECRET, { minLength: 32 });
  assertProductionSecret("CREDENTIALS_ENCRYPTION_KEY", process.env.CREDENTIALS_ENCRYPTION_KEY, { minLength: 32 });
  assertProductionSecret("SECRETS_ENCRYPTION_KEY", process.env.SECRETS_ENCRYPTION_KEY, { minLength: 32 });
  assertProductionSecret("OAUTH_TOKEN_ENCRYPTION_KEY", process.env.OAUTH_TOKEN_ENCRYPTION_KEY, {
    required: Boolean(process.env.GITHUB_CLIENT_ID || process.env.GOOGLE_CLIENT_ID),
    minLength: 32,
  });
}

validateProductionSecrets();

const storage = resolveObjectStorageConfig();

export const env = {
  chatMcpEnabled: readBoolean(process.env.DOCSLURP_CHAT_MCP_ENABLED, true),
  webMcpEnabled: readBoolean(process.env.DOCSLURP_WEBMCP_ENABLED, true),
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
  s3Bucket: storage.bucket,
  /** LanceDB root and storage options from LANCEDB_URI. */
  lancedb: resolveLanceDbConfig(process.env, storage),
  maxUploadBytes: readNumber(process.env.MAX_UPLOAD_BYTES, 500 * 1024 * 1024),
  /**
   * Cap for the buffered multipart path (POST /v1/ingest/bulk). Hono's
   * parseBody holds the whole body in memory, so larger files must use direct
   * upload sessions (/v1/ingest/direct/sessions), which go straight to storage.
   */
  maxMultipartUploadBytes: Math.min(
    readNumber(process.env.MAX_MULTIPART_UPLOAD_BYTES, 25 * 1024 * 1024),
    readNumber(process.env.MAX_UPLOAD_BYTES, 500 * 1024 * 1024),
  ),
  remoteIngestComplexFormatsEnabled: readBoolean(process.env.REMOTE_INGEST_COMPLEX_FORMATS_ENABLED, false),
  metricsSecret: process.env.METRICS_SECRET?.trim() || null,
  aiInteractiveLatencyMs: readNumber(process.env.AI_INTERACTIVE_LATENCY_MS, 8_000),
  aiKeyConcurrencyLimit: readNumber(process.env.AI_KEY_CONCURRENCY_LIMIT, 2),
  aiOrgConcurrencyLimit: readNumber(process.env.AI_ORG_CONCURRENCY_LIMIT, 8),
  mcpServerId: process.env.MCP_SERVER_ID ?? "docslurp-mcp"
};

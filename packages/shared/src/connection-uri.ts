/**
 * URI-based adapter configuration. Each storage adapter is configured by one
 * URI instead of a family of environment variables:
 *
 *   STORAGE_URI=s3://[ACCESS_KEY:SECRET@]bucket?endpoint=http://minio:9000&region=us-west-2
 *   LANCEDB_URI=s3://bucket/lancedb?region=auto          (or file:///var/lib/docslurp/lancedb, or a bare path)
 *
 * STORAGE_URI query parameters:
 *   endpoint                 S3-compatible endpoint (MinIO, R2, Tigris). Omit for AWS.
 *   region                   Default us-west-2.
 *   pathStyle                Path-style addressing. Default true.
 *   purgeSupersededSources   Also delete the raw upload of replaced document versions. Default false.
 *
 * LANCEDB_URI on s3:// inherits endpoint, region and credentials from
 * STORAGE_URI unless its own query overrides them; maintenance tuning is read
 * by the worker from the same query (see parseLanceDbUri).
 *
 * Credentials may be given in the URI userinfo (URL-encoded) or, as with any
 * AWS SDK, via AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY. Use redactUri()
 * before logging a URI.
 *
 * LANCEDB_STORAGE_URI (same shape as STORAGE_URI) gives the index its own
 * endpoint, region and credentials, so blobs can live on a store without
 * conditional writes (for example Backblaze B2) while LanceDB commits elsewhere.
 * S3_* variables tune the AWS SDK client; LANCEDB_* variables tune Lance's
 * object store (see resolveS3ClientTuning and resolveLanceDbConfig).
 *
 * The pre-URI variables (S3_BUCKET, AWS_ENDPOINT_URL_S3, AWS_REGION) are still
 * honored when STORAGE_URI is unset so existing deployments keep working.
 */

export interface ObjectStorageConfig {
  bucket: string;
  endpoint: string | null;
  region: string;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
  purgeSupersededSources: boolean;
  /** "uri" when STORAGE_URI was used, "legacy" when the pre-URI variables were. */
  source: "uri" | "legacy" | "default";
}

export interface LanceDbConfig {
  /** Storage root without the query string; per-org namespaces are appended to it. */
  root: string;
  /** Options for @lancedb/lancedb connect() (object-store keys). */
  storageOptions: Record<string, string> | undefined;
  /** Remaining query parameters, e.g. worker maintenance tuning. */
  params: URLSearchParams;
  /** Set for s3+ddb:// roots: Lance commits through this DynamoDB table (see lancedb-ddb.ts). */
  ddb?: LanceDdbConfig;
}

export interface LanceDdbConfig {
  table: string;
  /** DynamoDB region (the S3 side keeps its own region). */
  region: string;
  /** Separate DynamoDB credentials; empty means Lance reuses the S3 credentials for DynamoDB. */
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  /** Custom DynamoDB endpoint (DynamoDB Local). */
  endpoint?: string;
}

type Env = Record<string, string | undefined>;

const DEFAULT_BUCKET = "docslurp-files";
const DEFAULT_REGION = "us-west-2";
const DEFAULT_LOCAL_ENDPOINT = "http://localhost:9000";
const DEFAULT_DDB_REGION = "us-east-1";
const DEFAULT_LANCEDB_ROOT = "/tmp/docslurp-lancedb";

function readEnv(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readBoolean(value: string | null, fallback: boolean): boolean {
  if (value === null || value === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(value)) return true;
  if (/^(0|false|no|off)$/i.test(value)) return false;
  throw new Error(`Expected a boolean, received "${value}"`);
}

/** Replaces URI credentials with *** so URIs can be logged. */
export function redactUri(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) {
      url.username = url.username ? "***" : "";
      url.password = url.password ? "***" : "";
    }
    return url.toString();
  } catch {
    return value.replace(/\/\/[^@/]+@/, "//***@");
  }
}

/**
 * Inside Docker the MinIO host is `minio`; host processes reach it on
 * localhost. Mirrors the DATABASE_URL rewrite in the app and worker configs.
 */
export function rewriteMinioEndpointForHost(endpoint: string): string {
  if (isContainerRuntime()) return endpoint;
  try {
    const url = new URL(endpoint);
    if (url.hostname !== "minio") return endpoint;
    url.hostname = "localhost";
    return url.toString().replace(/\/$/, "");
  } catch {
    return endpoint;
  }
}

function isContainerRuntime(): boolean {
  // No static node:fs import: browser bundles also import @docslurp/shared.
  const fs = (globalThis as { process?: { getBuiltinModule?: (name: string) => unknown } }).process
    ?.getBuiltinModule?.("node:fs") as { existsSync(path: string): boolean } | undefined;
  return fs?.existsSync("/.dockerenv") ?? false;
}

let warnedLegacyStorage = false;

export function parseStorageUri(value: string, env: Env = process.env): ObjectStorageConfig {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`STORAGE_URI must be a URI like s3://bucket?endpoint=...; received ${redactUri(value)}`);
  }
  if (url.protocol !== "s3:") {
    throw new Error(`STORAGE_URI scheme must be s3:// (received ${url.protocol}//)`);
  }
  const bucket = decodeURIComponent(url.hostname);
  if (!bucket) throw new Error("STORAGE_URI must name a bucket: s3://bucket");
  if (url.pathname && url.pathname !== "/") {
    throw new Error("STORAGE_URI does not support a key prefix yet; use s3://bucket");
  }
  const endpoint = url.searchParams.get("endpoint");
  return {
    bucket,
    endpoint: endpoint ? rewriteMinioEndpointForHost(endpoint) : null,
    region: url.searchParams.get("region") || DEFAULT_REGION,
    forcePathStyle: readBoolean(url.searchParams.get("pathStyle"), true),
    accessKeyId: decodeURIComponent(url.username) || readEnv(env.AWS_ACCESS_KEY_ID) || "minioadmin",
    secretAccessKey: decodeURIComponent(url.password) || readEnv(env.AWS_SECRET_ACCESS_KEY) || "minioadmin",
    purgeSupersededSources: readBoolean(url.searchParams.get("purgeSupersededSources"), false),
    source: "uri",
  };
}

/** Object storage from STORAGE_URI, falling back to the pre-URI variables. */
export function resolveObjectStorageConfig(env: Env = process.env): ObjectStorageConfig {
  const uri = readEnv(env.STORAGE_URI);
  if (uri) return parseStorageUri(uri, env);

  const legacy = readEnv(env.S3_BUCKET) ?? readEnv(env.AWS_ENDPOINT_URL_S3);
  if (legacy && !warnedLegacyStorage) {
    warnedLegacyStorage = true;
    console.warn("[config] S3_BUCKET / AWS_ENDPOINT_URL_S3 / AWS_REGION are deprecated; set STORAGE_URI=s3://bucket?endpoint=...&region=...");
  }
  return {
    bucket: readEnv(env.S3_BUCKET) ?? DEFAULT_BUCKET,
    endpoint: rewriteMinioEndpointForHost(readEnv(env.AWS_ENDPOINT_URL_S3) ?? DEFAULT_LOCAL_ENDPOINT),
    region: readEnv(env.AWS_REGION) ?? DEFAULT_REGION,
    forcePathStyle: true,
    accessKeyId: readEnv(env.AWS_ACCESS_KEY_ID) ?? "minioadmin",
    secretAccessKey: readEnv(env.AWS_SECRET_ACCESS_KEY) ?? "minioadmin",
    purgeSupersededSources: false,
    source: legacy ? "legacy" : "default",
  };
}

function readInt(env: Env, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number | undefined {
  const raw = readEnv(env[name]);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; received "${raw}"`);
  }
  return value;
}

function readEnvBoolean(env: Env, name: string): boolean | undefined {
  const raw = readEnv(env[name]);
  return raw === undefined ? undefined : readBoolean(raw, false);
}

export type S3ChecksumMode = "when_supported" | "when_required";

/** Optional S3 client tuning from S3_* variables; every field is undefined unless set. */
export interface S3ClientTuning {
  maxSockets?: number;
  keepAlive?: boolean;
  keepAliveInitialDelayMs?: number;
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  socketTimeoutMs?: number;
  maxAttempts?: number;
  retryMode?: "standard" | "adaptive";
  checksumMode?: S3ChecksumMode;
  forcePathStyle?: boolean;
  /** Multipart part size in bytes for streamed uploads (server). */
  multipartPartSizeBytes?: number;
}

/**
 * Reads S3 client tuning:
 *   S3_MAX_SOCKETS, S3_KEEPALIVE, S3_KEEPALIVE_INITIAL_DELAY_MS,
 *   S3_CONNECTION_TIMEOUT_MS, S3_REQUEST_TIMEOUT_MS, S3_SOCKET_TIMEOUT_MS,
 *   S3_MAX_ATTEMPTS, S3_RETRY_MODE (standard|adaptive),
 *   S3_CHECKSUM_MODE (when_supported|when_required),
 *   S3_FORCE_PATH_STYLE (overrides STORAGE_URI pathStyle),
 *   S3_MULTIPART_PART_SIZE_MB (5-5120).
 * Unset variables leave the AWS SDK defaults untouched.
 */
export function resolveS3ClientTuning(env: Env = process.env): S3ClientTuning {
  const retryMode = readEnv(env.S3_RETRY_MODE)?.toLowerCase();
  if (retryMode && retryMode !== "standard" && retryMode !== "adaptive") {
    throw new Error(`S3_RETRY_MODE must be standard or adaptive; received "${retryMode}"`);
  }
  const checksum = readEnv(env.S3_CHECKSUM_MODE)?.toLowerCase();
  if (checksum && checksum !== "when_supported" && checksum !== "when_required") {
    throw new Error(`S3_CHECKSUM_MODE must be when_supported or when_required; received "${checksum}"`);
  }
  const partMb = readInt(env, "S3_MULTIPART_PART_SIZE_MB", 5, 5120);
  const tuning: S3ClientTuning = {
    maxSockets: readInt(env, "S3_MAX_SOCKETS", 1),
    keepAlive: readEnvBoolean(env, "S3_KEEPALIVE"),
    keepAliveInitialDelayMs: readInt(env, "S3_KEEPALIVE_INITIAL_DELAY_MS", 0),
    connectionTimeoutMs: readInt(env, "S3_CONNECTION_TIMEOUT_MS", 1),
    requestTimeoutMs: readInt(env, "S3_REQUEST_TIMEOUT_MS", 1),
    socketTimeoutMs: readInt(env, "S3_SOCKET_TIMEOUT_MS", 1),
    maxAttempts: readInt(env, "S3_MAX_ATTEMPTS", 1, 20),
    retryMode: retryMode as S3ClientTuning["retryMode"],
    checksumMode: checksum as S3ChecksumMode | undefined,
    forcePathStyle: readEnvBoolean(env, "S3_FORCE_PATH_STYLE"),
    multipartPartSizeBytes: partMb === undefined ? undefined : partMb * 1024 * 1024,
  };
  for (const key of Object.keys(tuning) as Array<keyof S3ClientTuning>) if (tuning[key] === undefined) delete tuning[key];
  return tuning;
}

/**
 * Builds the S3Client configuration shared by every object-storage client.
 * Tuning comes from S3_* variables (see resolveS3ClientTuning); with none set
 * the result is the plain region/endpoint/credentials configuration.
 */
export function s3ClientConfig(storage: ObjectStorageConfig, env: Env = process.env) {
  const tuning = resolveS3ClientTuning(env);
  const agentOptions = {
    ...(tuning.maxSockets !== undefined ? { maxSockets: tuning.maxSockets } : {}),
    ...(tuning.keepAlive !== undefined ? { keepAlive: tuning.keepAlive } : {}),
    ...(tuning.keepAliveInitialDelayMs !== undefined ? { keepAliveMsecs: tuning.keepAliveInitialDelayMs } : {}),
  };
  const handlerOptions = {
    ...(tuning.connectionTimeoutMs !== undefined ? { connectionTimeout: tuning.connectionTimeoutMs } : {}),
    ...(tuning.requestTimeoutMs !== undefined ? { requestTimeout: tuning.requestTimeoutMs } : {}),
    ...(tuning.socketTimeoutMs !== undefined ? { socketTimeout: tuning.socketTimeoutMs } : {}),
    ...(Object.keys(agentOptions).length ? { httpAgent: agentOptions, httpsAgent: agentOptions } : {}),
  };
  const checksum = tuning.checksumMode === undefined ? undefined : (tuning.checksumMode.toUpperCase() as "WHEN_SUPPORTED" | "WHEN_REQUIRED");
  return {
    region: storage.region,
    ...(storage.endpoint ? { endpoint: storage.endpoint } : {}),
    forcePathStyle: tuning.forcePathStyle ?? storage.forcePathStyle,
    credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
    ...(Object.keys(handlerOptions).length ? { requestHandler: handlerOptions } : {}),
    ...(tuning.maxAttempts !== undefined ? { maxAttempts: tuning.maxAttempts } : {}),
    ...(tuning.retryMode ? { retryMode: tuning.retryMode } : {}),
    ...(checksum ? { requestChecksumCalculation: checksum, responseChecksumValidation: checksum } : {}),
  };
}

const LANCE_STORAGE_PARAMS = new Set(["endpoint", "region", "allowHttp", "ddbTableName"]);

/**
 * Splits LANCEDB_URI into a storage root (query removed, safe to append
 * per-org paths to) and connect() storage options. s3:// roots inherit
 * endpoint, region and credentials from object storage unless overridden.
 */
export function parseLanceDbUri(value: string | undefined, storage?: ObjectStorageConfig): LanceDbConfig {
  const raw = value?.trim() || DEFAULT_LANCEDB_ROOT;
  const queryIndex = raw.indexOf("?");
  const base = queryIndex < 0 ? raw : raw.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex < 0 ? "" : raw.slice(queryIndex + 1));
  const root = base.startsWith("file://") ? decodeURIComponent(new URL(base).pathname) : base.replace(/\/+$/, "");

  let storageOptions: Record<string, string> | undefined;
  if (/^(s3|s3a|s3\+ddb|gs|az):\/\//.test(root)) {
    const endpoint = params.get("endpoint") ?? (root.startsWith("s3") ? storage?.endpoint ?? null : null);
    const region = params.get("region") ?? (root.startsWith("s3") ? storage?.region ?? "auto" : null);
    storageOptions = {
      ...(region ? { region } : {}),
      ...(endpoint ? { endpoint, allow_http: String(params.get("allowHttp") ?? endpoint.startsWith("http://")) } : {}),
      ...(root.startsWith("s3") && storage
        ? { aws_access_key_id: storage.accessKeyId, aws_secret_access_key: storage.secretAccessKey }
        : {}),
    };
  }

  const remaining = new URLSearchParams();
  for (const [key, entry] of params) if (!LANCE_STORAGE_PARAMS.has(key)) remaining.append(key, entry);
  const ddbTable = params.get("ddbTableName") ?? undefined;
  return { root, storageOptions, params: remaining, ...(ddbTable ? { ddb: { table: ddbTable, region: DEFAULT_DDB_REGION } } : {}) };
}

/** LanceDB config from LANCEDB_URI plus the shared object storage settings. */
export function resolveLanceDbConfig(env: Env = process.env, storage = resolveObjectStorageConfig(env)): LanceDbConfig {
  const lanceStorageUri = readEnv(env.LANCEDB_STORAGE_URI);
  if (!lanceStorageUri) return applyLanceDdbEnv(withLanceTuning(parseLanceDbUri(withDdbScheme(env.LANCEDB_URI, env), storage), env), env);
  // Separate index store: its own endpoint, region and credentials. When
  // LANCEDB_URI is unset the index lives at s3://<LANCEDB_STORAGE_URI bucket>/lancedb.
  let lanceStorage: ObjectStorageConfig;
  try {
    lanceStorage = parseStorageUri(lanceStorageUri, env);
  } catch (error) {
    throw new Error(String(error instanceof Error ? error.message : error).replace("STORAGE_URI", "LANCEDB_STORAGE_URI"));
  }
  const root = readEnv(env.LANCEDB_URI) ?? `s3://${lanceStorage.bucket}/lancedb`;
  return applyLanceDdbEnv(withLanceTuning(parseLanceDbUri(withDdbScheme(root, env), lanceStorage), env), env);
}

/** LANCEDB_DDB_TABLE turns an s3:// Lance root into s3+ddb:// (external DynamoDB commit store). */
function withDdbScheme(root: string | undefined, env: Env): string | undefined {
  if (!root || !readEnv(env.LANCEDB_DDB_TABLE)) return root;
  return root.startsWith("s3://") ? `s3+ddb://${root.slice("s3://".length)}` : root;
}

/**
 * s3+ddb:// commit store settings:
 *   LANCEDB_DDB_TABLE (or ?ddbTableName= on LANCEDB_URI), LANCEDB_DDB_REGION (default us-east-1),
 *   LANCEDB_DDB_ACCESS_KEY_ID / LANCEDB_DDB_SECRET_ACCESS_KEY / LANCEDB_DDB_SESSION_TOKEN (optional; both keys
 *   required together; without them Lance uses the object-store credentials for DynamoDB), LANCEDB_DDB_ENDPOINT.
 */
function applyLanceDdbEnv(config: LanceDbConfig, env: Env): LanceDbConfig {
  if (!config.root.startsWith("s3+ddb://")) {
    if (readEnv(env.LANCEDB_DDB_TABLE) && !config.root.startsWith("s3")) throw new Error("LANCEDB_DDB_TABLE requires an s3:// or s3+ddb:// LanceDB root");
    return config;
  }
  const table = readEnv(env.LANCEDB_DDB_TABLE) ?? config.ddb?.table;
  if (!table) throw new Error("s3+ddb:// LANCEDB_URI needs a DynamoDB table: set LANCEDB_DDB_TABLE or ?ddbTableName=");
  const accessKeyId = readEnv(env.LANCEDB_DDB_ACCESS_KEY_ID);
  const secretAccessKey = readEnv(env.LANCEDB_DDB_SECRET_ACCESS_KEY);
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) throw new Error("LANCEDB_DDB_ACCESS_KEY_ID and LANCEDB_DDB_SECRET_ACCESS_KEY must be set together");
  return {
    ...config,
    ddb: {
      table,
      region: readEnv(env.LANCEDB_DDB_REGION) ?? DEFAULT_DDB_REGION,
      ...(accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : {}),
      ...(readEnv(env.LANCEDB_DDB_SESSION_TOKEN) ? { sessionToken: readEnv(env.LANCEDB_DDB_SESSION_TOKEN) } : {}),
      ...(readEnv(env.LANCEDB_DDB_ENDPOINT) ? { endpoint: readEnv(env.LANCEDB_DDB_ENDPOINT) } : {}),
    },
  };
}

/**
 * Optional LanceDB object-store tuning, merged into s3 storage options:
 *   LANCEDB_CONNECT_TIMEOUT_SECONDS, LANCEDB_REQUEST_TIMEOUT_SECONDS,
 *   LANCEDB_CLIENT_MAX_RETRIES, LANCEDB_POOL_MAX_IDLE_PER_HOST.
 */
function withLanceTuning(config: LanceDbConfig, env: Env): LanceDbConfig {
  if (!config.storageOptions) return config;
  const extra: Record<string, string> = {};
  const connect = readInt(env, "LANCEDB_CONNECT_TIMEOUT_SECONDS", 1);
  const request = readInt(env, "LANCEDB_REQUEST_TIMEOUT_SECONDS", 1);
  const retries = readInt(env, "LANCEDB_CLIENT_MAX_RETRIES", 0, 100);
  const idle = readInt(env, "LANCEDB_POOL_MAX_IDLE_PER_HOST", 0);
  if (connect !== undefined) extra.connect_timeout = `${connect}s`;
  if (request !== undefined) extra.timeout = `${request}s`;
  if (retries !== undefined) extra.client_max_retries = String(retries);
  if (idle !== undefined) extra.pool_max_idle_per_host = String(idle);
  return Object.keys(extra).length ? { ...config, storageOptions: { ...config.storageOptions, ...extra } } : config;
}

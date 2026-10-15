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
}

type Env = Record<string, string | undefined>;

const DEFAULT_BUCKET = "docslurp-files";
const DEFAULT_REGION = "us-west-2";
const DEFAULT_LOCAL_ENDPOINT = "http://localhost:9000";
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

/** Builds the S3Client configuration shared by every object-storage client. */
export function s3ClientConfig(storage: ObjectStorageConfig) {
  return {
    region: storage.region,
    ...(storage.endpoint ? { endpoint: storage.endpoint } : {}),
    forcePathStyle: storage.forcePathStyle,
    credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
  };
}

const LANCE_STORAGE_PARAMS = new Set(["endpoint", "region", "allowHttp"]);

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
  if (/^(s3|s3a|gs|az):\/\//.test(root)) {
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
  return { root, storageOptions, params: remaining };
}

/** LanceDB config from LANCEDB_URI plus the shared object storage settings. */
export function resolveLanceDbConfig(env: Env = process.env, storage = resolveObjectStorageConfig(env)): LanceDbConfig {
  return parseLanceDbUri(env.LANCEDB_URI, storage);
}

// Prebuilt vendor bundles: heavy, optional extractor stacks (Docling,
// Unstructured, their models) published as content-addressed .tar.zst
// archives and unpacked on demand, so installing one is a download and an
// unzip instead of a pip resolve.
//
// Trust root: worker/vendor-bundles.json, baked into the image. It pins each
// artifact's sha256 and size. The object store only serves bytes; an archive
// whose digest does not match is discarded before it is unpacked, so a
// compromised bucket cannot inject code. See docs/worker-image.md.
//
// Flags:
//   DOCSLURP_VENDOR_BUNDLES=on|off        (default: on when a base URL is set)
//   DOCSLURP_VENDOR_BUNDLE_BASE_URL       https://host/prefix, file:///dir, or
//                                         s3://bucket/optional-prefix (private bucket, see below)
//   DOCSLURP_VENDOR_BUNDLE_S3_ENDPOINT    S3-compatible endpoint, e.g. https://s3.us-west-004.backblazeb2.com
//   DOCSLURP_VENDOR_BUNDLE_S3_REGION      e.g. us-west-004
//   DOCSLURP_VENDOR_BUNDLE_S3_ACCESS_KEY_ID / _SECRET_ACCESS_KEY   read-only key for that bucket
//   DOCSLURP_VENDOR_BUNDLE_PREFETCH       comma list of bundles to install in the background at boot
//   DOCSLURP_VENDOR_BUNDLE_DIR            cache dir (default /data/docslurp/vendor-bundles
//                                         when /data is writable, else ~/.cache/docslurp/vendor-bundles)
//   DOCSLURP_VENDOR_BUNDLE_TIMEOUT_MS     download + unpack budget (default 600000)

import { createHash, randomBytes } from "node:crypto";
import { constants, createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, rename, rm, stat, statfs, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

import { extractTarSafely } from "./safe-tar.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface VendorBundleArtifact {
  /** Platform key, e.g. "linux-x64-py3.13" (see currentBundlePlatform). */
  platform: string;
  sha256: string;
  /** Compressed archive size in bytes. */
  size: number;
  /** Sum of regular-file sizes inside the archive. */
  unpackedSize: number;
  /** Informational file name; the object key is content-addressed. */
  file?: string;
}

export interface VendorBundleDefinition {
  description?: string;
  version?: string;
  /** Executables the bundle provides under bin/. */
  binaries?: string[];
  /** Top-level import names the bundle provides under site-packages/. */
  pythonModules?: string[];
  /** PyPI distribution names the bundle provides (matches "pip install X" hints). */
  distributions?: string[];
  /**
   * Environment for commands that use the bundle. Values starting with "./" are
   * paths inside the unpacked bundle (e.g. HF_HOME = "./models/hf").
   */
  env?: Record<string, string>;
  artifacts: VendorBundleArtifact[];
}

export interface VendorBundleManifest {
  schemaVersion: 1;
  bundles: Record<string, VendorBundleDefinition>;
}

export interface InstalledVendorBundle {
  name: string;
  sha256: string;
  root: string;
  binDir: string;
  sitePackages: string;
  /** Resolved `env` from the manifest. */
  env: Record<string, string>;
}

export class VendorBundleUnavailableError extends Error {
  constructor(
    readonly bundle: string,
    readonly reason: string,
  ) {
    super(`vendor bundle "${bundle}" unavailable: ${reason}`);
    this.name = "VendorBundleUnavailableError";
  }
}

/** Variables a bundle may never set: loader, interpreter and credential controls. */
export const FORBIDDEN_ENV = /^(PATH|PYTHONPATH|PYTHONHOME|PYTHONSTARTUP|PYTHONUSERBASE|NODE_OPTIONS|BASH_ENV|ENV|HOME|TMPDIR|LD_.*|DYLD_.*|AWS_.*|DOCSLURP_VENDOR_BUNDLE.*|DATABASE_URL|STORAGE_URI|.*TOKEN.*|.*SECRET.*|.*PASSWORD.*|.*CREDENTIAL.*|.*KEY.*)$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA_PATTERN = /^[0-9a-f]{64}$/;
const MARKER = ".docslurp-bundle.json";
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const LOCK_STALE_MS = 2 * 60_000;
const LOCK_HEARTBEAT_MS = 15_000;
const FAILURE_COOLDOWN_MS = 5 * 60_000;
const MAX_ENTRIES = 400_000;

function workerRoot(): string {
  return path.resolve(here, "..", "..");
}

export function validateManifest(value: unknown): VendorBundleManifest {
  const manifest = value as VendorBundleManifest;
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.bundles !== "object" || manifest.bundles === null) {
    throw new Error("vendor bundle manifest needs schemaVersion 1 and a bundles object");
  }
  for (const [name, bundle] of Object.entries(manifest.bundles)) {
    if (!NAME_PATTERN.test(name)) throw new Error(`invalid vendor bundle name "${name}"`);
    if (!Array.isArray(bundle.artifacts)) throw new Error(`vendor bundle "${name}" needs an artifacts array`);
    for (const [key, value] of Object.entries(bundle.env ?? {})) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || FORBIDDEN_ENV.test(key)) throw new Error(`vendor bundle "${name}" may not set env ${key}`);
      if (typeof value !== "string" || value.includes("\0") || (value.startsWith("./") && value.split("/").includes(".."))) {
        throw new Error(`vendor bundle "${name}" has an invalid value for env ${key}`);
      }
    }
    for (const binary of bundle.binaries ?? []) {
      if (!/^[A-Za-z0-9_.-]+$/.test(binary)) throw new Error(`vendor bundle "${name}" has invalid binary "${binary}"`);
    }
    for (const artifact of bundle.artifacts) {
      if (!SHA_PATTERN.test(artifact.sha256 ?? "")) throw new Error(`vendor bundle "${name}" artifact needs a 64-hex sha256`);
      if (!/^[a-z0-9.-]+$/.test(artifact.platform ?? "")) throw new Error(`vendor bundle "${name}" artifact has invalid platform`);
      for (const field of ["size", "unpackedSize"] as const) {
        if (!Number.isSafeInteger(artifact[field]) || artifact[field] <= 0) throw new Error(`vendor bundle "${name}" artifact needs a positive ${field}`);
      }
    }
  }
  return manifest;
}

let cachedManifest: VendorBundleManifest | null = null;

export function loadVendorBundleManifest(file = path.join(workerRoot(), "vendor-bundles.json")): VendorBundleManifest {
  if (cachedManifest && file === path.join(workerRoot(), "vendor-bundles.json")) return cachedManifest;
  const manifest = existsSync(file)
    ? validateManifest(JSON.parse(readFileSync(file, "utf8")))
    : { schemaVersion: 1 as const, bundles: {} };
  if (file === path.join(workerRoot(), "vendor-bundles.json")) cachedManifest = manifest;
  return manifest;
}

/**
 * Whether vendor bundles (or one named bundle) may be fetched. DOCSLURP_VENDOR_BUNDLES
 * is "on" (default once a base URL is set), "off", or a comma list of bundle names
 * (e.g. "unstructured") so a deployment can enable one extractor at a time.
 */
export function vendorBundlesEnabled(env: NodeJS.ProcessEnv = process.env, name?: string): boolean {
  if (!env.DOCSLURP_VENDOR_BUNDLE_BASE_URL?.trim()) return false;
  const flag = (env.DOCSLURP_VENDOR_BUNDLES ?? "").trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(flag)) return false;
  if (flag === "" || ["1", "true", "on", "yes", "all"].includes(flag)) return true;
  if (name === undefined) return true;
  return flag.split(",").map((item) => item.trim()).includes(name);
}

/** Platform key for this process: OS, CPU architecture and the worker Python's minor version. */
export function currentBundlePlatform(env: NodeJS.ProcessEnv = process.env): string {
  const python = env.DOCSLURP_VENDOR_BUNDLE_PYTHON?.trim() || "3.13";
  return `${process.platform}-${process.arch}-py${python}`;
}

export function resolveBundleBaseUrl(raw: string): URL {
  const url = new URL(raw.endsWith("/") ? raw : `${raw}/`);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:" || url.protocol === "file:" || (url.protocol === "http:" && loopback)) return url;
  throw new Error(`vendor bundle base URL must be https:// or file:// (http only for loopback), got ${url.protocol}`);
}

export interface S3BundleSource {
  bucket: string;
  /** Key prefix without leading or trailing slash ("" for none). */
  prefix: string;
  endpoint?: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export function isS3BundleBase(raw: string): boolean {
  return /^s3:\/\//i.test(raw.trim());
}

/** Parse `s3://bucket/prefix` plus the DOCSLURP_VENDOR_BUNDLE_S3_* variables. Never logs the credentials. */
export function resolveS3BundleSource(raw: string, env: NodeJS.ProcessEnv = process.env): S3BundleSource {
  const url = new URL(raw.trim());
  if (url.protocol !== "s3:" || !url.hostname) throw new Error("vendor bundle S3 base must look like s3://bucket/optional-prefix");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("vendor bundle S3 base may not contain credentials, a query or a fragment; use DOCSLURP_VENDOR_BUNDLE_S3_* variables");
  }
  const prefix = decodeURIComponent(url.pathname).split("/").filter(Boolean).join("/");
  if (prefix.split("/").includes("..")) throw new Error("vendor bundle S3 prefix may not contain ..");
  const read = (name: string) => env[`DOCSLURP_VENDOR_BUNDLE_S3_${name}`]?.trim() ?? "";
  const endpoint = read("ENDPOINT");
  if (endpoint) {
    const parsed = new URL(endpoint);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
      throw new Error("DOCSLURP_VENDOR_BUNDLE_S3_ENDPOINT must be https:// (http only for loopback)");
    }
  }
  const region = read("REGION");
  const accessKeyId = read("ACCESS_KEY_ID");
  const secretAccessKey = read("SECRET_ACCESS_KEY");
  const missing = [["REGION", region], ["ACCESS_KEY_ID", accessKeyId], ["SECRET_ACCESS_KEY", secretAccessKey]].filter(([, value]) => !value).map(([name]) => `DOCSLURP_VENDOR_BUNDLE_S3_${name}`);
  if (missing.length) throw new Error(`private vendor bundle bucket needs ${missing.join(", ")}`);
  return { bucket: url.hostname, prefix, endpoint: endpoint || undefined, region, accessKeyId, secretAccessKey };
}

export function bundleObjectKey(source: Pick<S3BundleSource, "prefix">, name: string, sha256: string): string {
  return `${source.prefix ? `${source.prefix}/` : ""}${name}/${sha256}.tar.zst`;
}

/** Strip URL query strings (signed URLs) and literal credential values from text that may be logged. */
export function redactVendorBundleText(text: string, env: NodeJS.ProcessEnv = process.env): string {
  let out = text.replace(/(https?:\/\/[^\s"'<>?]+)\?[^\s"'<>]*/gi, "$1?<redacted>");
  for (const name of ["ACCESS_KEY_ID", "SECRET_ACCESS_KEY"]) {
    const value = env[`DOCSLURP_VENDOR_BUNDLE_S3_${name}`]?.trim();
    if (value) out = out.split(value).join("<redacted>");
  }
  return out;
}

export function bundleObjectUrl(base: URL, name: string, sha256: string): URL {
  return new URL(`${name}/${sha256}.tar.zst`, base);
}

/** Pick the cache directory: explicit, then a writable /data volume, then the user's cache. */
export async function resolveBundleCacheDir(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const explicit = env.DOCSLURP_VENDOR_BUNDLE_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  try {
    await access("/data", constants.W_OK);
    return "/data/docslurp/vendor-bundles";
  } catch {
    const cacheHome = env.XDG_CACHE_HOME?.trim() || path.join(env.HOME?.trim() || homedir(), ".cache");
    return path.join(cacheHome, "docslurp", "vendor-bundles");
  }
}

export function findBundleForBinary(binary: string, manifest = loadVendorBundleManifest(), platform = currentBundlePlatform()): string | null {
  for (const [name, bundle] of Object.entries(manifest.bundles)) {
    if (bundle.binaries?.includes(binary) && bundle.artifacts.some((artifact) => artifact.platform === platform)) return name;
  }
  return null;
}

/** Match a missing import root or "pip install X" distribution to a bundle that provides it. */
export function findBundleForPythonModule(moduleOrDistribution: string, manifest = loadVendorBundleManifest(), platform = currentBundlePlatform()): string | null {
  const normalized = moduleOrDistribution.trim().toLowerCase().replace(/[-_.]+/g, "-");
  for (const [name, bundle] of Object.entries(manifest.bundles)) {
    if (!bundle.artifacts.some((artifact) => artifact.platform === platform)) continue;
    const names = [...(bundle.pythonModules ?? []), ...(bundle.distributions ?? [])].map((item) => item.toLowerCase().replace(/[-_.]+/g, "-"));
    if (names.includes(normalized)) return name;
  }
  return null;
}

function installedPaths(name: string, sha256: string, root: string, definition?: VendorBundleDefinition): InstalledVendorBundle {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(definition?.env ?? {})) {
    env[key] = value.startsWith("./") ? path.join(root, value.slice(2)) : value;
  }
  return { name, sha256, root, binDir: path.join(root, "bin"), sitePackages: path.join(root, "site-packages"), env };
}

async function readMarker(root: string): Promise<{ sha256?: string } | null> {
  try {
    return JSON.parse(await readFile(path.join(root, MARKER), "utf8")) as { sha256?: string };
  } catch {
    return null;
  }
}

/** Return the bundle when it is already unpacked and verified on this machine; never downloads. */
export async function installedVendorBundle(name: string, options: { env?: NodeJS.ProcessEnv; manifest?: VendorBundleManifest } = {}): Promise<InstalledVendorBundle | null> {
  const env = options.env ?? process.env;
  const definition = (options.manifest ?? loadVendorBundleManifest()).bundles[name];
  const artifact = definition?.artifacts.find((item) => item.platform === currentBundlePlatform(env));
  if (!artifact) return null;
  const root = path.join(await resolveBundleCacheDir(env), `${name}-${artifact.sha256.slice(0, 16)}`);
  const marker = await readMarker(root);
  return marker?.sha256 === artifact.sha256 ? installedPaths(name, artifact.sha256, root, definition) : null;
}

class HashingLimit extends Transform {
  readonly hash = createHash("sha256");
  bytes = 0;
  constructor(private readonly limit: number) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void) {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) {
      callback(new Error(`download exceeded the pinned size of ${this.limit} bytes`));
      return;
    }
    this.hash.update(chunk);
    callback(null, chunk);
  }
}

async function openS3Object(source: S3BundleSource, key: string, artifact: VendorBundleArtifact, signal: AbortSignal): Promise<Readable> {
  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const client = new S3Client({
    region: source.region,
    endpoint: source.endpoint,
    forcePathStyle: true,
    maxAttempts: 2,
    credentials: { accessKeyId: source.accessKeyId, secretAccessKey: source.secretAccessKey },
  });
  signal.addEventListener("abort", () => client.destroy(), { once: true });
  let response;
  try {
    response = await client.send(new GetObjectCommand({ Bucket: source.bucket, Key: key }), { abortSignal: signal });
  } catch (error) {
    const err = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    const status = err.$metadata?.httpStatusCode;
    const hint = status === 404 || err.name === "NoSuchKey" ? "object not found" : status === 401 || status === 403 ? "access denied (check the read-only key)" : (err.name ?? "request failed");
    throw new Error(`GET s3://${source.bucket}/${key} failed: ${hint}${status ? ` (HTTP ${status})` : ""}`);
  }
  if (typeof response.ContentLength === "number" && response.ContentLength > artifact.size) {
    throw new Error(`download exceeded the pinned size of ${artifact.size} bytes`);
  }
  if (!(response.Body instanceof Readable)) throw new Error(`GET s3://${source.bucket}/${key} returned no body`);
  response.Body.once("close", () => client.destroy());
  return response.Body;
}

async function downloadVerified(source: URL | { s3: S3BundleSource; key: string }, artifact: VendorBundleArtifact, destination: string, signal: AbortSignal): Promise<void> {
  let body: Readable;
  if (!(source instanceof URL)) {
    body = await openS3Object(source.s3, source.key, artifact, signal);
  } else if (source.protocol === "file:") {
    const url = source;
    body = createReadStream(fileURLToPath(url));
  } else {
    const url = source;
    const response = await fetch(url, { signal, redirect: "error" });
    if (!response.ok || !response.body) throw new Error(`GET ${url.origin}${url.pathname} returned HTTP ${response.status}`);
    body = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
  }
  const meter = new HashingLimit(artifact.size);
  await pipeline(body, meter, createWriteStream(destination, { flags: "wx", mode: 0o600 }), { signal });
  if (meter.bytes !== artifact.size) throw new Error(`size mismatch: expected ${artifact.size} bytes, got ${meter.bytes}`);
  const digest = meter.hash.digest("hex");
  if (digest !== artifact.sha256) throw new Error(`sha256 mismatch: expected ${artifact.sha256}, got ${digest}`);
}

async function ensureFreeSpace(dir: string, needed: number): Promise<void> {
  const info = await statfs(dir).catch(() => null);
  if (!info) return;
  const free = info.bavail * info.bsize;
  if (free < needed) {
    throw new Error(`not enough disk space in ${dir}: need ${Math.ceil(needed / 1048576)} MiB, ${Math.floor(free / 1048576)} MiB free`);
  }
}

async function acquireLock(lockDir: string, isDone: () => Promise<boolean>, signal: AbortSignal): Promise<"acquired" | "done"> {
  for (;;) {
    if (signal.aborted) throw new Error("timed out waiting for another process to unpack the bundle");
    try {
      await mkdir(lockDir);
      return "acquired";
    } catch (error) {
      // EACCES/EROFS/ENOENT never resolve by waiting: fail now, not at the deadline.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (await isDone()) return "done";
    const info = await stat(lockDir).catch(() => null);
    if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
      await rm(lockDir, { recursive: true, force: true });
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function installBundle(name: string, definition: VendorBundleDefinition, artifact: VendorBundleArtifact, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<InstalledVendorBundle> {
  const rawBase = env.DOCSLURP_VENDOR_BUNDLE_BASE_URL!.trim();
  const source = isS3BundleBase(rawBase)
    ? (() => {
        const s3 = resolveS3BundleSource(rawBase, env);
        return { s3, key: bundleObjectKey(s3, name, artifact.sha256) };
      })()
    : bundleObjectUrl(resolveBundleBaseUrl(rawBase), name, artifact.sha256);
  const cacheDir = await resolveBundleCacheDir(env);
  const root = path.join(cacheDir, `${name}-${artifact.sha256.slice(0, 16)}`);
  const done = async () => (await readMarker(root))?.sha256 === artifact.sha256;
  if (await done()) return installedPaths(name, artifact.sha256, root, definition);

  const signal = AbortSignal.timeout(timeoutMs);
  await mkdir(cacheDir, { recursive: true, mode: 0o755 });
  const lockDir = path.join(cacheDir, `.lock-${artifact.sha256}`);
  if ((await acquireLock(lockDir, done, signal)) === "done") return installedPaths(name, artifact.sha256, root, definition);
  const heartbeat = setInterval(() => {
    const now = new Date();
    void utimes(lockDir, now, now).catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  // Holding the lock for this sha, any earlier download/staging leftovers for it are
  // orphans from a crashed process; remove them so a persistent cache does not fill up.
  for (const entry of await readdir(cacheDir).catch(() => [] as string[])) {
    if (entry.startsWith(`.download-${artifact.sha256}-`) || entry.startsWith(`.staging-${artifact.sha256}-`)) {
      await rm(path.join(cacheDir, entry), { recursive: true, force: true }).catch(() => {});
    }
  }
  const nonce = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const archive = path.join(cacheDir, `.download-${artifact.sha256}-${nonce}.tar.zst`);
  const staging = path.join(cacheDir, `.staging-${artifact.sha256}-${nonce}`);
  try {
    if (await done()) return installedPaths(name, artifact.sha256, root, definition);
    await ensureFreeSpace(cacheDir, artifact.size + artifact.unpackedSize + 64 * 1048576);
    const started = Date.now();
    await downloadVerified(source, artifact, archive, signal);
    const downloadedAt = Date.now();
    await mkdir(staging, { mode: 0o755 });
    const unpacked = await extractTarSafely(archive, staging, { maxBytes: artifact.unpackedSize, maxEntries: MAX_ENTRIES }, signal);
    await writeFile(path.join(staging, MARKER), `${JSON.stringify({ name, sha256: artifact.sha256, platform: artifact.platform, installedAt: new Date().toISOString() })}\n`, { mode: 0o644 });
    // Another process may have finished first (e.g. after breaking a lock it
    // judged stale): never replace a verified install that commands may be using.
    if (await done()) return installedPaths(name, artifact.sha256, root, definition);
    // A leftover directory without a valid marker (crash mid-rename) is replaced.
    await rm(root, { recursive: true, force: true });
    await rename(staging, root);
    console.log(
      `[vendor-bundles] installed bundle=${name} sha256=${artifact.sha256.slice(0, 12)} root=${root} ` +
        `download_ms=${downloadedAt - started} unpack_ms=${Date.now() - downloadedAt} bytes=${artifact.size} unpacked_bytes=${unpacked.bytes} files=${unpacked.files}`,
    );
    return installedPaths(name, artifact.sha256, root, definition);
  } finally {
    clearInterval(heartbeat);
    await rm(archive, { force: true }).catch(() => {});
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    await rm(lockDir, { recursive: true, force: true }).catch(() => {});
  }
}

const inflight = new Map<string, Promise<InstalledVendorBundle>>();
const failures = new Map<string, { at: number; reason: string }>();

/**
 * Make a bundle available on this machine, downloading and unpacking it once
 * (per machine, across processes). Throws VendorBundleUnavailableError with a
 * clear reason when it cannot. `signal` only stops this caller waiting; the
 * shared install keeps running for later callers, bounded by its own timeout.
 */
export async function ensureVendorBundle(
  name: string,
  options: { env?: NodeJS.ProcessEnv; signal?: AbortSignal; manifest?: VendorBundleManifest } = {},
): Promise<InstalledVendorBundle> {
  const env = options.env ?? process.env;
  if (!vendorBundlesEnabled(env, name)) {
    throw new VendorBundleUnavailableError(name, "vendor bundles are disabled for this bundle (DOCSLURP_VENDOR_BUNDLE_BASE_URL / DOCSLURP_VENDOR_BUNDLES)");
  }
  const bundle = (options.manifest ?? loadVendorBundleManifest()).bundles[name];
  if (!bundle) throw new VendorBundleUnavailableError(name, "not declared in worker/vendor-bundles.json");
  const platform = currentBundlePlatform(env);
  const artifact = bundle.artifacts.find((item) => item.platform === platform);
  if (!artifact) throw new VendorBundleUnavailableError(name, `no artifact published for platform ${platform}`);

  const key = `${name}:${artifact.sha256}`;
  const failed = failures.get(key);
  if (failed && Date.now() - failed.at < FAILURE_COOLDOWN_MS) {
    throw new VendorBundleUnavailableError(name, `${failed.reason} (cached failure, retry after cooldown)`);
  }
  let pending = inflight.get(key);
  if (!pending) {
    const timeoutMs = Number.parseInt(env.DOCSLURP_VENDOR_BUNDLE_TIMEOUT_MS ?? "", 10) || DEFAULT_TIMEOUT_MS;
    pending = installBundle(name, bundle, artifact, env, timeoutMs)
      .then((installed) => {
        failures.delete(key);
        return installed;
      })
      .catch((error: unknown) => {
        const reason = redactVendorBundleText(error instanceof Error ? error.message : String(error), env);
        failures.set(key, { at: Date.now(), reason });
        console.warn(`[vendor-bundles] install failed bundle=${name} sha256=${artifact.sha256.slice(0, 12)} reason=${reason}`);
        throw new VendorBundleUnavailableError(name, reason);
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const signal = options.signal;
  if (!signal) return await pending;
  if (signal.aborted) throw new VendorBundleUnavailableError(name, "caller aborted before the bundle was ready");
  return await new Promise<InstalledVendorBundle>((resolve, reject) => {
    const onAbort = () => reject(new VendorBundleUnavailableError(name, "caller aborted before the bundle was ready"));
    signal.addEventListener("abort", onAbort, { once: true });
    pending!.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const prefetches = new Set<Promise<void>>();

/**
 * Boot-time warm-up (DOCSLURP_VENDOR_BUNDLE_PREFETCH=docling,unstructured): installs the
 * listed bundles one after another in the background so the first document does not pay
 * the download and unpack. The promise never rejects, is tracked for tests/shutdown, and
 * callers must not await it on the readiness path.
 */
export function prefetchVendorBundles(options: { env?: NodeJS.ProcessEnv; manifest?: VendorBundleManifest } = {}): Promise<void> {
  const env = options.env ?? process.env;
  const names = [...new Set((env.DOCSLURP_VENDOR_BUNDLE_PREFETCH ?? "").split(",").map((item) => item.trim()).filter(Boolean))].slice(0, 8);
  if (names.length === 0) return Promise.resolve();
  const run = (async () => {
    for (const name of names) {
      const started = Date.now();
      try {
        const installed = await ensureVendorBundle(name, { env, manifest: options.manifest });
        console.log(`[vendor-bundles] prefetch ready bundle=${name} sha256=${installed.sha256.slice(0, 12)} ms=${Date.now() - started}`);
      } catch (error) {
        const reason = redactVendorBundleText(error instanceof Error ? error.message : String(error), env);
        console.warn(`[vendor-bundles] prefetch failed bundle=${name} reason=${reason}`);
      }
    }
  })().finally(() => prefetches.delete(run));
  prefetches.add(run);
  return run;
}

/** Test hook: forget in-process state. */
export function resetVendorBundleStateForTests(): void {
  inflight.clear();
  failures.clear();
  cachedManifest = null;
  prefetches.clear();
}

// Shared helpers for fetch-on-first-use assets (model weights, third-party test fixtures).
// Nothing here ships binaries: callers hold a manifest of { sha256, size, url } pins and this module
// downloads into a gitignored cache, streaming to a temp file, verifying size + sha256, then renaming.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PLACEHOLDER_HOST = "docslurp.example";

/** Cache root for fetched assets: DOCSLURP_CACHE_DIR, else <repo>/.cache (gitignored, never exported). */
export function cacheRoot(env = process.env) {
  return env.DOCSLURP_CACHE_DIR ? path.resolve(env.DOCSLURP_CACHE_DIR) : path.join(repoRoot, ".cache");
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

/** Which pinned files are present and valid, missing, or corrupt (size is checked before hashing). */
export async function inspectFile(target, pin) {
  if (!existsSync(target)) return { state: "missing" };
  const { size } = await stat(target);
  if (pin.size != null && size !== pin.size) return { state: "corrupt", reason: `size ${size} != ${pin.size}` };
  const actual = await sha256File(target);
  return actual === pin.sha256 ? { state: "ok" } : { state: "corrupt", reason: `sha256 ${actual} != ${pin.sha256}`, actual };
}

/** Stream a Node/web readable (or a buffer) -> target.part, verify size + sha256, rename into place. Never leaves a bad file behind. */
export async function writeVerified(body, target, pin) {
  await mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.part`;
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    let source;
    if (body && typeof body.getReader === "function") source = Readable.fromWeb(body);
    else if (body && typeof body.pipe === "function") source = body;
    else source = Readable.from([Buffer.from(body)]);
    source.on("data", (chunk) => { hash.update(chunk); bytes += chunk.length; });
    await pipeline(source, createWriteStream(tmp));
    const digest = hash.digest("hex");
    if (pin.size != null && bytes !== pin.size) throw new Error(`${path.basename(target)}: ${bytes} bytes does not match the pinned size ${pin.size}`);
    if (digest !== pin.sha256) throw new Error(`${path.basename(target)}: sha256 ${digest} does not match the pinned ${pin.sha256}`);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return bytes;
}

/** Stream url -> target.part, verify size + sha256, rename into place. */
export async function downloadVerified(url, target, pin, { fetchImpl = fetch, headers } = {}) {
  const response = await fetchImpl(url, { redirect: "follow", headers });
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status}`);
  const body = response.body && typeof response.body.getReader === "function" ? response.body : Buffer.from(await response.arrayBuffer());
  return writeVerified(body, target, pin);
}

/** HEAD a url and compare content-length with the pin (used by --remote; cheap for multi-GB sets). */
export async function headCheck(url, pin, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, { method: "HEAD", redirect: "follow" });
  if (!response.ok) return { ok: false, detail: `HEAD ${response.status}` };
  const length = Number(response.headers.get("content-length"));
  if (pin.size != null && Number.isFinite(length) && length > 0 && length !== pin.size) return { ok: false, detail: `content-length ${length} != pinned ${pin.size}` };
  return { ok: true, detail: `HEAD 200 content-length ${length || "?"}` };
}

export function mirrorBase(override, env = process.env, envKey = "DOCSLURP_MODEL_BASE_URL") {
  const base = (override || env[envKey] || "").replace(/\/+$/, "");
  if (!base) return undefined;
  if (new URL(base).hostname.endsWith(PLACEHOLDER_HOST)) throw new Error(`${envKey} is still a placeholder (${base})`);
  return base;
}

// ---- Private asset mirror (S3-compatible, private bucket) ----
// DOCSLURP_ASSET_MIRROR=s3://bucket[/prefix] + DOCSLURP_ASSET_S3_ENDPOINT / _REGION / _ACCESS_KEY_ID /
// _SECRET_ACCESS_KEY (the team's read-only key). Objects are content-addressed (mirrorKey in the manifests).
export const MIRROR_HELP = "private asset, not available: set DOCSLURP_ASSET_MIRROR=s3://<bucket> plus DOCSLURP_ASSET_S3_ENDPOINT, _REGION, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY (read-only key from the team secrets; see docs/licensing.md)";

/** Parse the mirror env. Returns undefined when unset; throws when set but incomplete. Never logs credentials. */
export function assetMirrorConfig(env = process.env) {
  const raw = (env.DOCSLURP_ASSET_MIRROR || "").trim();
  if (!raw) return undefined;
  const url = new URL(raw);
  if (url.protocol !== "s3:" || !url.hostname) throw new Error("DOCSLURP_ASSET_MIRROR must look like s3://bucket[/prefix]");
  const missing = ["ENDPOINT", "ACCESS_KEY_ID", "SECRET_ACCESS_KEY"].filter((name) => !env[`DOCSLURP_ASSET_S3_${name}`]);
  if (missing.length) throw new Error(`DOCSLURP_ASSET_MIRROR is set but DOCSLURP_ASSET_S3_${missing.join(", DOCSLURP_ASSET_S3_")} is missing`);
  return {
    bucket: url.hostname,
    prefix: url.pathname.replace(/^\/+|\/+$/g, ""),
    endpoint: env.DOCSLURP_ASSET_S3_ENDPOINT,
    region: env.DOCSLURP_ASSET_S3_REGION || "us-east-1",
    accessKeyId: env.DOCSLURP_ASSET_S3_ACCESS_KEY_ID,
    secretAccessKey: env.DOCSLURP_ASSET_S3_SECRET_ACCESS_KEY,
  };
}

export function mirrorObjectKey(mirror, mirrorKey) {
  return mirror.prefix ? `${mirror.prefix}/${mirrorKey}` : mirrorKey;
}

/** Content-addressed key: <kind>/<sha256>/<filename>. */
export function contentKey(kind, sha256, name) {
  return `${kind}/${sha256}/${path.basename(name)}`;
}

async function s3Client(mirror, s3Factory) {
  if (s3Factory) return s3Factory(mirror);
  const { S3Client } = await import("@aws-sdk/client-s3");
  return new S3Client({
    region: mirror.region, endpoint: mirror.endpoint, forcePathStyle: true, maxAttempts: 3,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: mirror.accessKeyId, secretAccessKey: mirror.secretAccessKey },
  });
}

function s3Failure(error, mirror, key) {
  const status = error?.$metadata?.httpStatusCode;
  const hint = status === 404 || error?.name === "NoSuchKey" || error?.name === "NotFound" ? "object not found" : status === 401 || status === 403 ? "access denied (check the read-only key)" : (error?.name ?? "request failed");
  return new Error(`s3://${mirror.bucket}/${key} failed: ${hint}${status ? ` (HTTP ${status})` : ""}`);
}

/** Signed GET from the private mirror, streamed to target.part and verified (size + sha256) before the rename. */
export async function downloadFromMirror(mirror, mirrorKey, target, pin, { s3Factory } = {}) {
  const { GetObjectCommand } = s3Factory ? { GetObjectCommand: class { constructor(input) { this.input = input; } } } : await import("@aws-sdk/client-s3");
  const client = await s3Client(mirror, s3Factory);
  const key = mirrorObjectKey(mirror, mirrorKey);
  try {
    let response;
    try { response = await client.send(new GetObjectCommand({ Bucket: mirror.bucket, Key: key })); } catch (error) { throw s3Failure(error, mirror, key); }
    if (pin.size != null && typeof response.ContentLength === "number" && response.ContentLength !== pin.size) throw new Error(`s3://${mirror.bucket}/${key}: content-length ${response.ContentLength} != pinned ${pin.size}`);
    if (!response.Body) throw new Error(`s3://${mirror.bucket}/${key} returned no body`);
    return await writeVerified(response.Body, target, pin);
  } finally {
    client.destroy?.();
  }
}

/** HEAD an object on the mirror and compare content-length with the pin. */
export async function headMirror(mirror, mirrorKey, pin, { s3Factory } = {}) {
  const { HeadObjectCommand } = s3Factory ? { HeadObjectCommand: class { constructor(input) { this.input = input; } } } : await import("@aws-sdk/client-s3");
  const client = await s3Client(mirror, s3Factory);
  const key = mirrorObjectKey(mirror, mirrorKey);
  try {
    const response = await client.send(new HeadObjectCommand({ Bucket: mirror.bucket, Key: key }));
    if (pin.size != null && response.ContentLength !== pin.size) return { ok: false, detail: `content-length ${response.ContentLength} != pinned ${pin.size}` };
    return { ok: true, detail: `HEAD s3 content-length ${response.ContentLength}` };
  } catch (error) {
    return { ok: false, detail: s3Failure(error, mirror, key).message };
  } finally {
    client.destroy?.();
  }
}

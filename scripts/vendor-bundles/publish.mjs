#!/usr/bin/env node
// Publish a built vendor bundle archive to the private S3-compatible bucket
// (Backblaze B2 in production) under its content-addressed key
// <prefix>/<bundle>/<sha256>.tar.zst, from a workstation or CI.
//
//   VENDOR_BUNDLES_AWS_ACCESS_KEY_ID=... VENDOR_BUNDLES_AWS_SECRET_ACCESS_KEY=... \
//   VENDOR_BUNDLES_ENDPOINT=https://s3.us-west-004.backblazeb2.com VENDOR_BUNDLES_REGION=us-west-004 \
//   node scripts/vendor-bundles/publish.mjs --entry .scratch/bundles/docling-linux-x64-py3.13.json \
//     [--archive <file>] [--bucket docslurp-vendor-bundles] [--prefix <p>] [--dry-run]
//
// The archive's sha256 and size are recomputed and must match the entry. An object that
// already exists with the same size is skipped (keys are immutable); a different size is
// overwritten. After upload a HEAD must report the exact size. Credentials come from the
// environment only and are never printed. Then pin the entry with update-manifest.mjs.
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const PART_SIZE = 64 * 1024 * 1024;
export const DEFAULT_BUCKET = "docslurp-vendor-bundles";

export function objectKey(prefix, bundle, sha256) {
  const clean = (prefix ?? "").split("/").filter(Boolean).join("/");
  return `${clean ? `${clean}/` : ""}${bundle}/${sha256}.tar.zst`;
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function headSize(client, commands, bucket, key) {
  try {
    const head = await client.send(new commands.HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.ContentLength;
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404 || error?.name === "NotFound" || error?.name === "NoSuchKey") return null;
    throw error;
  }
}

/** Upload `file` to bucket/key (multipart), skipping when the same size already exists; verifies with HEAD. */
export async function publishArchive({ client, commands, bucket, key, file, size, partSize = PART_SIZE, log = console.log }) {
  const existing = await headSize(client, commands, bucket, key);
  if (existing === size) {
    log(`s3://${bucket}/${key} already exists (${size} bytes, content-addressed); skipping upload`);
    return { uploaded: false };
  }
  if (existing !== null) log(`s3://${bucket}/${key} exists with size ${existing} != ${size}; overwriting`);
  const created = await client.send(new commands.CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: "application/zstd", CacheControl: "private, max-age=31536000, immutable" }));
  const uploadId = created.UploadId;
  const parts = [];
  const handle = await open(file, "r");
  try {
    for (let offset = 0, number = 1; offset < size; offset += partSize, number += 1) {
      const length = Math.min(partSize, size - offset);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) throw new Error(`short read at offset ${offset}`);
      const part = await client.send(new commands.UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: number, Body: buffer }));
      parts.push({ ETag: part.ETag, PartNumber: number });
      log(`  part ${number} (${Math.round(((offset + length) / size) * 100)}%)`);
    }
    await client.send(new commands.CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
  } catch (error) {
    await client.send(new commands.AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId })).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }
  const remote = await headSize(client, commands, bucket, key);
  if (remote !== size) throw new Error(`uploaded size ${remote} != ${size}`);
  log(`Published s3://${bucket}/${key} (${size} bytes)`);
  return { uploaded: true };
}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  const entryFile = arg("entry");
  if (!entryFile) throw new Error("--entry is required");
  const entry = JSON.parse(readFileSync(entryFile, "utf8"));
  const archive = arg("archive") ?? entryFile.replace(/\.json$/, ".tar.zst");
  const [sha256, size] = [await sha256File(archive), statSync(archive).size];
  if (sha256 !== entry.sha256 || size !== entry.size) throw new Error(`archive does not match entry (sha256 ${sha256}, size ${size})`);
  const bucket = arg("bucket") ?? process.env.VENDOR_BUNDLES_BUCKET ?? DEFAULT_BUCKET;
  const key = objectKey(arg("prefix") ?? process.env.VENDOR_BUNDLES_PREFIX, entry.bundle, entry.sha256);
  if (process.argv.includes("--dry-run")) {
    console.log(`[dry-run] would publish ${archive} (${size} bytes) to s3://${bucket}/${key}`);
    return;
  }
  const accessKeyId = process.env.VENDOR_BUNDLES_AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.VENDOR_BUNDLES_AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) throw new Error("set VENDOR_BUNDLES_AWS_ACCESS_KEY_ID and VENDOR_BUNDLES_AWS_SECRET_ACCESS_KEY");
  const endpoint = arg("endpoint") ?? process.env.VENDOR_BUNDLES_ENDPOINT;
  if (endpoint && new URL(endpoint).protocol !== "https:") throw new Error("VENDOR_BUNDLES_ENDPOINT must be https://");
  // The SDK is a worker dependency; resolve it from there so no extra root install is needed.
  const commands = createRequire(path.join(root, "worker/package.json"))("@aws-sdk/client-s3");
  const client = new commands.S3Client({
    region: arg("region") ?? process.env.VENDOR_BUNDLES_REGION ?? "us-west-004",
    endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  try {
    await publishArchive({ client, commands, bucket, key, file: archive, size });
  } finally {
    client.destroy();
  }
  console.log("Next: node scripts/vendor-bundles/update-manifest.mjs --entry <entry.json>, then commit worker/vendor-bundles.json.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[vendor-bundles] ${error.message}`);
    process.exit(1);
  });
}

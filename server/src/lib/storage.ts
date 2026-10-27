import { instrumentS3Client } from "@docslurp/shared/observability";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  paginateListParts,
  S3Client,
  UploadPartCommand
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "node:stream";

import { env } from "../config.js";
import { resolveS3ClientTuning, rfc5987Encode, s3ClientConfig } from "@docslurp/shared";
import { uploadSigningTarget } from "./upload-signing-target.js";

const s3Client = instrumentS3Client(new S3Client(s3ClientConfig(env.storage)), env.storage.endpoint);
const uploadTarget = uploadSigningTarget(env.storage, process.env.DOCSLURP_STORAGE_PUBLIC_BUCKET_URL);
const presignClient = process.env.DOCSLURP_STORAGE_PUBLIC_BUCKET_URL ? new S3Client(uploadTarget.config) : s3Client;

let bucketReadyPromise: Promise<void> | null = null;

function isMissingBucketError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorWithCode = error as Error & { Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    error.name === "NotFound" ||
    errorWithCode.Code === "NoSuchBucket" ||
    errorWithCode.$metadata?.httpStatusCode === 404
  );
}

function isExistingBucketError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const errorWithCode = error as Error & { Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    errorWithCode.Code === "BucketAlreadyExists" ||
    errorWithCode.Code === "BucketAlreadyOwnedByYou" ||
    errorWithCode.$metadata?.httpStatusCode === 409
  );
}

async function ensureBucketExists(): Promise<void> {
  if (!bucketReadyPromise) {
    bucketReadyPromise = (async () => {
      try {
        await s3Client.send(
          new HeadBucketCommand({
            Bucket: env.s3Bucket
          })
        );
        return;
      } catch (error) {
        if (!isMissingBucketError(error)) {
          throw error;
        }
      }

      try {
        await s3Client.send(
          new CreateBucketCommand({
            Bucket: env.s3Bucket
          })
        );
      } catch (error) {
        if (!isExistingBucketError(error)) {
          throw error;
        }
      }
    })();
  }

  try {
    await bucketReadyPromise;
  } catch (error) {
    bucketReadyPromise = null;
    throw error;
  }
}

export async function uploadFile(key: string, body: Buffer, contentType: string): Promise<string> {
  await ensureBucketExists();
  await s3Client.send(
    new PutObjectCommand({
      Bucket: env.s3Bucket,
      Key: key,
      Body: body,
      ContentType: contentType
    })
  );

  return key;
}

const STREAM_PART_BYTES = resolveS3ClientTuning().multipartPartSizeBytes ?? 8 * 1024 * 1024;

/**
 * Stream a body into storage. PutObject needs a known Content-Length: a stream
 * of unknown length makes the AWS SDK send `x-amz-decoded-content-length:
 * undefined` and storage rejects chunked PUTs without a length. Unknown-length
 * bodies are cut into 8 MB parts (one PUT when they fit in one part).
 */
export async function uploadFileStream(args: {
  key: string;
  body: Readable;
  contentType: string;
  contentLength?: number;
}): Promise<string> {
  await ensureBucketExists();
  if (typeof args.contentLength === "number") {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: env.s3Bucket,
        Key: args.key,
        Body: args.body,
        ContentType: args.contentType,
        ContentLength: args.contentLength
      })
    );
    return args.key;
  }

  let uploadId: string | undefined;
  const parts: Array<{ partNumber: number; etag: string }> = [];
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  const flush = async () => {
    const part = Buffer.concat(pending, pendingBytes);
    pending = [];
    pendingBytes = 0;
    uploadId ??= await createMultipartUpload(args.key, args.contentType);
    const partNumber = parts.length + 1;
    const response = await s3Client.send(new UploadPartCommand({ Bucket: env.s3Bucket, Key: args.key, UploadId: uploadId, PartNumber: partNumber, Body: part, ContentLength: part.length }));
    parts.push({ partNumber, etag: response.ETag ?? "" });
  };
  try {
    for await (const chunk of args.body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      pending.push(buffer);
      pendingBytes += buffer.length;
      if (pendingBytes >= STREAM_PART_BYTES) await flush();
    }
    if (!uploadId) {
      await uploadFile(args.key, Buffer.concat(pending, pendingBytes), args.contentType);
      return args.key;
    }
    if (pendingBytes > 0) await flush();
    await completeMultipartUpload({ key: args.key, uploadId, parts });
    return args.key;
  } catch (error) {
    if (uploadId) await abortMultipartUpload({ key: args.key, uploadId }).catch(() => undefined);
    throw error;
  }
}

export async function createMultipartUpload(key: string, contentType: string): Promise<string> {
  await ensureBucketExists();
  const response = await s3Client.send(
    new CreateMultipartUploadCommand({
      Bucket: env.s3Bucket,
      Key: key,
      ContentType: contentType
    })
  );

  if (!response.UploadId) {
    throw new Error(`Failed to create multipart upload for ${key}`);
  }

  return response.UploadId;
}

export async function signMultipartUploadPart(args: {
  key: string;
  uploadId: string;
  partNumber: number;
  expiresInSeconds?: number;
}): Promise<string> {
  await ensureBucketExists();
  return await getSignedUrl(
    presignClient,
    new UploadPartCommand({
      Bucket: uploadTarget.bucket,
      Key: args.key,
      UploadId: args.uploadId,
      PartNumber: args.partNumber
    }),
    { expiresIn: args.expiresInSeconds ?? 900 }
  );
}

export async function signSingleUploadPut(args: {
  key: string;
  contentType: string;
  expiresInSeconds?: number;
}): Promise<string> {
  await ensureBucketExists();
  return await getSignedUrl(
    presignClient,
    new PutObjectCommand({
      Bucket: uploadTarget.bucket,
      Key: args.key,
      ContentType: args.contentType
    }),
    { expiresIn: args.expiresInSeconds ?? 900 }
  );
}

/** Longest life of a presigned download link; the request is authorized just before signing. */
export const DOWNLOAD_LINK_MAX_SECONDS = 300;

/**
 * A short-lived GET link straight to storage, saving the object as `filename`.
 * Only for large downloads that should not stream through the API (zip
 * exports); every other read goes through the file proxy (routes/files.ts).
 * Callers authorize the request immediately before calling this.
 */
export async function signDownloadGet(args: { key: string; filename: string; expiresInSeconds?: number }): Promise<string> {
  const ascii = args.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return await getSignedUrl(
    presignClient,
    new GetObjectCommand({
      Bucket: uploadTarget.bucket,
      Key: args.key,
      ResponseContentType: "application/zip",
      ResponseContentDisposition: `attachment; filename="${ascii}"; filename*=UTF-8''${rfc5987Encode(args.filename)}`,
      // Never kept by browser or proxy caches once the link's minutes are up.
      ResponseCacheControl: "private, no-store"
    }),
    { expiresIn: Math.min(args.expiresInSeconds ?? 120, DOWNLOAD_LINK_MAX_SECONDS) }
  );
}

export async function getUploadedObjectMetadata(key: string): Promise<{
  contentLength: number | null;
  contentType: string | null;
  etag: string | null;
}> {
  await ensureBucketExists();
  const response = await s3Client.send(
    new HeadObjectCommand({
      Bucket: env.s3Bucket,
      Key: key
    })
  );

  return {
    contentLength: typeof response.ContentLength === "number" ? response.ContentLength : null,
    contentType: response.ContentType ?? null,
    etag: response.ETag ?? null
  };
}

export async function deleteUploadedObject(key: string): Promise<void> {
  await ensureBucketExists();
  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: env.s3Bucket,
      Key: key
    })
  );
}

export async function completeMultipartUpload(args: {
  key: string;
  uploadId: string;
  parts: Array<{ partNumber: number; etag: string }>;
}): Promise<void> {
  await ensureBucketExists();
  await s3Client.send(
    new CompleteMultipartUploadCommand({
      Bucket: env.s3Bucket,
      Key: args.key,
      UploadId: args.uploadId,
      MultipartUpload: {
        Parts: [...args.parts]
          .sort((left, right) => left.partNumber - right.partNumber)
          .map((part) => ({
            PartNumber: part.partNumber,
            ETag: part.etag
          }))
      }
    })
  );
}

export async function abortMultipartUpload(args: { key: string; uploadId: string }): Promise<void> {
  await ensureBucketExists();
  await s3Client.send(
    new AbortMultipartUploadCommand({
      Bucket: env.s3Bucket,
      Key: args.key,
      UploadId: args.uploadId
    })
  );
}

/** Readiness probe (`/ready`): HEAD the bucket without creating it. */
export async function headStorageBucket(signal?: AbortSignal): Promise<void> {
  await s3Client.send(new HeadBucketCommand({ Bucket: env.s3Bucket }), { abortSignal: signal });
}

/** Consume every provider page; multipart sessions can contain up to 10,000 parts. */
export async function listMultipartUploadParts(args: { key: string; uploadId: string }) {
  const parts: Array<{ partNumber: number; etag: string; sizeBytes: number }> = [];
  for await (const page of paginateListParts({ client: s3Client }, {
    Bucket: env.s3Bucket, Key: args.key, UploadId: args.uploadId,
  })) {
    for (const part of page.Parts ?? []) {
      if (part.PartNumber === undefined || !part.ETag || part.Size === undefined) {
        throw new Error("Storage returned incomplete multipart metadata");
      }
      parts.push({ partNumber: part.PartNumber, etag: part.ETag, sizeBytes: part.Size });
    }
  }
  return parts;
}

/**
 * Deletes one page (at most 1,000 keys) of objects under `prefix` and reports
 * what it removed, for sweeps that must empty a prefix across several passes.
 * The prefix must be a non-empty directory path ending in "/": a bare or
 * partial prefix is refused rather than risk deleting a neighbour's objects.
 * Also aborts unfinished multipart uploads there once the prefix lists empty.
 */
export async function deleteObjectsUnderPrefix(prefix: string): Promise<{ objects: number; bytes: number; done: boolean }> {
  if (!/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)+\/$/.test(prefix)) throw new Error("Refusing unsafe storage prefix");
  await ensureBucketExists();
  const page = await s3Client.send(new ListObjectsV2Command({ Bucket: env.s3Bucket, Prefix: prefix, MaxKeys: 1000 }));
  const listed = (page.Contents ?? []).filter((item): item is typeof item & { Key: string } => typeof item.Key === "string" && item.Key.startsWith(prefix));
  if (listed.length > 0) {
    const response = await s3Client.send(new DeleteObjectsCommand({
      Bucket: env.s3Bucket,
      Delete: { Objects: listed.map((item) => ({ Key: item.Key })), Quiet: true },
    }));
    const failed = response.Errors ?? [];
    if (failed.length > 0) throw new Error(`storage refused to delete ${failed.length} of ${listed.length} objects (${failed[0]?.Code ?? "unknown"})`);
    const bytes = listed.reduce((sum, item) => sum + (typeof item.Size === "number" ? item.Size : 0), 0);
    return { objects: listed.length, bytes, done: false };
  }
  // Nothing left to list: drop unfinished multipart uploads (parts are not listed as objects).
  for (;;) {
    const uploads = await s3Client.send(new ListMultipartUploadsCommand({ Bucket: env.s3Bucket, Prefix: prefix, MaxUploads: 1000 }));
    const open = (uploads.Uploads ?? []).filter((upload) => upload.Key?.startsWith(prefix) && upload.UploadId);
    for (const upload of open) {
      await s3Client.send(new AbortMultipartUploadCommand({ Bucket: env.s3Bucket, Key: upload.Key!, UploadId: upload.UploadId! }));
    }
    if (!uploads.IsTruncated || open.length === 0) break;
  }
  return { objects: 0, bytes: 0, done: true };
}

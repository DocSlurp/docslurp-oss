import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand
} from "@aws-sdk/client-s3";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { s3ClientConfig, artifactUri, keyFromArtifactUri } from "@docslurp/shared";

import type { Config } from "../config.js";

const storageKeyBrand: unique symbol = Symbol("storageKeyBrand");

export type SourceStorageKey = string & { readonly [storageKeyBrand]: "source" };
export type ArtifactStorageKey = string & { readonly [storageKeyBrand]: "artifact" };

export interface StorageReadOptions {
  maxBytes?: number;
}

export class StorageObjectTooLargeError extends Error {
  readonly key: string;
  readonly sizeBytes: number;
  readonly maxBytes: number;

  constructor(key: string, sizeBytes: number, maxBytes: number) {
    super(`storage object ${key} is ${sizeBytes} bytes, exceeding max ${maxBytes} bytes`);
    this.name = "StorageObjectTooLargeError";
    this.key = key;
    this.sizeBytes = sizeBytes;
    this.maxBytes = maxBytes;
  }
}

/** Serialize artifact arrays item by item; avoid a document-sized string and Buffer copy. */
export function* streamJsonObject(value: Record<string, unknown>): Generator<Buffer> {
  yield Buffer.from("{");
  let first = true;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "undefined" || typeof item === "function" || typeof item === "symbol") continue;
    const encoded = Array.isArray(item) ? undefined : JSON.stringify(item);
    if (!Array.isArray(item) && encoded === undefined) continue;
    yield Buffer.from(`${first ? "" : ","}${JSON.stringify(key)}:`);
    first = false;
    if (Array.isArray(item)) {
      yield Buffer.from("[");
      for (let index = 0; index < item.length; index++) {
        yield Buffer.from(`${index ? "," : ""}${JSON.stringify(item[index]) ?? "null"}`);
      }
      yield Buffer.from("]");
    } else {
      yield Buffer.from(encoded!);
    }
  }
  yield Buffer.from("}\n");
}

export class ArtifactStore {
  readonly bucket: string;
  private readonly client: S3Client;

  constructor(cfg: Config) {
    this.bucket = cfg.s3Bucket;
    this.client = new S3Client(s3ClientConfig(cfg.storage));
  }

  async putJson(key: string, value: unknown): Promise<void> {
    if (value && Object.getPrototypeOf(value) === Object.prototype
      && !Object.prototype.hasOwnProperty.call(value, "toJSON")
      && Object.values(value).some(item => Array.isArray(item) && item.length > 1000)) {
      const upload = this.createMultipartUploadStream(key, "application/json");
      await Promise.all([
        pipeline(Readable.from(streamJsonObject(value as Record<string, unknown>)), upload.writable),
        upload.done,
      ]);
      return;
    }
    const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
    await this.putBytes(key, body, "application/json");
  }

  async putBytes(key: string, data: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType
      })
    );
  }

  /**
   * PutObject needs a known Content-Length: a stream of unknown length makes the
   * AWS SDK send `x-amz-decoded-content-length: undefined` (and storage rejects
   * chunked PUTs without a length), which failed every extract-markdown write.
   * Text is already in memory, so send it as bytes.
   */
  async streamText(key: string, text: string, contentType = "text/plain"): Promise<void> {
    await this.putBytes(key, Buffer.from(text, "utf8"), contentType);
  }

  /** Files go up with their real size; any other stream goes through the multipart uploader. */
  async streamToStorage(key: string, stream: Readable, contentType: string): Promise<void> {
    const filePath = (stream as Readable & { path?: string | Buffer }).path;
    if (typeof filePath === "string") {
      const { size } = await stat(filePath);
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: stream,
          ContentLength: size,
          ContentType: contentType
        })
      );
      return;
    }
    const upload = this.createMultipartUploadStream(key, contentType);
    await Promise.all([pipeline(stream, upload.writable), upload.done]);
  }

  createMultipartUploadStream(
    key: string,
    contentType: string,
    options?: { partSizeBytes?: number }
  ): { writable: Writable; done: Promise<void> } {
    const writer = new MultipartUploadWriter({
      client: this.client,
      bucket: this.bucket,
      key,
      contentType,
      partSizeBytes: options?.partSizeBytes
    });

    return {
      writable: writer,
      done: writer.done
    };
  }

  async getBytes(key: string, options?: StorageReadOptions): Promise<Buffer> {
    validateStorageKey(key);
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key
      })
    );

    if (typeof response.ContentLength === "number") {
      assertObjectWithinReadLimit(key, response.ContentLength, options?.maxBytes);
    }

    const bytes = await response.Body?.transformToByteArray();
    const data = Buffer.from(bytes ?? []);
    assertObjectWithinReadLimit(key, data.length, options?.maxBytes);
    return data;
  }

  async getJson<T>(key: string, options?: StorageReadOptions): Promise<T> {
    const data = await this.getBytes(key, options);
    return JSON.parse(data.toString("utf8")) as T;
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key
        })
      );
      return true;
    } catch (error) {
      const statusCode = typeof error === "object" && error && "$metadata" in error
        ? Number((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0)
        : 0;
      if (statusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  async objectSize(key: string): Promise<number | null> {
    try {
      const response = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return typeof response.ContentLength === "number" ? response.ContentLength : 0;
    } catch (error) {
      const statusCode = typeof error === "object" && error && "$metadata" in error
        ? Number((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode ?? 0)
        : 0;
      if (statusCode === 404) return null;
      throw error;
    }
  }

  async listKeys(options?: { prefix?: string; maxKeys?: number }): Promise<{
    keys: string[];
    truncated: boolean;
    nextContinuationToken: string | null;
  }> {
    const collected: string[] = [];
    const maxKeys = Math.max(1, options?.maxKeys ?? 10_000);
    let continuationToken: string | undefined;
    let truncated = false;

    while (collected.length < maxKeys) {
      const remaining = maxKeys - collected.length;
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: options?.prefix,
          ContinuationToken: continuationToken,
          MaxKeys: Math.max(1, Math.min(1000, remaining))
        })
      );

      for (const entry of response.Contents ?? []) {
        if (entry.Key) {
          collected.push(entry.Key);
        }
      }

      if (!response.IsTruncated || !response.NextContinuationToken) {
        return {
          keys: collected,
          truncated: false,
          nextContinuationToken: null
        };
      }

      continuationToken = response.NextContinuationToken;
      truncated = true;
    }

    return {
      keys: collected,
      truncated,
      nextContinuationToken: continuationToken ?? null
    };
  }

  async deleteKeys(keys: string[]): Promise<void> {
    const uniqueKeys = [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
    if (uniqueKeys.length === 0) {
      return;
    }

    if (uniqueKeys.length === 1) {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: uniqueKeys[0]
        })
      );
      return;
    }

    for (let index = 0; index < uniqueKeys.length; index += 1000) {
      const batch = uniqueKeys.slice(index, index + 1000);
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: batch.map((key) => ({ Key: key })),
            Quiet: true
          }
        })
      );
    }
  }

  async downloadToTempFile(key: string, pattern: string, options?: StorageReadOptions): Promise<string> {
    const data = await this.getBytes(key, options);
    const directory = await mkdtemp(path.join(tmpdir(), "docslurp-"));
    const filename = pattern.replace(/\*/g, Math.random().toString(36).slice(2));
    const filePath = path.join(directory, filename);
    await writeFile(filePath, data);
    return filePath;
  }

  async downloadSourceToTempFile(
    key: SourceStorageKey,
    pattern: string,
    options?: StorageReadOptions
  ): Promise<string> {
    return await this.downloadToTempFile(key, pattern, options);
  }

  async putArtifactJson(key: ArtifactStorageKey, value: unknown): Promise<void> {
    await this.putJson(key, value);
  }

  uri(key: string): string {
    return artifactUri(this.bucket, key);
  }
}

export async function cleanupTempFile(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
  await rm(path.dirname(filePath), { force: true, recursive: true });
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const data = await readFile(filePath, "utf8");
  return JSON.parse(data) as T;
}

export function keyFromStorageUri(uriOrKey: string, bucket: string): string | null {
  return keyFromArtifactUri(uriOrKey, bucket);
}

export function sourceStorageKey(key: string): SourceStorageKey {
  validateStorageKey(key);
  return key as SourceStorageKey;
}

export function artifactStorageKey(key: string): ArtifactStorageKey {
  validateStorageKey(key);
  return key as ArtifactStorageKey;
}

export function buildArtifactStorageKey(...segments: string[]): ArtifactStorageKey {
  if (segments.length === 0) {
    throw new Error("artifact storage key requires at least one segment");
  }

  return artifactStorageKey(segments.map(safeStoragePathSegment).join("/"));
}

export function collectOrphanedStorageKeys(
  listedKeys: string[],
  referencedKeys: Iterable<string>,
  options?: { ignoredPrefixes?: string[] }
): string[] {
  const ignoredPrefixes = options?.ignoredPrefixes ?? ["system/integrity/"];
  const referenced = new Set(referencedKeys);

  return [...new Set(
    listedKeys.filter((key) =>
      key.trim()
      && !referenced.has(key)
      && !ignoredPrefixes.some((prefix) => key.startsWith(prefix))
    )
  )];
}

function validateStorageKey(key: string): void {
  if (key !== key.trim() || key.length === 0) {
    throw new Error("storage key must be a non-empty trimmed string");
  }

  if (key.startsWith("s3://")) {
    throw new Error("storage key must be bucket-local, not an s3 uri");
  }

  if (key.startsWith("/") || key.includes("\\") || key.includes("//")) {
    throw new Error(`unsafe storage key: ${key}`);
  }

  if (key.split("/").some((segment) => segment === "." || segment === ".." || segment.length === 0)) {
    throw new Error(`unsafe storage key path segment: ${key}`);
  }

  if (/[\u0000-\u001f\u007f]/.test(key)) {
    throw new Error("storage key must not contain control characters");
  }
}

function safeStoragePathSegment(segment: string): string {
  if (segment.length === 0 || segment !== segment.trim()) {
    throw new Error("storage path segment must be a non-empty trimmed string");
  }

  if (segment === "." || segment === ".." || /[\u0000-\u001f\u007f]/.test(segment)) {
    throw new Error(`unsafe storage path segment: ${segment}`);
  }

  return encodeURIComponent(segment);
}

function assertObjectWithinReadLimit(key: string, sizeBytes: number, maxBytes?: number): void {
  if (typeof maxBytes !== "number") {
    return;
  }

  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new Error(`storage maxBytes must be a non-negative finite number for ${key}`);
  }

  if (sizeBytes > maxBytes) {
    throw new StorageObjectTooLargeError(key, sizeBytes, maxBytes);
  }
}

class MultipartUploadWriter extends Writable {
  readonly done: Promise<void>;

  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly key: string;
  private readonly contentType: string;
  private readonly partSizeBytes: number;

  private readonly completedParts: Array<{ ETag?: string; PartNumber: number }> = [];
  private readonly pendingChunks: Buffer[] = [];

  private uploadId?: string;
  private totalBufferedBytes = 0;
  private nextPartNumber = 1;
  private bytesWritten = 0;
  private settled = false;
  private resolveDone!: () => void;
  private rejectDone!: (error: Error) => void;

  constructor(args: {
    client: S3Client;
    bucket: string;
    key: string;
    contentType: string;
    partSizeBytes?: number;
  }) {
    super();
    this.client = args.client;
    this.bucket = args.bucket;
    this.key = args.key;
    this.contentType = args.contentType;
    this.partSizeBytes = Math.max(5 * 1024 * 1024, args.partSizeBytes ?? 8 * 1024 * 1024);
    this.done = new Promise<void>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    void this.handleWrite(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).then(
      () => callback(),
      (error) => callback(toError(error))
    );
  }

  override _final(callback: (error?: Error | null) => void): void {
    void this.finishUpload().then(
      () => callback(),
      (error) => callback(toError(error))
    );
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!error || this.settled) {
      callback(error);
      return;
    }

    void this.abortUpload(error).finally(() => callback(error));
  }

  private async handleWrite(chunk: Buffer): Promise<void> {
    this.pendingChunks.push(chunk);
    this.totalBufferedBytes += chunk.length;
    this.bytesWritten += chunk.length;

    if (this.totalBufferedBytes >= this.partSizeBytes) {
      await this.flushPart();
    }
  }

  private async finishUpload(): Promise<void> {
    try {
      if (!this.uploadId && this.bytesWritten === 0) {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.key,
            Body: new Uint8Array(),
            ContentType: this.contentType
          })
        );
        this.settle();
        return;
      }

      await this.flushPart(true);
      if (!this.uploadId) {
        this.settle();
        return;
      }

      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: this.key,
          UploadId: this.uploadId,
          MultipartUpload: {
            Parts: this.completedParts
          }
        })
      );
      this.settle();
    } catch (error) {
      await this.abortUpload(error);
      throw toError(error);
    }
  }

  private async flushPart(force = false): Promise<void> {
    if (this.totalBufferedBytes === 0) {
      return;
    }

    if (!force && this.totalBufferedBytes < this.partSizeBytes) {
      return;
    }

    const body = Buffer.concat(this.pendingChunks, this.totalBufferedBytes);
    this.pendingChunks.length = 0;
    this.totalBufferedBytes = 0;

    const uploadId = await this.ensureUpload();
    const partNumber = this.nextPartNumber++;
    const response = await this.client.send(
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: this.key,
        UploadId: uploadId,
        PartNumber: partNumber,
        Body: body,
        ContentLength: body.length
      })
    );

    this.completedParts.push({
      ETag: response.ETag,
      PartNumber: partNumber
    });
  }

  private async ensureUpload(): Promise<string> {
    if (this.uploadId) {
      return this.uploadId;
    }

    const response = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: this.key,
        ContentType: this.contentType
      })
    );

    if (!response.UploadId) {
      throw new Error(`failed to create multipart upload for ${this.key}`);
    }

    this.uploadId = response.UploadId;
    return this.uploadId;
  }

  private async abortUpload(cause?: unknown): Promise<void> {
    if (this.uploadId) {
      try {
        await this.client.send(
          new AbortMultipartUploadCommand({
            Bucket: this.bucket,
            Key: this.key,
            UploadId: this.uploadId
          })
        );
      } catch {
        // Best effort cleanup after an upload failure.
      }
    }

    this.settle(toError(cause ?? new Error(`multipart upload aborted for ${this.key}`)));
  }

  private settle(error?: Error): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    if (error) {
      this.rejectDone(error);
    } else {
      this.resolveDone();
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

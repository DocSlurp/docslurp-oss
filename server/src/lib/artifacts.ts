import { instrumentS3Client } from "@docslurp/shared/observability";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { s3ClientConfig, parseArtifactUri, type ParsedArtifactUri } from "@docslurp/shared";

import { readBoundedArtifactText } from "./bounded-artifact-body.js";

import { env } from "../config.js";

const s3Client = instrumentS3Client(new S3Client(s3ClientConfig(env.storage)), env.storage.endpoint);

export { parseArtifactUri, type ParsedArtifactUri };

/**
 * The storage URI must address this deployment's bucket. Callers also verify the
 * requesting user may read the underlying document, but asserting the bucket here
 * means a future caller that forgets that check still cannot read another bucket.
 * Security finding SEC-2026-10-21.
 */
function assertArtifactBucket(parsed: ParsedArtifactUri): void {
  if (parsed.bucket !== env.s3Bucket) {
    throw new Error("artifact bucket mismatch");
  }
}

/**
 * Opens an artifact for streaming through the file proxy (routes/files.ts).
 * Range and If-None-Match pass through to storage, so media seeking and 304
 * revalidation work without buffering. Aborting `signal` (client disconnect)
 * cancels the upstream read.
 */
export async function openArtifactObject(uri: string, options: { range?: string; ifNoneMatch?: string; signal?: AbortSignal } = {}) {
  const parsed = parseArtifactUri(uri);
  if (!parsed) {
    throw new Error("unsupported artifact uri");
  }
  assertArtifactBucket(parsed);
  return await s3Client.send(
    new GetObjectCommand({
      Bucket: parsed.bucket,
      Key: parsed.key,
      Range: options.range,
      IfNoneMatch: options.ifNoneMatch
    }),
    { abortSignal: options.signal }
  );
}

export async function getArtifactText(uri: string, maxBytes = 32 * 1024 * 1024): Promise<string> {
  const parsed = parseArtifactUri(uri);
  if (!parsed) {
    throw new Error("unsupported artifact uri");
  }
  assertArtifactBucket(parsed);

  const response = await s3Client.send(
    new GetObjectCommand({
      Bucket: parsed.bucket,
      Key: parsed.key
    }),
    { abortSignal: AbortSignal.timeout(15_000) }
  );

  const body = response.Body as (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
  if (!body) return "";
  if ((response.ContentLength ?? 0) > maxBytes) {
    body.destroy?.();
    throw new Error("Artifact exceeds the text read limit");
  }
  return await readBoundedArtifactText(body, maxBytes);
}

export async function getArtifactJson<T>(uri: string): Promise<T> {
  const text = await getArtifactText(uri);
  return JSON.parse(text) as T;
}

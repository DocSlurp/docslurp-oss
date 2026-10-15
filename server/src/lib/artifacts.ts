import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { s3ClientConfig, parseArtifactUri, type ParsedArtifactUri } from "@docslurp/shared";

import { readBoundedArtifactText } from "./bounded-artifact-body.js";

import { env } from "../config.js";

const s3Client = new S3Client(s3ClientConfig(env.storage));

export { parseArtifactUri, type ParsedArtifactUri };

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

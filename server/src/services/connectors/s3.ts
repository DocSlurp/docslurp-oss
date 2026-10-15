import type { FileRef } from "@docslurp/shared";
import { s3CredentialsSchema, s3ConfigSchema } from "@docslurp/shared";
import type { ConnectorAdapter } from "./base.js";
import { ConnectorError } from "./base.js";
import { assertSafeExternalUrl } from "../../lib/network-security.js";
import { enforceUploadSize } from "../../lib/upload-policy.js";

async function resolveCustomEndpoint(endpoint: string | undefined): Promise<string | undefined> {
  if (!endpoint) {
    return undefined;
  }
  if (process.env.ALLOW_CUSTOM_S3_CONNECTOR_ENDPOINTS !== "true") {
    throw new ConnectorError("Custom S3 connector endpoints are disabled", "config_error");
  }
  return await assertSafeExternalUrl(endpoint);
}

/**
 * S3 connector adapter.
 * Uses the AWS SDK v3 when available; stubs in test/build environments.
 */
export class S3ConnectorAdapter implements ConnectorAdapter {
  readonly type = "s3";

  async listFiles(
    rawConfig: Record<string, unknown>,
    rawCreds: Record<string, unknown>
  ): Promise<FileRef[]> {
    const config = s3ConfigSchema.parse(rawConfig);
    const creds = s3CredentialsSchema.parse(rawCreds);
    const endpoint = await resolveCustomEndpoint(config.endpoint);

    try {
      // Dynamic import so the worker build isn't coupled to @aws-sdk at compile time
      const { S3Client, ListObjectsV2Command } = await import("@aws-sdk/client-s3").catch(() => {
        throw new ConnectorError(
          "@aws-sdk/client-s3 is not installed. Add it to api/package.json to enable the S3 connector.",
          "config_error"
        );
      });

      const client = new S3Client({
        region: creds.region,
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
        endpoint,
        forcePathStyle: endpoint !== undefined,
      });

      const files: FileRef[] = [];
      let continuationToken: string | undefined;

      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: config.bucket,
            Prefix: config.prefix || undefined,
            ContinuationToken: continuationToken,
            MaxKeys: 1000,
          })
        );

        for (const obj of response.Contents ?? []) {
          if (!obj.Key) continue;
          if (obj.Key.endsWith("/")) continue; // skip directories

          const ext = obj.Key.split(".").pop()?.toLowerCase() ?? "";
          if (config.fileExtensions.length > 0 && !config.fileExtensions.includes(ext)) continue;

          files.push({
            id: obj.ETag ?? obj.Key,
            name: obj.Key.split("/").pop() ?? obj.Key,
            path: obj.Key,
            size: obj.Size,
            modifiedAt: obj.LastModified?.toISOString(),
            etag: obj.ETag,
          });
        }

        continuationToken = files.length >= 1000 ? undefined : response.NextContinuationToken;
      } while (continuationToken);

      return files;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("InvalidAccessKeyId") || message.includes("SignatureDoesNotMatch")) {
        throw new ConnectorError(`S3 authentication failed: ${message}`, "auth_failed");
      }
      if (message.includes("SlowDown") || message.includes("RequestThrottled")) {
        throw new ConnectorError(`S3 rate limited: ${message}`, "rate_limited", true);
      }
      throw new ConnectorError(`S3 list failed: ${message}`, "network_error", true);
    }
  }

  async downloadFile(
    rawConfig: Record<string, unknown>,
    rawCreds: Record<string, unknown>,
    fileRef: FileRef
  ): Promise<Buffer> {
    const config = s3ConfigSchema.parse(rawConfig);
    const creds = s3CredentialsSchema.parse(rawCreds);
    const endpoint = await resolveCustomEndpoint(config.endpoint);
    if (typeof fileRef.size === "number") {
      enforceUploadSize(fileRef.size, fileRef.name);
    }

    try {
      const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3").catch(() => {
        throw new ConnectorError(
          "@aws-sdk/client-s3 is not installed.",
          "config_error"
        );
      });

      const client = new S3Client({
        region: creds.region,
        credentials: {
          accessKeyId: creds.accessKeyId,
          secretAccessKey: creds.secretAccessKey,
          sessionToken: creds.sessionToken,
        },
        endpoint,
        forcePathStyle: endpoint !== undefined,
      });

      const response = await client.send(
        new GetObjectCommand({
          Bucket: config.bucket,
          Key: fileRef.path,
        })
      );

      if (!response.Body) {
        throw new ConnectorError(`S3 object ${fileRef.path} returned empty body`, "not_found");
      }
      if (typeof response.ContentLength === "number") {
        enforceUploadSize(response.ContentLength, fileRef.name);
      }

      // transformToByteArray is available on the S3 response Body
      const bytes = await (response.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
      enforceUploadSize(bytes.byteLength, fileRef.name);
      return Buffer.from(bytes);
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new ConnectorError(`S3 download failed: ${message}`, "network_error", true);
    }
  }

  async validateCredentials(rawCreds: Record<string, unknown>): Promise<boolean> {
    const creds = s3CredentialsSchema.safeParse(rawCreds);
    if (!creds.success) return false;
    // Minimal validation: check that credentials parse correctly; a real check
    // would call GetBucketLocation on a known bucket.
    return true;
  }
}

import type { S3ClientConfig } from "@aws-sdk/client-s3";
import { s3ClientConfig, type ObjectStorageConfig } from "@docslurp/shared";

/** A bucket alias already identifies the bucket; do not append its name again. */
export function uploadSigningTarget(storage: ObjectStorageConfig, publicBucketUrl?: string): {
  config: S3ClientConfig; bucket: string;
} {
  const config = s3ClientConfig(storage);
  if (!publicBucketUrl) return { config, bucket: storage.bucket };
  const url = new URL(publicBucketUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("DOCSLURP_STORAGE_PUBLIC_BUCKET_URL must be an HTTPS bucket origin without credentials, path or query");
  }
  return {
    config: { ...config, endpoint: undefined, bucketEndpoint: true, forcePathStyle: false },
    bucket: url.origin,
  };
}

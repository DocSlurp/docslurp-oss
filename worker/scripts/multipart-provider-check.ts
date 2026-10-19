/**
 * Real-provider check for MultipartUploadWriter: streams ~40 MB through it with irregular write
 * sizes, verifies the round-trip sha256, then deletes the object.
 *
 * Env: CHECK_ENDPOINT, CHECK_BUCKET, CHECK_ACCESS_KEY_ID, CHECK_SECRET_ACCESS_KEY, [CHECK_PREFIX]
 * Usage: pnpm exec tsx scripts/multipart-provider-check.ts
 */
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { DeleteObjectCommand, GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ArtifactStore } from "../src/tools/storage.js";

const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};
const bucket = need("CHECK_BUCKET");
const client = new S3Client({
  region: "auto",
  endpoint: need("CHECK_ENDPOINT"),
  credentials: { accessKeyId: need("CHECK_ACCESS_KEY_ID"), secretAccessKey: need("CHECK_SECRET_ACCESS_KEY") },
});
const store = Object.create(ArtifactStore.prototype) as Record<string, unknown>;
store.bucket = bucket;
store.client = client;

const key = `${process.env.CHECK_PREFIX ?? "s3burn-r2-multipart-test/"}${Date.now()}.bin`;
const sizes = [1, 777, 3_000_000, 5_242_880, 123_457, 9_999_999, 64, 4_194_304, 6_000_001];
const hash = createHash("sha256");
let total = 0;
function* chunks() {
  let i = 0;
  while (total < 40_000_000) {
    const b = randomBytes(sizes[i++ % sizes.length]!);
    hash.update(b);
    total += b.length;
    yield b;
  }
}
const upload = (store as unknown as ArtifactStore).createMultipartUploadStream(key, "application/octet-stream");
try {
  await new Promise<void>((res, rej) =>
    Readable.from(chunks(), { objectMode: false }).pipe(upload.writable).on("finish", res).on("error", rej),
  );
  await upload.done;
  const got = createHash("sha256");
  const obj = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  let n = 0;
  for await (const c of obj.Body as Readable) { got.update(c); n += c.length; }
  const ok = got.digest("hex") === hash.digest("hex") && n === total;
  console.log(`key=${key} bytes=${total} downloaded=${n} sha256_match=${ok}`);
  if (!ok) process.exitCode = 1;
} finally {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  console.log("deleted", key);
}

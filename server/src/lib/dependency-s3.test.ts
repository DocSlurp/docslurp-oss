import { createServer } from "node:http";
import { afterAll, expect, it, vi } from "vitest";
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { initializeObservability, shutdownObservability, instrumentS3Client } from "@docslurp/shared/observability";

vi.stubEnv("OTEL_ENABLED", "true");
vi.stubEnv("LANGFUSE_ENABLED", "false");
const spans: Array<{ name: string; attributes: Record<string, unknown>; parentSpanContext?: { spanId: string }; spanContext(): { spanId: string } }> = [];
initializeObservability({ spanProcessors: [{ onStart() {}, onEnd(span) { spans.push(span); }, async shutdown() {}, async forceFlush() {} }] });
afterAll(async () => { await shutdownObservability(); vi.unstubAllEnvs(); });

it("traces SDK retry attempts, body consumption and presigning without changing requests", async () => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    if (requests === 1) { response.writeHead(503); response.end(); return; }
    response.writeHead(200, { "content-length": "6", "x-amz-request-id": "s3-request" });
    response.end(request.method === "HEAD" ? undefined : "answer");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test endpoint");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const client = instrumentS3Client(new S3Client({ endpoint, forcePathStyle: true, region: "us-east-1", maxAttempts: 2,
    credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" } }), endpoint);
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: "test-bucket", Key: "test-object" }));
    expect(spans.filter(span => span.name === "s3.GetObject.attempt")).toHaveLength(2);
    expect(spans.some(span => span.name === "s3.GetObject")).toBe(false);
    expect(await response.Body!.transformToString()).toBe("answer");
    const command = spans.find(span => span.name === "s3.GetObject")!;
    expect(command.attributes).toMatchObject({ "http.request.resend_count": 1, "aws.requestId": "s3-request" });
    for (const span of spans.filter(span => span.name === "s3.GetObject.attempt")) expect(span.parentSpanContext?.spanId).toBe(command.spanContext().spanId);
    const beforeSigning = requests;
    expect(await getSignedUrl(client, new PutObjectCommand({ Bucket: "test-bucket", Key: "test-object" }), { expiresIn: 60 })).toContain("X-Amz-Signature");
    expect(requests).toBe(beforeSigning);
    await client.send(new HeadObjectCommand({ Bucket: "test-bucket", Key: "test-object" }));
    expect(spans.some(span => span.name === "s3.HeadObject")).toBe(true);
    expect(JSON.stringify(spans.map(span => span.attributes))).not.toContain("test-secret");
  } finally {
    client.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("keeps HeadObject 404 existence probes out of the error status but still marks real errors", async () => {
  const server = createServer((request, response) => {
    response.writeHead(request.url?.includes("forbidden") ? 403 : 404);
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test endpoint");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const client = instrumentS3Client(new S3Client({ endpoint, forcePathStyle: true, region: "us-east-1", maxAttempts: 1,
    credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" } }), endpoint);
  const ended = spans as unknown as Array<{ name: string; attributes: Record<string, unknown>; status: { code: number } }>;
  try {
    spans.length = 0;
    await expect(client.send(new HeadObjectCommand({ Bucket: "test-bucket", Key: "missing" }))).rejects.toMatchObject({ name: "NotFound" });
    const probes = ended.filter(span => span.name === "s3.HeadObject" || span.name === "s3.HeadObject.attempt");
    expect(probes).toHaveLength(2);
    for (const span of probes) {
      expect(span.status.code).not.toBe(2);
      expect(span.attributes["error.type"]).toBeUndefined();
      expect(span.attributes["http.response.status_code"]).toBe(404);
    }

    spans.length = 0;
    await expect(client.send(new HeadObjectCommand({ Bucket: "test-bucket", Key: "forbidden" }))).rejects.toBeDefined();
    const failures = ended.filter(span => span.name === "s3.HeadObject" || span.name === "s3.HeadObject.attempt");
    expect(failures).toHaveLength(2);
    for (const span of failures) {
      expect(span.status.code).toBe(2);
      expect(span.attributes["error.type"]).toBeDefined();
    }

    spans.length = 0;
    await expect(client.send(new GetObjectCommand({ Bucket: "test-bucket", Key: "missing" }))).rejects.toBeDefined();
    const get = ended.find(span => span.name === "s3.GetObject")!;
    expect(get.status.code).toBe(2);
  } finally {
    client.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

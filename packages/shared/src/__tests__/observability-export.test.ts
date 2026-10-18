import { createServer } from "node:http";
import { gunzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import { aiResultDetails, flushObservability, withObservation, withDependencySpan, recordUsageReceipt } from "../observability.js";

afterEach(() => vi.unstubAllEnvs());

type ExportedSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  attributes: Array<{ key: string; value: { stringValue: string } }>;
};
type ExportedBatch = { resourceSpans: Array<{ scopeSpans: Array<{ spans: ExportedSpan[] }> }> };

it("exports a complete v4 root, generation and child span through the real SDK", async () => {
  const requests: Array<{ version: string | string[] | undefined; body: ExportedBatch }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    requests.push({
      version: request.headers["x-langfuse-ingestion-version"],
      body: JSON.parse((request.headers["content-encoding"] === "gzip" ? gunzipSync(bytes) : bytes).toString()),
    });
    expect(request.url).toBe("/api/public/otel/v1/traces");
    response.setHeader("Content-Type", "application/json");
    response.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing collector address");
    vi.stubEnv("LANGFUSE_ENABLED", "true");
    vi.stubEnv("LANGFUSE_BASE_URL", `http://127.0.0.1:${address.port}`);
    vi.stubEnv("LANGFUSE_PUBLIC_KEY", "test-public");
    vi.stubEnv("LANGFUSE_SECRET_KEY", "test-secret");
    vi.stubEnv("LANGFUSE_CAPTURE_CONTENT", "true");
    await withObservation({ name: "canary-root", input: "request", metadata: { userId: "user", sessionId: "session" }, result: value => ({ output: value }) }, async () => {
      await withObservation({ name: "canary-generation", type: "generation", model: "test-model", result: aiResultDetails }, async () => ({ text: "answer", usage: { inputTokens: 7, outputTokens: 2 } }));
      await withObservation({ name: "canary-child", type: "span" }, async () => null);
      await withDependencySpan("s3.GetObject", {
        "docslurp.dependency.type": "s3", "docslurp.dependency.provider": "backblaze",
        "server.address": "s3.example.test", "aws.requestId": "provider-request",
        "docslurp.runId": "run-123", "authorization": "Bearer must-not-export",
      }, async () => {
        recordUsageReceipt({ id: "usage-123", provider: "deepinfra", model: "embedding-model", metric: "embedding",
          costCents: 12, inputTokens: 123, metadata: { providerCostCents: 2, runId: "run-123" } });
      });
      return "response";
    });
    await flushObservability();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every(request => request.version === "4")).toBe(true);
    const spans = requests.flatMap(request => request.body.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)));
    expect(spans).toHaveLength(5);
    const root = spans.find(span => span.name === "canary-root");
    if (!root) throw new Error("Missing root observation");
    for (const span of spans) {
      const attrs = Object.fromEntries(span.attributes.map(attr => [attr.key, attr.value.stringValue]));
      expect(span.traceId).toBe(root.traceId);
      expect(attrs["langfuse.trace.name"]).toBe("canary-root");
      expect(attrs["user.id"]).toBe("user");
      expect(attrs["session.id"]).toBe("session");
      if (span !== root) expect(span.parentSpanId).toBe(
        span.name === "usage.receipt" ? spans.find(item => item.name === "s3.GetObject")!.spanId : root.spanId,
      );
      if (span.name === "s3.GetObject") {
        expect(attrs["docslurp.dependency.provider"]).toBe("backblaze");
        expect(attrs["server.address"]).toBe("s3.example.test");
        expect(attrs["aws.requestId"]).toBe("provider-request");
        expect(attrs["docslurp.runId"]).toBe("run-123");
        expect(attrs.authorization).toBeUndefined();
      }
      if (span.name === "usage.receipt") {
        expect(attrs["docslurp.usage.event_id"]).toBe("usage-123");
        expect(attrs["docslurp.dependency.provider"]).toBe("deepinfra");
        expect(attrs["docslurp.runId"]).toBe("run-123");
        const values = Object.fromEntries(span.attributes.map(attr => [attr.key, attr.value]));
        expect(values["docslurp.usage.provider_cost_usd"]).toEqual({ doubleValue: 0.02 });
        expect(values["docslurp.usage.billable_credits"]).toEqual({ intValue: 12 });
      }
      if (span === root) {
        expect(attrs["langfuse.observation.input"]).toBe("request");
        expect(attrs["langfuse.observation.output"]).toBe("response");
      }
      if (span.name === "canary-generation") expect(JSON.parse(attrs["langfuse.observation.usage_details"])).toEqual({ input: 7, output: 2 });
      if (span.name === "canary-child") expect(attrs["langfuse.observation.type"]).toBe("span");
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

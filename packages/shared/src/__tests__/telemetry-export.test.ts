import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";

const execute = promisify(execFile);
const canary = fileURLToPath(new URL("../../../../scripts/signoz/otel-canary.mjs", import.meta.url));
// The subprocess exercises emitted ESM, including on clean CI checkouts.
beforeAll(async () => {
  await execute("pnpm", ["build"], { cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 30000 });
}, 35000);

async function collector(status: number) {
  const requests: Array<{ path: string; auth: string | undefined; contentType: string | undefined; bytes: Buffer }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ path: request.url!, auth: request.headers.authorization, contentType: request.headers["content-type"], bytes: Buffer.concat(chunks) });
    response.writeHead(status, { "Content-Type": "application/x-protobuf" });
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Collector unavailable");
  return { requests, endpoint: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

function environment(endpoint: string) {
  return { PATH: process.env.PATH, NODE_ENV: "test", OTEL_ENABLED: "true", LANGFUSE_ENABLED: "false", LANGFUSE_CAPTURE_CONTENT: "true",
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint, OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
    OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer%20collector-test-key",
  };
}

it("exports three real protobuf signals, preserves trace correlation and excludes content and credential attributes", async () => {
  const sink = await collector(200);
  try {
    const { stdout } = await execute(process.execPath, [canary], { env: environment(sink.endpoint), timeout: 15000 });
    const evidence = JSON.parse(stdout.trim().split("\n").at(-1)!);
    expect(evidence.calls).toBe(1);
    for (const path of ["/v1/traces", "/v1/logs", "/v1/metrics"]) {
      const signal = sink.requests.filter(request => request.path === path);
      expect(signal.length).toBeGreaterThan(0);
      expect(signal.every(request => request.auth === "Bearer collector-test-key" && request.contentType?.includes("protobuf"))).toBe(true);
      const bytes = Buffer.concat(signal.map(request => request.bytes));
      expect(bytes.includes(Buffer.from("docslurp-otel-canary"))).toBe(true);
      for (const secret of ["private-input-never-export", "private-output-never-export", "private-secret-never-export", "collector-test-key"])
        expect(bytes.includes(Buffer.from(secret))).toBe(false);
      if (path !== "/v1/metrics") {
        expect(bytes.includes(Buffer.from(evidence.traceId, "hex"))).toBe(true);
        expect(bytes.includes(Buffer.from("synthetic-provider-request"))).toBe(true);
        expect(bytes.includes(Buffer.from("docslurp.media.costState"))).toBe(true);
      }
      else {
        expect(bytes.includes(Buffer.from("http.server.request.duration"))).toBe(true);
        expect(bytes.includes(Buffer.from("process.memory.usage"))).toBe(true);
        expect(bytes.includes(Buffer.from("docslurp.media.requests"))).toBe(true);
        expect(bytes.includes(Buffer.from("docslurp.media.cost"))).toBe(true);
        expect(bytes.includes(Buffer.from(evidence.marker))).toBe(false);
        expect(bytes.includes(Buffer.from("synthetic-provider-request"))).toBe(false);
        expect(bytes.includes(Buffer.from("docslurp.media.frames"))).toBe(true);
        expect(bytes.includes(Buffer.from("docslurp.media.input_tokens"))).toBe(true);
      }
      if (path === "/v1/logs") {
        // Stable event name (field and attribute) plus a readable body and per-stage line.
        expect(bytes.includes(Buffer.from("docslurp.api.request_completed"))).toBe(true);
        expect(bytes.includes(Buffer.from("GET /__telemetry/canary 200 1ms"))).toBe(true);
        expect(bytes.includes(Buffer.from("event.name"))).toBe(true);
        expect(bytes.includes(Buffer.from("worker.stage.telemetry-canary completed in"))).toBe(true);
      }
    }
  } finally { await sink.close(); }
}, 20000);

it("keeps application callbacks successful and single-shot when the collector is unavailable", async () => {
  const sink = await collector(503);
  try {
    const { stdout, stderr } = await execute(process.execPath, [canary], { env: environment(sink.endpoint), timeout: 20000 });
    expect(JSON.parse(stdout.trim().split("\n").at(-1)!).calls).toBe(1);
    expect(stdout + stderr).not.toContain("collector-test-key");
    expect(sink.requests.length).toBeGreaterThan(0);
  } finally { await sink.close(); }
}, 25000);

for (const fault of ["onStart", "onEnd", "onEmit"]) for (const failBusiness of [false, true]) {
  it(`preserves a single business ${failBusiness ? "error" : "result"} when ${fault} throws synchronously`, async () => {
    const sink = await collector(200);
    try {
      const { stdout } = await execute(process.execPath, [canary, `--fault=${fault}`, ...(failBusiness ? ["--fail-business"] : [])], { env: environment(sink.endpoint), timeout: 15000 });
      const evidence = JSON.parse(stdout.trim().split("\n").at(-1)!);
      expect(evidence.calls).toBe(1);
      expect(evidence.businessErrorPreserved).toBe(failBusiness);
    } finally { await sink.close(); }
  }, 20000);
}

it("worker exceptions reuse the shared protobuf exporter and its shutdown", async () => {
  const sink = await collector(200);
  try {
    const runtime = new URL("../../dist/telemetry.js", import.meta.url).href;
    const errors = new URL("../../dist/error-reporting.js", import.meta.url).href;
    await execute(process.execPath, ["--input-type=module", "-e", `
      import { initializeObservability, shutdownObservability } from ${JSON.stringify(runtime)};
      import { initializeWorkerErrorReporting, reportException } from ${JSON.stringify(errors)};
      initializeObservability({ serviceName: "docslurp-worker" });
      initializeWorkerErrorReporting();
      reportException(new Error("shared-worker-exception api_key=private-exception-key"), { runId: "worker-test-run" });
      await shutdownObservability();
    `], { env: { ...environment(sink.endpoint), NODE_ENV: "development" }, timeout: 15000 });
    const logs = sink.requests.filter(request => request.path === "/v1/logs");
    expect(logs).toHaveLength(1);
    expect(logs[0]!.contentType).toContain("protobuf");
    expect(logs[0]!.bytes.includes(Buffer.from("shared-worker-exception"))).toBe(true);
    expect(logs[0]!.bytes.includes(Buffer.from("worker-test-run"))).toBe(true);
    expect(logs[0]!.bytes.includes(Buffer.from("private-exception-key"))).toBe(false);
  } finally { await sink.close(); }
}, 20000);

async function startupLog(env: Record<string, string | undefined>) {
  const runtime = new URL("../../dist/telemetry.js", import.meta.url).href;
  return execute(process.execPath, ["--input-type=module", "-e", `
    import { initializeObservability, shutdownObservability } from ${JSON.stringify(runtime)};
    initializeObservability({ serviceName: "docslurp-api" });
    await shutdownObservability();
  `], { env: { PATH: process.env.PATH, ...env }, timeout: 15000 });
}

it("names every active destination in the startup log", async () => {
  const sink = await collector(200);
  try {
    const { stdout, stderr } = await startupLog({ ...environment(sink.endpoint), NODE_ENV: "production" });
    expect(stdout).toContain("[observability] enabled destinations=otlp-traces,otlp-metrics,otlp-logs");
    expect(stderr).not.toContain("OTLP export not configured");
    expect(stdout + stderr).not.toContain("collector-test-key");
  } finally { await sink.close(); }
}, 20000);

it("warns in production when only Langfuse is configured", async () => {
  const { stdout, stderr } = await startupLog({ NODE_ENV: "production",
    LANGFUSE_PUBLIC_KEY: "pk-lf-test", LANGFUSE_SECRET_KEY: "sk-lf-test", LANGFUSE_BASE_URL: "http://127.0.0.1:9" });
  expect(stdout).toContain("[observability] enabled destinations=langfuse");
  expect(stderr).toContain("OTLP export not configured");
}, 20000);

it("stays quiet about OTLP when export is explicitly disabled", async () => {
  const { stderr } = await startupLog({ NODE_ENV: "production", OTEL_ENABLED: "false",
    LANGFUSE_PUBLIC_KEY: "pk-lf-test", LANGFUSE_SECRET_KEY: "sk-lf-test", LANGFUSE_BASE_URL: "http://127.0.0.1:9" });
  expect(stderr).not.toContain("OTLP export not configured");
}, 20000);

it("warns once when a production process has no destination at all", async () => {
  const runtime = new URL("../../dist/telemetry.js", import.meta.url).href;
  const { stderr } = await execute(process.execPath, ["--input-type=module", "-e", `
    import { initializeObservability } from ${JSON.stringify(runtime)};
    for (let i = 0; i < 3; i++) if (initializeObservability({ serviceName: "docslurp-api" })) throw new Error("unexpected runtime");
  `], { env: { PATH: process.env.PATH, NODE_ENV: "production" }, timeout: 15000 });
  expect(stderr.match(/OTLP export not configured/g)).toHaveLength(1);
}, 20000);

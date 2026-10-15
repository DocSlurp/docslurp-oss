import { createServer } from "node:http";
import { once } from "node:events";
import { describe, it, expect, vi } from "vitest";
import { flushErrorReporting, initializeWorkerErrorReporting, reportException } from "../error-reporting.js";

describe("exception OTLP delivery", () => {
  it("exports the actual cause to a local collector", async () => {
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => { bodies.push(body); response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No collector port");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("OTEL_EXPORTER_OTLP_LOGS_ENDPOINT", `http://127.0.0.1:${address.port}/v1/logs`);
    vi.stubEnv("OTEL_EXPORTER_OTLP_LOGS_HEADERS", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      initializeWorkerErrorReporting();
      reportException(new Error("Extraction failed", { cause: new Error("provider insufficient credits; api_key=secret-value") }), { runId: "test-run" });
      await flushErrorReporting();
      expect(bodies).toHaveLength(1);
      const payload = JSON.parse(bodies[0]!);
      expect(payload.resourceLogs).toHaveLength(1);
      expect(bodies[0]).toContain("docslurp-worker");
      expect(bodies[0]).toContain("provider insufficient credits");
      expect(bodies[0]).toContain("test-run");
      expect(bodies[0]).not.toContain("secret-value");
    } finally {
      vi.unstubAllEnvs(); vi.restoreAllMocks();
      server.close(); await once(server, "close");
    }
  });
});

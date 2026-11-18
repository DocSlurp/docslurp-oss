import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { serve } from "@hono/node-server";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(), { json: (value: unknown) => value, array: (value: unknown) => value }) }));

import { nativeBodyLimit, nativeErrorHandler } from "../lib/api-error.js";
import { apiPublicErrorMiddleware } from "../lib/public-errors.js";
import { rejectNulBytes } from "../lib/reject-nul.js";
import { rejectLegacyProjectSelection } from "../lib/reject-legacy-project-selection.js";
import { requestContextMiddleware } from "../lib/request-context.js";
import { handleMcpHttp, type McpDispatch } from "../lib/mcp-http.js";

const mcpManifest = { capabilities: [] };
const mcpDispatch: McpDispatch = async () => Response.json(mcpManifest);

const LIMIT = 64;
const PATH = "/v1/uploads/direct/sessions/00000000-0000-4000-8000-000000000000/abort";

/** The production `/v1/*` order (server.ts): context, public errors, body cap, NUL scan, legacy-selection guard. */
function app() {
  const app = new Hono();
  app.onError(nativeErrorHandler((error, c) => c.json({ error: error.message }, error instanceof HTTPException ? error.status : 500)));
  app.use("*", requestContextMiddleware);
  app.use("*", apiPublicErrorMiddleware);
  app.use("/v1/*", nativeBodyLimit(LIMIT));
  app.use("*", rejectNulBytes);
  app.use("/v1/*", rejectLegacyProjectSelection);
  // Stands in for the abort route; a success status so the public error middleware leaves its body alone.
  app.post("/v1/uploads/direct/sessions/:sessionId/abort", c => c.json({ route: "abort", bytes: c.req.raw.body ? "body" : "none" }, 202));
  app.delete("/v1/documents/:documentId", c => c.json({ route: "delete", bytes: c.req.raw.body ? "body" : "none" }, 202));
  app.post("/v1/validated", zValidator("json", z.object({ name: z.string() })), c => c.json({ route: "validated" }, 202));
  app.all("/v1/mcp", c => handleMcpHttp(c.req.raw, mcpManifest, mcpDispatch));
  app.post("/v1/throws", () => { throw new HTTPException(400, { message: "Malformed JSON in request body" }); });
  return app;
}

let server: ReturnType<typeof serve>;
let port = 0;
beforeAll(async () => {
  await new Promise<void>(resolve => {
    server = serve({ fetch: app().fetch, port: 0, hostname: "127.0.0.1" }, () => resolve());
  });
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>(resolve => server.close(() => resolve())));

/** A raw HTTP/1.1 request: the headers sent are exactly these (Node adds none for a body-less `end()`). */
function raw(headers: Record<string, string>, body?: string | string[], path = PATH): Promise<{ status: number; body: string; sent: http.OutgoingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "POST", path, headers }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, sent: req.getHeaders() }));
    });
    req.on("error", reject);
    for (const chunk of typeof body === "string" ? [body] : body ?? []) req.write(chunk);
    req.end();
  });
}

/**
 * Bytes on the wire, exactly: no Content-Length and no Transfer-Encoding unless
 * listed. (Node's http client adds `Content-Length: 0` to a body-less POST.)
 */
function wire(method: string, path: string, headers: string[] = [], body = ""): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => { text += chunk; });
    socket.on("end", () => resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0), text }));
    socket.on("error", reject);
    socket.write([`${method} ${path} HTTP/1.1`, "Host: 127.0.0.1", "Connection: close", ...headers, "", body].join("\r\n"));
  });
}

describe("requests with neither Content-Length nor Transfer-Encoding on the wire", () => {
  it("a POST reaches the route with no body", async () => {
    const response = await wire("POST", PATH);
    expect(response.status).toBe(202);
    expect(response.text).toContain('{"route":"abort","bytes":"none"}');
  });

  it("a chunked body with no Content-Type is read: empty reaches the route, bytes get 415", async () => {
    const empty = await wire("POST", PATH, ["Transfer-Encoding: chunked"], "0\r\n\r\n");
    expect(empty.status).toBe(202);
    expect(empty.text).toContain('{"route":"abort","bytes":"none"}');
    const bytes = await wire("POST", PATH, ["Transfer-Encoding: chunked"], "3\r\nabc\r\n0\r\n\r\n");
    expect(bytes.status).toBe(415);
  });

  it("a DELETE reaches the route with no body", async () => {
    const response = await wire("DELETE", "/v1/documents/00000000-0000-4000-8000-000000000000");
    expect(response.status).toBe(202);
    expect(response.text).toContain('{"route":"delete","bytes":"none"}');
  });

  it("an empty JSON body is the validator's refusal, not the content-type guard's", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const headers of [["Content-Type: application/json"], []]) {
        const response = await wire("POST", "/v1/validated", headers);
        expect(response.status).toBe(400);
        const line = warn.mock.calls.map(call => String(call[0])).filter(text => text.startsWith("[api] ") && text.includes("path=/v1/validated")).at(-1);
        // The line must exist, or the next assertion would pass vacuously.
        expect(line).toMatch(/^\[api\] .*status=400/);
        expect(line).not.toMatch(/error_code=unsupported_type/);
        warn.mockClear();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("an empty MCP POST is still a JSON-RPC parse error", async () => {
    const response = await wire("POST", "/v1/mcp", ["Content-Type: application/json", "Accept: application/json, text/event-stream"]);
    expect(response.status).toBe(400);
    expect(response.text).toContain("-32700");
  });
});

describe("body-less POSTs reach the route", () => {
  it.each<[string, Record<string, string>]>([
    ["no Content-Length and no Content-Type (Node fetch / undici)", {}],
    ["Content-Length: 0 and no Content-Type", { "content-length": "0" }],
    ["text/plain with Content-Length: 0", { "content-type": "text/plain", "content-length": "0" }],
    ["application/octet-stream with no body", { "content-type": "application/octet-stream" }],
    ["form-urlencoded with no body", { "content-type": "application/x-www-form-urlencoded" }],
    ["application/json with Content-Length: 0", { "content-type": "application/json", "content-length": "0" }],
  ])("%s", async (_name, headers) => {
    const response = await raw(headers);
    expect(response.sent["content-length"]).toBe(headers["content-length"]);
    expect(response.status).toBe(202);
    expect(JSON.parse(response.body)).toEqual({ route: "abort", bytes: "none" });
  });

  it("still refuses a non-JSON body that carries bytes", async () => {
    const response = await raw({ "content-type": "text/plain" }, '{"workspaceId":"other"}');
    expect(response.status).toBe(415);
    // The raw reason stays out of the response; the public copy is the reviewed one.
    expect(response.body).not.toContain("This endpoint accepts");
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "unsupported_type", message: "Send the request body as application/json.", details: { policy: "request_body:json" } } });
  });
});

describe("body size limits stay exact", () => {
  it("refuses an oversized chunked body that declares no Content-Length", async () => {
    const response = await raw({ "content-type": "application/json" }, ['{"q":"', "x".repeat(LIMIT), '"}']);
    expect(response.sent["content-length"]).toBeUndefined();
    expect(response.status).toBe(413);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "payload_too_large", details: { maxBytes: LIMIT } } });
  });

  it("refuses an oversized body that declares its Content-Length", async () => {
    const body = JSON.stringify({ q: "x".repeat(LIMIT) });
    expect((await raw({ "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }, body)).status).toBe(413);
  });

  it("accepts a body of exactly the limit", async () => {
    const body = JSON.stringify({ q: "x".repeat(LIMIT - 8) });
    expect(Buffer.byteLength(body)).toBe(LIMIT);
    const response = await raw({ "content-type": "application/json" }, body);
    expect(response.status).toBe(202);
    expect(JSON.parse(response.body)).toEqual({ route: "abort", bytes: "body" });
  });
});

describe("refusals reach telemetry, not the client", () => {
  it("logs the middleware's raw reason with the request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await raw({ "content-type": "text/plain" }, "not json");
      expect(response.status).toBe(415);
      const line = warn.mock.calls.map(call => String(call[0])).find(text => text.startsWith("[api] ") && text.includes("status=415"));
      expect(line).toContain("error_code=unsupported_type");
      expect(line).toContain("This endpoint accepts application/json request bodies.");
      expect(response.body).not.toContain("This endpoint accepts");
    } finally {
      warn.mockRestore();
    }
  });

  it("logs a thrown 400's raw message from the error handler", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await raw({}, undefined, "/v1/throws");
      expect(response.status).toBe(400);
      const line = warn.mock.calls.map(call => String(call[0])).find(text => text.startsWith("[api] ") && text.includes("path=/v1/throws"));
      expect(line).toContain('error_reason="Error: Malformed JSON in request body"');
      expect(response.body).not.toContain("Malformed JSON");
    } finally {
      warn.mockRestore();
    }
  });
});

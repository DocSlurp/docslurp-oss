import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { rejectNulBytes } from "./reject-nul.js";
import { describe, expect, it, vi } from "vitest";

import { handleMcpHttp, type McpDispatch } from "./mcp-http.js";

const manifest = { capabilities: [{
  id: "suggestQueries", title: "Suggestions", description: "No AI suggestions", category: "tool",
  inputSchema: { type: "object", properties: { workspaceId: { type: "string" } }, required: ["workspaceId"] },
  annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false },
}] };
const dispatch: McpDispatch = async (path, init) => {
  expect(new Headers(init?.headers).has("Authorization")).toBe(false);
  expect(new Headers(init?.headers).has("Cookie")).toBe(false);
  if (path === "/tools/suggestQueries") return Response.json({ suggestions: ["support hours"] });
  if (path === "/prompts/workspace-grounded-answer") return Response.json({ prompt: "Use citations." });
  return Response.json(manifest);
};

function transport() {
  return new StreamableHTTPClientTransport(new URL("http://localhost/v1/mcp"), {
    fetch: async (url, init) => handleMcpHttp(new Request(url, init), manifest, dispatch),
  });
}

describe("hosted MCP transport", () => {
  it.each([true, false])("initializes and discovers tools through production body middleware (content-length: %s)", async (withLength) => {
    const app = new Hono();
    app.use("*", rejectNulBytes);
    app.use("/v1/mcp", bodyLimit({ maxSize: 1024 * 1024 }));
    app.all("/v1/mcp", (c) => handleMcpHttp(c.req.raw, manifest, dispatch));
    const http = new StreamableHTTPClientTransport(new URL("http://localhost/v1/mcp"), {
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers);
        if (withLength && typeof init?.body === "string") {
          headers.set("content-length", String(Buffer.byteLength(init.body)));
        }
        return app.fetch(new Request(url, { ...init, headers }));
      },
    });
    const client = new Client({ name: "middleware-regression", version: "1" });
    try {
      await client.connect(http);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["suggestQueries"]);
    } finally {
      await client.close();
    }
  });

  it("does not advertise stateful workspace chat as read-only or idempotent", async () => {
    const chatManifest = { capabilities: [...manifest.capabilities, { ...manifest.capabilities[0]!, id: "chat",
      annotations: { readOnly: false, destructive: false, idempotent: false, openWorld: false } }] };
    const response = await handleMcpHttp(new Request("http://localhost/v1/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }), chatManifest, dispatch);
    const wire = await response.text();
    const data = wire.split("\n").find(line => line.startsWith("data: "))?.slice(6) ?? wire;
    const tools = JSON.parse(data).result.tools;
    expect(tools.find((tool: any) => tool.name === "chat").annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
    expect(tools.find((tool: any) => tool.name === "suggestQueries").annotations).toMatchObject({ readOnlyHint: true });
  });

  it("interoperates with the official modern client over HTTP without sessions", async () => {
    const client = new Client({ name: "docslurp-test", version: "1" });
    const http = transport();
    await client.connect(http);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["suggestQueries"]);
    const result = await client.callTool({ name: "suggestQueries", arguments: { workspaceId: "example" } });
    expect(result).toMatchObject({ structuredContent: { suggestions: ["support hours"] }, isError: false });
    expect((await client.listResources()).resources[0]?.uri).toBe("docslurp://capabilities");
    expect((await client.readResource({ uri: "docslurp://capabilities" })).contents).toHaveLength(1);
    expect((await client.listResourceTemplates()).resourceTemplates).toEqual([]);
    expect((await client.getPrompt({ name: "workspace-grounded-answer" })).messages[0]?.content).toEqual({ type: "text", text: "Use citations." });
    await expect(client.callTool({ name: "unknown", arguments: {} })).rejects.toThrow("Unknown tool");
    await expect(client.readResource({ uri: "https://private.example/secret" })).rejects.toThrow("Unknown resource");
    await client.close();
  });

  it("serves legacy initialize and tools/list over Streamable HTTP SSE", async () => {
    const request = (body: unknown) => handleMcpHttp(new Request("http://localhost/v1/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25" }, body: JSON.stringify(body),
    }), manifest, dispatch);
    const initialized = await request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "legacy", version: "1" } } });
    expect(initialized.status).toBe(200);
    expect(initialized.headers.has("mcp-session-id")).toBe(false);
    expect(await initialized.text()).toContain('"protocolVersion":"2025-11-25"');
    const listed = await request({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(await listed.text()).toContain("suggestQueries");
  });

  it("rejects oversized, malformed, non-JSON and session methods before dispatch", async () => {
    const spy = vi.fn(dispatch);
    const oversized = await handleMcpHttp(new Request("http://localhost/v1/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(1_048_577) }), manifest, spy);
    expect(oversized.status).toBe(413);
    const malformed = await handleMcpHttp(new Request("http://localhost/v1/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }), manifest, spy);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: -32700 } });
    expect((await handleMcpHttp(new Request("http://localhost/v1/mcp", { method: "POST", body: "{}" }), manifest, spy)).status).toBe(415);
    expect((await handleMcpHttp(new Request("http://localhost/v1/mcp"), manifest, spy)).status).toBe(405);
    expect(spy).not.toHaveBeenCalled();
  });

  it("propagates disconnects into the scoped adapter signal", async () => {
    const abort = new AbortController();
    let downstream: AbortSignal | null | undefined;
    const pendingDispatch: McpDispatch = async (_path, init) => {
      downstream = init?.signal;
      return new Promise<Response>((resolve) => downstream?.addEventListener("abort", () => resolve(Response.json({ error: "cancelled" }, { status: 408 })), { once: true }));
    };
    const pending = handleMcpHttp(new Request("http://localhost/v1/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "suggestQueries", arguments: {} } }), signal: abort.signal,
    }), manifest, pendingDispatch);
    await vi.waitFor(() => expect(downstream).toBeDefined());
    abort.abort();
    expect(downstream?.aborted).toBe(true);
    const response = await pending;
    await response.body?.cancel();
  });
});

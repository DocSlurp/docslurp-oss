import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { rejectNulBytes } from "./reject-nul.js";
import { describe, expect, it, vi } from "vitest";

import { handleMcpHttp, type McpDispatch } from "./mcp-http.js";
import { uploadUiResource, type UploadUiOptions } from "./mcp-ui-resources.js";

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

  it("gives directory listings a title on every tool and on the server", async () => {
    const client = new Client({ name: "docslurp-test", version: "1" });
    await client.connect(transport());
    try {
      const [tool] = (await client.listTools()).tools;
      expect(tool).toMatchObject({ title: "Suggestions", annotations: { title: "Suggestions", readOnlyHint: true, destructiveHint: false } });
      expect(client.getServerVersion()).toMatchObject({ name: "docslurp", title: "DocSlurp", websiteUrl: "https://docslurp.io/docs/mcp" });
      expect((await client.listPrompts()).prompts[0]?.title).toBe("Workspace grounded answer");
    } finally {
      await client.close();
    }
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
    await vi.waitFor(() => expect(downstream?.aborted).toBe(true));
    const response = await pending;
    await response.body?.cancel();
  });

  describe("MCP Apps uploader", () => {
    const uploaderManifest = { capabilities: [...manifest.capabilities, { ...manifest.capabilities[0]!, id: "openUploader", title: "Open uploader",
      annotations: { readOnly: true, destructive: false, idempotent: true, openWorld: false } }] };
    const ui = { bundle: () => "<!doctype html><title>up</title><meta content=\"connect-src __DOCSLURP_CONNECT_SRC__\">", connectDomains: () => ["https://s3.test", "https://b.s3.test"] };
    const uri = uploadUiResource(ui)!.uri;
    async function connect(m: typeof uploaderManifest, options: UploadUiOptions) {
      const client = new Client({ name: "docslurp-test", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost/v1/mcp"), {
        fetch: async (url, init) => handleMcpHttp(new Request(url, init), m, dispatch, options),
      }));
      return client;
    }

    it("advertises the tool with ui meta and serves the versioned widget resource with csp", async () => {
      const client = await connect(uploaderManifest, ui);
      try {
        expect(uri).toMatch(/^ui:\/\/docslurp\/upload\/[0-9a-f]{12}$/);
        const tool = (await client.listTools()).tools.find(item => item.name === "openUploader");
        expect(tool?._meta).toEqual({ ui: { resourceUri: uri }, "ui/resourceUri": uri });
        const listed = (await client.listResources()).resources.find(item => item.uri === uri);
        expect(listed).toMatchObject({ mimeType: "text/html;profile=mcp-app", _meta: { ui: { csp: { connectDomains: ["https://s3.test", "https://b.s3.test"] }, prefersBorder: false } } });
        const [content] = (await client.readResource({ uri })).contents;
        expect(content).toMatchObject({ uri, mimeType: "text/html;profile=mcp-app", text: "<!doctype html><title>up</title><meta content=\"connect-src https://s3.test https://b.s3.test\">" });
        expect(client.getInstructions()).toContain("openUploader");
        // Only the current versioned URI is readable.
        await expect(client.readResource({ uri: "ui://docslurp/upload" })).rejects.toThrow("Unknown resource");
        await expect(client.readResource({ uri: "ui://docslurp/upload/000000000000" })).rejects.toThrow("Unknown resource");
      } finally { await client.close(); }
    });

    it("substitutes 'none' into connect-src when there are no storage origins", async () => {
      const client = await connect(uploaderManifest, { ...ui, connectDomains: () => [] });
      try {
        const [content] = (await client.readResource({ uri })).contents;
        expect((content as { text: string }).text).toContain("connect-src 'none'");
      } finally { await client.close(); }
    });

    it("logs the widget origin tag from params._meta, whitelisted values only, never arguments", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const client = await connect(uploaderManifest, ui);
      try {
        await client.callTool({ name: "suggestQueries", arguments: { workspaceId: "SECRET-WS" }, _meta: { "docslurp/origin": "mcp-app-upload", "docslurp/widgetVersion": "3" } });
        await client.callTool({ name: "suggestQueries", arguments: { workspaceId: "x" }, _meta: { "docslurp/origin": "evil\nforged=1", "docslurp/widgetVersion": "3" } });
        await client.callTool({ name: "suggestQueries", arguments: { workspaceId: "x" } });
        const lines = info.mock.calls.map(call => String(call[0])).filter(line => line.startsWith("[mcp] widget"));
        expect(lines).toEqual(["[mcp] widget tool call tool=suggestQueries origin=mcp-app-upload widget_version=3"]);
        expect(lines.join()).not.toContain("SECRET-WS");
      } finally { await client.close(); info.mockRestore(); }
    });

    it("hides the tool and resource when the flag removed it from the manifest", async () => {
      const client = await connect(manifest as typeof uploaderManifest, ui);
      try {
        expect((await client.listTools()).tools.map(item => item.name)).toEqual(["suggestQueries"]);
        expect((await client.listResources()).resources.map(item => item.uri)).toEqual(["docslurp://capabilities"]);
        await expect(client.readResource({ uri })).rejects.toThrow("Unknown resource");
      } finally { await client.close(); }
    });

    it("omits the uploader while the widget bundle is not built", async () => {
      const client = await connect(uploaderManifest, { ...ui, bundle: () => null });
      try {
        expect((await client.listTools()).tools.map(item => item.name)).toEqual(["suggestQueries"]);
        await expect(client.readResource({ uri })).rejects.toThrow("Unknown resource");
      } finally { await client.close(); }
    });
  });
});

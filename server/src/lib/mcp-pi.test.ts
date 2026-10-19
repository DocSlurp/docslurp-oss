import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type JsonObject, type TranscriptContext } from "@earendil-works/pi-ai";
import { serve } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { handleMcpHttp, type McpDispatch, type McpManifest } from "./mcp-http.js";

const manifest: McpManifest = { capabilities: [{
  id: "suggestQueries",
  title: "Workspace suggestions",
  description: "Suggest queries for a workspace without AI generation.",
  category: "tool",
  inputSchema: {
    type: "object",
    properties: { workspaceId: { type: "string" } },
    required: ["workspaceId"],
    additionalProperties: false,
  },
}] };

// Real Pi execution and MCP HTTP; only the model and document backend are scripted.
async function withEndpoint(dispatch: McpDispatch, run: (client: Client) => Promise<void>) {
  const app = new Hono().all("/v1/mcp", c => handleMcpHttp(c.req.raw, manifest, dispatch));
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  const client = new Client({ name: "docslurp-pi-test", version: "1" });
  try {
    if (!server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    }
    const endpoint = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/mcp`);
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    await run(client);
  } finally {
    try { await client.close(); }
    finally {
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }
}

async function discoverTools(client: Client): Promise<AgentTool[]> {
  const { tools } = await client.listTools();
  return tools.map(tool => ({
    name: tool.name,
    label: tool.title ?? tool.name,
    description: tool.description ?? "",
    // Wrap the discovered schema rather than maintaining a separate Pi schema.
    parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
    execute: async (_id, args, signal) => {
      const result = await client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }, { signal });
      return {
        content: result.content.filter(block => block.type === "text"),
        details: result.structuredContent,
        isError: result.isError ?? false,
      };
    },
  }));
}

describe("Pi agent with the DocSlurp MCP HTTP endpoint", () => {
  it("discovers a tool, executes it over HTTP and uses its result in the next model turn", async () => {
    const dispatch = vi.fn<McpDispatch>(async () => Response.json({ suggestions: ["support hours"] }));
    await withEndpoint(dispatch, async client => {
      const tools = await discoverTools(client);
      expect(tools.map(tool => tool.name)).toEqual(["suggestQueries"]);
      expect(tools[0]?.parameters).toMatchObject(manifest.capabilities[0]!.inputSchema);

      const faux = createFauxCore({});
      const followUp = vi.fn((context: TranscriptContext) => {
        const result = context.messages.findLast(message => message.role === "toolResult");
        expect(result).toMatchObject({ toolName: "suggestQueries", isError: false });
        const text = result?.content[0];
        if (text?.type !== "text") throw new Error("Expected an MCP text result in Pi's model context");
        expect(JSON.parse(text.text)).toEqual({ suggestions: ["support hours"] });
        return fauxAssistantMessage("Try searching for support hours.");
      });
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("suggestQueries", { workspaceId: "example" }, { id: "suggest-1" })),
        followUp,
      ]);
      const agent = new Agent({ initialState: { model: faux.getModel(), tools }, streamFn: faux.streamSimple });
      const events: string[] = [];
      agent.subscribe(event => { events.push(event.type); });
      await agent.prompt("Suggest a query for workspace example.");

      expect(agent.state.errorMessage).toBeUndefined();
      expect(faux.state.callCount).toBe(2);
      expect(followUp).toHaveBeenCalledOnce();
      expect(dispatch).toHaveBeenCalledOnce();
      const [path, init] = dispatch.mock.calls[0]!;
      expect(path).toBe("/tools/suggestQueries");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(init?.body as string)).toEqual({ workspaceId: "example" });
      expect(agent.state.messages.at(-1)).toMatchObject({
        role: "assistant", content: [{ type: "text", text: "Try searching for support hours." }],
      });
      expect(events).toContain("tool_execution_start");
      expect(events).toContain("tool_execution_end");
      expect(events.at(-1)).toBe("agent_end");
    });
  });

  it.each<{ name: string; args: JsonObject; response: () => Response; error: string; dispatched: boolean }>([
    { name: "adapter errors", args: { workspaceId: "missing" }, response: () => Response.json({ error: "Workspace not found" }, { status: 404 }), error: "Workspace not found", dispatched: true },
    { name: "unexpected backend failures", args: { workspaceId: "example" }, response: () => { throw new Error("private backend details"); }, error: "DocSlurp request failed", dispatched: true },
    { name: "invalid discovered-schema arguments", args: {}, response: () => Response.json({}), error: "workspaceId", dispatched: false },
  ])("reports $name to Pi as tool failures", async ({ args, response, error, dispatched }) => {
    const dispatch = vi.fn<McpDispatch>(async () => response());
    await withEndpoint(dispatch, async client => {
      const faux = createFauxCore({});
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall("suggestQueries", args, { id: "suggest-error" })),
        fauxAssistantMessage("The suggestion tool failed."),
      ]);
      const agent = new Agent({
        initialState: { model: faux.getModel(), tools: await discoverTools(client) },
        streamFn: faux.streamSimple,
      });
      await agent.prompt("Suggest a query.");
      const result = agent.state.messages.find(message => message.role === "toolResult");
      expect(result).toMatchObject({ toolCallId: "suggest-error", toolName: "suggestQueries", isError: true });
      expect(JSON.stringify(result)).toContain(error);
      expect(JSON.stringify(result)).not.toContain("private backend details");
      expect(dispatch).toHaveBeenCalledTimes(dispatched ? 1 : 0);
      expect(faux.state.callCount).toBe(2);
      expect(agent.state.errorMessage).toBeUndefined();
    });
  });
});

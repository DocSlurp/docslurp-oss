import { reportPublicError } from "./public-errors.js";
import { createMcpHandler, ProtocolError, ProtocolErrorCode, Server } from "@modelcontextprotocol/server";

interface Capability {
  id: string;
  title: string;
  description: string;
  category: string;
  inputSchema: Record<string, unknown>;
  /** Agent-safety hints from the capability manifest. Absent → treated as fully unknown (not read-only). */
  annotations?: { readOnly: boolean; destructive: boolean; idempotent: boolean; openWorld: boolean };
}

export interface McpManifest {
  capabilities: Capability[];
}

export type McpDispatch = (path: string, init?: RequestInit) => Promise<Response>;

const CAPABILITIES_URI = "docslurp://capabilities";
const MAX_BODY_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 120_000;

/** Directory listings and client UIs show these; icons and websiteUrl need protocol 2025-11-25. */
const SERVER_INFO = {
  name: "docslurp", title: "DocSlurp", version: "0.1.0",
  description: "Upload documents and media, search them with page citations, and get cited answers from your workspaces.",
  websiteUrl: "https://docslurp.io/docs/mcp",
  icons: [{ src: "https://docslurp.io/brand/icon-512.png", mimeType: "image/png", sizes: ["512x512"] }],
};

/** A capability that declares no hints. Assume it may write, so agents confirm first. */
const UNKNOWN_ANNOTATIONS = { readOnly: false, destructive: false, idempotent: false, openWorld: false };

function createServer(manifest: McpManifest, adapterDispatch: McpDispatch, signal: AbortSignal): Server {
  const dispatch: McpDispatch = async (path, init) => {
    try { return await adapterDispatch(path, init); }
    catch { throw new ProtocolError(ProtocolErrorCode.InternalError, "DocSlurp request failed"); }
  };
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: {}, resources: {}, prompts: {} },
    instructions: "Use listWorkspaces to discover authorized workspaces. Use upload for URLs or up to 10 presigned file PUT URLs. PUT the bytes then call completeUpload before getUploadStatus. Workspace selection is optional: omitted workspaceId uses the organization default. Use search with q for one query or queries for a batch of cited passages to answer with your own model, or chat for a generated grounded answer that incurs AI usage. Respect workspace and cost constraints.",
  });
  const tools = manifest.capabilities.filter((item) => item.category === "tool");
  server.setRequestHandler("tools/list", () => ({ tools: tools.map((item) => {
    const a = item.annotations ?? UNKNOWN_ANNOTATIONS;
    return {
      name: item.id, title: item.title, description: item.description,
      inputSchema: item.inputSchema as { type: "object"; [key: string]: unknown },
      annotations: { title: item.title, readOnlyHint: a.readOnly, destructiveHint: a.destructive, idempotentHint: a.idempotent, openWorldHint: a.openWorld },
    };
  }) }));
  server.setRequestHandler("tools/call", async (request, ctx) => {
    if (!tools.some((item) => item.id === request.params.name)) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown tool");
    const response = await dispatch(`/tools/${encodeURIComponent(request.params.name)}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request.params.arguments ?? {}),
      signal: AbortSignal.any([signal, ctx.mcpReq.signal]),
    });
    // Known adapter errors are safe, structured responses. Unexpected exceptions
    // stay inside the protocol's generic internal-error boundary.
    const result = await response.json();
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }],
      structuredContent: result as Record<string, unknown>, isError: !response.ok };
  });
  server.setRequestHandler("resources/list", () => ({ resources: [{
    uri: CAPABILITIES_URI, name: "capabilities", title: "DocSlurp capabilities",
    description: "Available tools, schemas and authorization scopes.", mimeType: "application/json",
  }] }));
  server.setRequestHandler("resources/templates/list", () => ({ resourceTemplates: [] }));
  server.setRequestHandler("resources/read", async (request, ctx) => {
    if (request.params.uri !== CAPABILITIES_URI) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown resource URI");
    const response = await dispatch("/resources/capabilities", { signal: AbortSignal.any([signal, ctx.mcpReq.signal]) });
    if (!response.ok) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Resource unavailable");
    return { contents: [{ uri: request.params.uri, mimeType: "application/json", text: await response.text() }] };
  });
  server.setRequestHandler("prompts/list", () => ({ prompts: [{
    name: "workspace-grounded-answer", title: "Workspace grounded answer", description: "Answer from workspace evidence with citations.",
  }] }));
  server.setRequestHandler("prompts/get", async (request) => {
    if (request.params.name !== "workspace-grounded-answer") throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown prompt");
    const response = await dispatch("/prompts/workspace-grounded-answer", { signal });
    const result = await response.json() as { prompt: string };
    return { messages: [{ role: "user" as const, content: { type: "text" as const, text: result.prompt } }] };
  });
  return server;
}

/** One request, one scoped server; no sessions, network hop or credential forwarding. */
export async function handleMcpHttp(request: Request, manifest: McpManifest, dispatch: McpDispatch): Promise<Response> {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  const controller = new AbortController();
  const signal = AbortSignal.any([request.signal, controller.signal]);
  const timeout = setTimeout(() => controller.abort(new Error("MCP request timeout")), REQUEST_TIMEOUT_MS);
  let handler: ReturnType<typeof createMcpHandler> | undefined;
  let responseReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
    controller.abort();
    await responseReader?.cancel().catch(() => {});
    await handler?.close();
  };
  const onAbort = () => { void close(); };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") ?? "")) {
      await close(); return new Response("Expected application/json", { status: 415 });
    }
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (reader) {
      const abort = () => { void reader.cancel().catch(() => {}); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        while (true) {
          signal.throwIfAborted();
          const { value, done } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > MAX_BODY_BYTES) {
            await reader.cancel(); await close(); return new Response("MCP request too large", { status: 413 });
          }
          chunks.push(value);
        }
      } finally { signal.removeEventListener("abort", abort); reader.releaseLock(); }
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    signal.throwIfAborted();
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { await close(); return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400 }); }
    handler = createMcpHandler(() => createServer(manifest, dispatch, signal), { legacy: "stateless", responseMode: "auto", maxSubscriptions: 0 });
    const boundedRequest = new Request(request.url, { method: request.method, headers: request.headers, signal });
    const response = await handler.fetch(boundedRequest, { parsedBody: body });
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    if (!response.body) { await close(); return new Response(null, { status: response.status, headers }); }
    responseReader = response.body.getReader();
    const streamReader = responseReader;
    const bodyStream = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const { value, done } = await streamReader.read();
          if (done) { stream.close(); await close(); }
          else stream.enqueue(value);
        } catch (error) { reportPublicError(error, { operation: "mcp-stream" }); stream.error(error); await close(); }
      },
      async cancel() { await close(); },
    });
    return new Response(bodyStream, { status: response.status, headers });
  } catch (error) {
    reportPublicError(error, { operation: "mcp-request" });
    const aborted = signal.aborted;
    await close();
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32603, message: aborted ? "Request cancelled or timed out" : "Internal server error" } }, { status: aborted ? 408 : 500 });
  }
}

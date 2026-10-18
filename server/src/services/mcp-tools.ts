import { publicErrorMiddleware } from "../lib/public-errors.js";
import { apiErrorResponse, apiStatusError, usesNativeErrorEnvelope } from "../lib/api-error.js";
import { mapValidationIssues, type ValidationErrorSource } from "../lib/validation.js";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { aggregateWorkspaceRagSearchRequestSchema, type ApiErrorCode } from "@docslurp/shared";

import {
  apiKeyHasAnyScope,
} from "../lib/api-key-authorization.js";
import { getApiKey, getRequestActor, loadActorScopedWorkspace, resolveActorWorkspaceId, setRequestActor, type RequestActor } from "../lib/request-actor.js";
import { listWorkspaces } from "./workspaces.js";
import { apiKeyCanUseWorkspace } from "../lib/api-key-workspace-scope.js";
import { listWorkspacesInput, uploadInput, completeUploadInput, productToolAliases, productToolDefinitions } from "./mcp-product-tools.js";
import { aiAdvancedToolSchema, aiSimpleToolSchema, toolInputJsonSchema } from "./mcp-tool-schemas.js";
import { batchSearchInputSchema, searchInputSchema, workspaceChatInputSchema } from "../lib/search-input.js";
import { mcpOrigin } from "../lib/mcp-origin.js";
import { searchRoutes } from "../routes/search.js";
import { sql } from "../db.js";
import { isProtectedStoredQuery } from "../search/session.js";
import { spendAwareErrorHandler } from "./billing/spend-guard.js";
import { aggregateWorkspaceRagSearch } from "../services/aggregate-rag.js";
import { loadIngestReport, summarizeIngestReport } from "./ingest-report.js";
import {
  getAutomationCapabilityManifest,
  getAutomationOperation,
  submitAdvancedAutomation,
  submitSimpleAutomation
} from "../services/automation.js";

const operationInputSchema = z.object({ operationId: z.string().uuid() });

const workspaceIngestReportSchema = z.object({
  workspaceId: z.string().min(1).max(256).optional(),
  runId: z.string().trim().min(1).max(128).optional(),
  documentIds: z.array(z.string().min(1).max(128)).max(100).optional(),
}).strict();
const workspaceSuggestSchema = z.object({
  workspaceId: z.string().min(1).max(256).optional(),
  q: z.string().max(10_000).optional(),
  limit: z.number().int().min(1).max(25).optional(),
});

// Agent-safety hints live with the tool definition so every surface (remote MCP,
// WebMCP, chat tools) reads the same values instead of inferring them per surface.
type ToolAnnotations = { readOnly: boolean; destructive: boolean; idempotent: boolean; openWorld: boolean };
const READ_ONLY_TOOL: ToolAnnotations = { readOnly: true, destructive: false, idempotent: true, openWorld: false };
const workspaceToolAnnotations: Record<string, ToolAnnotations> = {
  search: READ_ONLY_TOOL,
  chat: { readOnly: false, destructive: false, idempotent: false, openWorld: false },
  "ingest-report": READ_ONLY_TOOL,
  suggest: READ_ONLY_TOOL,
};

/**
 * The product search tool accepts one query or a batch, both defined by the
 * search route's own zod schemas. MCP requires an object at the top level, so
 * the two forms are merged into one object whose oneOf keeps them exclusive.
 */
function searchToolInputSchema() {
  const single = toolInputJsonSchema(searchInputSchema) as { properties: Record<string, unknown> };
  const { properties: batch } = toolInputJsonSchema(batchSearchInputSchema) as { properties: Record<string, unknown> };
  return {
    type: "object", additionalProperties: false,
    properties: { ...single.properties, ...batch },
    oneOf: [
      { required: ["q"], not: { anyOf: Object.keys(batch).map(key => ({ required: [key] })) } },
      { required: ["queries"], not: { anyOf: Object.keys(single.properties).map(key => ({ required: [key] })) } },
    ],
  };
}

function legacyManifest(baseUrl: string, scopes?: string[]) {
  const manifest = getAutomationCapabilityManifest(baseUrl);
  return {
    ...manifest,
    // The MCP surface knows its own transports; never inherit a stale claim.
    server: { ...manifest.server, transports: ["streamable-http", "stdio"], endpoint: `${baseUrl}/v1/mcp` },
    capabilities: [
      ...manifest.capabilities,
      {
        id: "ai.operation.get", title: "Get Automation Operation",
        description: "Read an automation operation by ID, including pending approval, progress, errors and final result. Poll on a later turn if still running.",
        category: "tool", endpoint: `${baseUrl}/v1/mcp/tools/ai.operation.get`,
        inputSchema: toolInputJsonSchema(operationInputSchema),
        annotations: READ_ONLY_TOOL,
      },
      ...[
        { name: "search", title: "Search Workspace", description: "Retrieve portable text passages with source citations. Use these as context for any LLM; this tool does not generate an answer.", inputSchema: toolInputJsonSchema(searchInputSchema) },
        { name: "chat", title: "Chat With Workspace", description: "Generate a grounded answer with citations and token usage using the workspace's configured model. This calls AI and can incur cost; use workspace.search for your own LLM.", inputSchema: toolInputJsonSchema(workspaceChatInputSchema) },
        { name: "ingest-report", title: "Workspace Ingest Report", description: "Report how the workspace's files processed, without AI calls: pages, bytes and plain-text bytes per page (histograms), images per page, scanned-looking pages, pages read with vision, searchable pages with a reason for each unsearchable one, failed or skipped stages, cost and pages per minute, the pipeline settings that shaped it, and rule-based recommendations with estimated cost. Use it when a user asks why something cannot be found.", inputSchema: toolInputJsonSchema(workspaceIngestReportSchema) },
        { name: "suggest", title: "Suggest Workspace Queries", description: "Read prior queries and suggestions without AI calls.", inputSchema: toolInputJsonSchema(workspaceSuggestSchema) },
      ].map(({ name, title, description, inputSchema }) => ({
        id: `workspace.${name}`,
        title,
        description,
        category: "tool",
        endpoint: `${baseUrl}/v1/mcp/tools/workspace.${name}`,
        inputSchema,
        annotations: workspaceToolAnnotations[name] ?? READ_ONLY_TOOL,
      })),
    ].filter((tool) => !scopes || tool.category !== "tool" || (tool.id.startsWith("ai.")
      ? scopes.some((scope) => scope === "search" || scope === "ingest")
      : scopes.includes("search"))),
  };
}

/** The public MCP catalog follows the product's upload → search → chat flow. */
export function mcpManifest(baseUrl: string, scopes?: string[]) {
  const manifest = legacyManifest(baseUrl);
  const tools = Object.entries(productToolAliases).map(([name, legacyId]) => {
    const tool = manifest.capabilities.find(item => item.id === legacyId)!;
    return { ...tool, id: name, endpoint: `${baseUrl}/v1/mcp/tools/${name}`,
      description: tool.description.replaceAll("workspace.search", "search"),
      ...(name === "search" ? {
        title: "Search documents",
        description: "Retrieve cited passages for one query (q) or up to 20 independent queries (queries). Supply exactly one form. Batch results stay in input order with per-query errors; each query can select a workspace. Omitted workspace uses the default. Does not generate answers.",
        inputSchema: searchToolInputSchema(),
      } : {}),
      ...(name === "getUploadStatus" ? { title: "Get upload status", description: "Check uploaded files and ingestion progress in a workspace, optionally for a runId returned by upload. Reports searchable pages, failures, costs and processing speed without AI calls. Use before search or chat when files are still processing." } : {}),
    };
  });
  return { ...manifest, capabilities: [...productToolDefinitions(baseUrl), ...tools].filter(tool => {
    if (!scopes) return true;
    if (["upload", "completeUpload"].includes(tool.id)) return scopes.includes("ingest");
    if (["listWorkspaces", "getUploadStatus"].includes(tool.id)) return scopes.some(scope => ["ingest", "search"].includes(scope));
    return scopes.includes("search");
  }) };
}

function routeBaseUrl(_url: string): string {
  return mcpOrigin(_url);
}

// The protocol and compatibility REST adapters share authorization and handlers.
/**
 * These adapter routes serve `/v1/mcp` (legacy `{ error }` bodies) and
 * `/v1/session-tools` (the native envelope); the request path picks the shape.
 */
function adapterError(c: Context, status: number, message: string, code?: ApiErrorCode): Response {
  return usesNativeErrorEnvelope(c.req.path)
    ? apiStatusError(c, status, message, { code })
    : c.json({ error: message }, status as 400);
}

function invalidInput(c: Context, error: ValidationErrorSource & { issues: unknown[] }): Response {
  return usesNativeErrorEnvelope(c.req.path)
    ? apiErrorResponse(c, 400, "invalid_request", "Invalid request", { issues: mapValidationIssues(error) })
    : c.json({ error: { issues: error.issues } }, 400);
}

// Only a trusted in-process dispatcher can skip token authentication here.
const mcpAdapterRoutes = new Hono()
  .use("*", publicErrorMiddleware)
  .onError(spendAwareErrorHandler)
  .get("/manifest", async (c) => {
    return c.json(mcpManifest(routeBaseUrl(c.req.url), getApiKey(c)?.scopes));
  })
  .get("/tools", async (c) => {
    const manifest = mcpManifest(routeBaseUrl(c.req.url), getApiKey(c)?.scopes);
    return c.json({ tools: manifest.capabilities.filter((capability) => capability.category === "tool") });
  })
  .post("/tools/:id", async (c) => {
    const actor = getRequestActor(c);
    const apiKey = getApiKey(c);
    const requestedTool = c.req.param("id");
    const toolId = productToolAliases[requestedTool] ?? requestedTool;
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
      if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("Expected object");
    } catch {
      return adapterError(c, 400, "Expected a JSON object");
    }

    if (toolId === "listWorkspaces") {
      if (apiKey && !apiKeyHasAnyScope(apiKey, ["search", "ingest"])) return adapterError(c, 403, "Forbidden");
      const parsed = listWorkspacesInput.safeParse(body);
      if (!parsed.success) return invalidInput(c, parsed.error);
      const accessible = (await listWorkspaces(actor.userId, { refineNames: false }))
        .filter(workspace => !apiKey || apiKeyCanUseWorkspace(apiKey, workspace));
      const { offset, limit } = parsed.data;
      return c.json({ workspaces: accessible.slice(offset, offset + limit).map(workspace => ({
        id: workspace.id, slug: workspace.slug, name: workspace.name, isDefault: workspace.isDefault,
        documentCount: workspace.documentCount, totalPageCount: workspace.totalPageCount,
        pendingDocumentCount: workspace.pendingDocumentCount, latestRunId: workspace.latestRunId,
        latestRunStatus: workspace.latestRunStatus,
      })), total: accessible.length, nextOffset: offset + limit < accessible.length ? offset + limit : null });
    }

    if (toolId === "upload") {
      if (apiKey && !apiKeyHasAnyScope(apiKey, ["ingest"])) return adapterError(c, 403, "Forbidden");
      const parsed = uploadInput.safeParse(body);
      if (!parsed.success) return invalidInput(c, parsed.error);
      const input = parsed.data;
      if (input.workspaceName && apiKey?.workspaceIds?.length) return adapterError(c, 403, "This key cannot create workspaces outside its allowlist");
      const workspaceId = input.workspaceName ? undefined : await resolveActorWorkspaceId(actor, input.workspaceId);
      if (workspaceId && !await loadActorScopedWorkspace(workspaceId, actor)) return adapterError(c, 404, "Workspace not found", "workspace_not_found");
      // Reuse upload authorization, URL validation, admission, spend checks and idempotency.
      const { uploadsRoutes } = await import("../routes/uploads.js");
      const native = new Hono().use("*", publicErrorMiddleware).use("*", async (inner, next) => {
        setRequestActor(inner, actor);
        await next();
      }).route("/", uploadsRoutes);
      native.onError(spendAwareErrorHandler);
      const headers = new Headers();
      if (input.idempotencyKey) headers.set("Idempotency-Key", input.idempotencyKey);
      headers.set("Content-Type", "application/json");
      return native.request(`http://mcp.internal/${input.urls ? "url" : "direct/sessions"}`, {
        method: "POST", headers, body: JSON.stringify({ workspaceId, workspaceName: input.workspaceName,
          ...(input.urls ? { urls: input.urls } : { files: input.files!.map(file => ({ ...file, singlePart: true })) }),
        }), signal: c.req.raw.signal,
      });
    }

    if (toolId === "completeUpload") {
      if (apiKey && !apiKeyHasAnyScope(apiKey, ["ingest"])) return adapterError(c, 403, "Forbidden");
      const parsed = completeUploadInput.safeParse(body);
      if (!parsed.success) return invalidInput(c, parsed.error);
      const { loadDirectUploadSession } = await import("./direct-upload-session.js");
      const loaded = await loadDirectUploadSession(parsed.data.sessionId, actor.userId);
      if (!loaded || (apiKey && (loaded.session.org_id !== apiKey.orgId ||
        (loaded.session.workspace_id ? !await loadActorScopedWorkspace(loaded.session.workspace_id, actor) : Boolean(apiKey.workspaceIds?.length))))) {
        return adapterError(c, 404, "Upload session not found");
      }
      if (!["pending", "uploading"].includes(loaded.session.status)) return adapterError(c, 409, "Upload session is already confirmed or closed");
      if (loaded.files.length > 10 || loaded.files.some(file => file.upload_mode !== "single") ||
        new Set(parsed.data.fileIds).size !== loaded.files.length || loaded.files.some(file => !parsed.data.fileIds.includes(file.id))) {
        return adapterError(c, 400, "Provide all file IDs from this upload session");
      }
      const { uploadsRoutes } = await import("../routes/uploads.js");
      const native = new Hono().use("*", publicErrorMiddleware).use("*", async (inner, next) => {
        setRequestActor(inner, actor); await next();
      }).route("/", uploadsRoutes);
      native.onError(spendAwareErrorHandler);
      const sessionPath = `/direct/sessions/${parsed.data.sessionId}`;
      for (const fileId of parsed.data.fileIds) {
        const result = await native.request(`http://mcp.internal${sessionPath}/files/complete`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fileId }), signal: c.req.raw.signal,
        });
        if (!result.ok) return result;
      }
      return native.request(`http://mcp.internal${sessionPath}/confirm`, { method: "POST", signal: c.req.raw.signal });
    }

    if (toolId === "ai.operation.get") {
      if (apiKey && !apiKeyHasAnyScope(apiKey, ["search", "ingest"])) return adapterError(c, 403, "Forbidden");
      const parsed = operationInputSchema.safeParse(body);
      if (!parsed.success) return invalidInput(c, parsed.error);
      const operation = await getAutomationOperation({ ...parsed.data, userId: actor.userId, apiKey });
      return operation ? c.json({ operation }) : adapterError(c, 404, "Operation not found");
    }

    if (toolId === "ai.simple") {
      const parsed = aiSimpleToolSchema.safeParse(body);
      if (!parsed.success) return invalidInput(c, parsed.error);
      const request = { ...parsed.data, userId: actor.userId, workspaceId: await resolveActorWorkspaceId(actor, parsed.data.workspaceId) };
      if (request.sourceUrls.length && apiKey && !apiKeyHasAnyScope(apiKey, ["ingest"])) return adapterError(c, 403, "Source ingestion requires ingest scope");
      const submitted = await submitSimpleAutomation({ request, apiKey });
      return c.json({
        tool: toolId,
        operation: submitted.operation,
        events: submitted.events,
        ...(apiKey ? { streamUrl: `${routeBaseUrl(c.req.url)}/v1/ai/operations/${submitted.operation.id}/stream` } : {}),
        pollTool: { name: "ai.operation.get", arguments: { operationId: submitted.operation.id } },
        ...(apiKey ? { pollUrl: `${routeBaseUrl(c.req.url)}/v1/ai/operations/${submitted.operation.id}` } : {})
      }, 202);
    }

    if (toolId === "ai.advanced") {
      const parsed = aiAdvancedToolSchema.safeParse(body);
      if (!parsed.success) return invalidInput(c, parsed.error);
      const request = { ...parsed.data, userId: actor.userId, workspaceId: await resolveActorWorkspaceId(actor, parsed.data.workspaceId) };
      if (request.sourceUrls.length && apiKey && !apiKeyHasAnyScope(apiKey, ["ingest"])) return adapterError(c, 403, "Source ingestion requires ingest scope");
      const submitted = await submitAdvancedAutomation({ request, apiKey });
      return c.json({
        tool: toolId,
        operation: submitted.operation,
        events: submitted.events,
        ...(apiKey ? { streamUrl: `${routeBaseUrl(c.req.url)}/v1/ai/operations/${submitted.operation.id}/stream` } : {}),
        pollTool: { name: "ai.operation.get", arguments: { operationId: submitted.operation.id } },
        ...(apiKey ? { pollUrl: `${routeBaseUrl(c.req.url)}/v1/ai/operations/${submitted.operation.id}` } : {})
      }, 202);
    }

    if (["workspace.search", "workspace.chat"].includes(toolId)) {
      if (apiKey && !apiKeyHasAnyScope(apiKey, ["search"])) return adapterError(c, 403, "Forbidden");
      const actor = c.get("requestActor");
      const native = new Hono().use("*", publicErrorMiddleware).use("*", async (inner, next) => {
        setRequestActor(inner, actor);
        await next();
      }).route("/", searchRoutes);
      native.onError(spendAwareErrorHandler);
      const path = toolId === "workspace.chat" ? "/chat" : "/";
      return native.request(`http://mcp.internal${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: c.req.raw.signal,
      });
    }

    if (toolId === "workspace.aggregate-rag-search") {
      if (apiKey && !apiKeyHasAnyScope(apiKey, ["search"])) return adapterError(c, 403, "Forbidden");
      const parsed = aggregateWorkspaceRagSearchRequestSchema.safeParse(body);
      if (!parsed.success) {
        return invalidInput(c, parsed.error);
      }
      const response = await aggregateWorkspaceRagSearch({
        userId: actor.userId,
        apiKey,
        request: parsed.data,
      });
      return c.json({ tool: toolId, ...response });
    }

    if (toolId === "workspace.ingest-report") {
      if (apiKey && !apiKeyHasAnyScope(apiKey, ["search", "ingest"])) return adapterError(c, 403, "Forbidden");
      const parsed = workspaceIngestReportSchema.safeParse(body);
      if (!parsed.success) return invalidInput(c, parsed.error);
      const workspace = await loadActorScopedWorkspace(
        await resolveActorWorkspaceId(c.get("requestActor"), parsed.data.workspaceId),
        actor,
      );
      if (!workspace) return adapterError(c, 404, "Workspace not found", "workspace_not_found");
      const report = await loadIngestReport({
        workspace, canEdit: false, runId: parsed.data.runId ?? null, documentIds: parsed.data.documentIds ?? null,
      });
      return c.json({ tool: toolId, summary: summarizeIngestReport(report), report });
    }

    if (toolId === "workspace.suggest") {
      if (apiKey && !apiKeyHasAnyScope(apiKey, ["search"])) return adapterError(c, 403, "Forbidden");
      const parsed = workspaceSuggestSchema.safeParse(body);
      if (!parsed.success) return invalidInput(c, parsed.error);
      const suggestBody = parsed.data;
      const workspace = await loadActorScopedWorkspace(
        await resolveActorWorkspaceId(c.get("requestActor"), suggestBody.workspaceId),
        actor,
      );
      if (!workspace) return adapterError(c, 404, "Workspace not found", "workspace_not_found");
      const like = (suggestBody.q ?? "").trim() ? `${(suggestBody.q ?? "").trim()}%` : "%";
      const limit = Math.min(25, Math.max(1, suggestBody.limit ?? 8));
      const suggestions = await sql<{ phrase: string }[]>`
        select phrase
        from (
          select phrase, weight, created_at from query_suggestions where workspace_id = ${workspace.id}
            and user_id = ${actor.userId} and phrase ilike ${like}
          union all
          select s.query as phrase, 10 as weight, s.created_at from search_sessions s
            where s.user_id = ${actor.userId} and (s.metadata ->> 'workspaceId') = ${workspace.id}
              and s.query not like 'enc:%' and s.query not like 'redacted:%' and s.query ilike ${like}
        ) x
        group by phrase
        order by max(weight) desc, max(created_at) desc
        limit ${limit}
      `;
      return c.json({ tool: toolId, suggestions: suggestions.map((r) => r.phrase).filter((phrase) => !isProtectedStoredQuery(phrase)) });
    }

    return adapterError(c, 404, "Unknown MCP tool");
  })
  .get("/resources/:id", async (c) => {
    const actor = getRequestActor(c);
    const apiKey = getApiKey(c);
    const resourceId = c.req.param("id");

    if (resourceId === "ai.capabilities") {
      return c.json(mcpManifest(routeBaseUrl(c.req.url), apiKey?.scopes));
    }

    if (resourceId === "ai.operation") {
      const operationId = c.req.query("operationId");
      if (!operationId) {
        return adapterError(c, 400, "Missing operationId");
      }
      const operation = await getAutomationOperation({
        operationId,
        userId: actor.userId,
        apiKey
      });
      if (!operation) {
        return adapterError(c, 404, "Operation not found");
      }
      return c.json({ operation });
    }

    return adapterError(c, 404, "Unknown MCP resource");
  })
  .get("/prompts/:id", async (c) => {
    if (c.req.param("id") !== "workspace-grounded-answer") {
      return adapterError(c, 404, "Unknown MCP prompt");
    }

    return c.json({
      id: "workspace-grounded-answer",
      prompt: [
        "Answer using only the supplied workspace excerpts.",
        "Every material claim must include citations like [1] or [2].",
        "If the evidence is insufficient, say so plainly."
      ].join("\n")
    });
  });

/** Trusted server-side callers supply the actor, never headers or a synthetic key. */
export function createMcpDispatcher(actor: RequestActor) {
  const adapters = new Hono().use("*", async (c, next) => {
    setRequestActor(c, actor);
    await next();
  }).route("/", mcpAdapterRoutes);
  return async (path: string, init?: RequestInit) => adapters.request(`http://mcp.internal${path}`, init);
}

export { mcpAdapterRoutes };

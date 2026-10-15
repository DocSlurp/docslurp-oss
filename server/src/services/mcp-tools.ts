import { publicErrorMiddleware } from "../lib/public-errors.js";
import { Hono } from "hono";
import { z } from "zod";

import {
  aggregateWorkspaceRagSearchRequestSchema,
  aiAdvancedRequestSchema,
  aiSimpleRequestSchema,
} from "@docslurp/shared";

import {
  apiKeyHasAnyScope,
} from "../lib/api-key-authorization.js";
import { getApiKey, getRequestActor, loadActorScopedWorkspace, resolveActorWorkspaceId, setRequestActor, type RequestActor } from "../lib/request-actor.js";
import { mcpOrigin } from "../lib/mcp-origin.js";
import { searchRoutes } from "../routes/search.js";
import { sql } from "../db.js";
import { spendAwareErrorHandler } from "./billing/spend-guard.js";
import { aggregateWorkspaceRagSearch } from "../services/aggregate-rag.js";
import { loadIngestReport, summarizeIngestReport } from "./ingest-report.js";
import {
  getAutomationCapabilityManifest,
  getAutomationOperation,
  submitAdvancedAutomation,
  submitSimpleAutomation
} from "../services/automation.js";

const WORKSPACE_REF_DESCRIPTION = 'Optional workspace slug (e.g. "legal-contracts"), former slug, or UUID. Omit or pass "default" for the organization default workspace.';
// Tool inputs are the request schemas without identity. Cost approval is never
// a tool argument (the request schemas have none, and unknown keys are
// stripped): every surface built from mcpManifest (remote MCP, WebMCP, chat,
// CLI stdio) inherits that from here.
const aiSimpleToolSchema = aiSimpleRequestSchema.omit({ userId: true }).extend({
  workspaceId: z.string().min(1).max(256).optional().describe(WORKSPACE_REF_DESCRIPTION),
});
const aiAdvancedToolSchema = aiAdvancedRequestSchema.omit({ userId: true }).extend({
  workspaceId: z.string().min(1).max(256).optional().describe(WORKSPACE_REF_DESCRIPTION),
});
const operationInputSchema = z.object({ operationId: z.string().uuid() });

const queryInputSchema = {
  type: "object",
  properties: {
    workspaceId: { type: "string", minLength: 1, maxLength: 256, description: WORKSPACE_REF_DESCRIPTION },
    q: { type: "string", minLength: 1, maxLength: 16_000 },
    limit: { type: "integer", minimum: 1, maximum: 100 },
    documentId: { type: "string", minLength: 1, maxLength: 256 },
    filenameContains: { type: "string" },
    tags: { type: "string", description: "Comma-separated tags." },
  },
  required: ["q"],
};
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

export function mcpManifest(baseUrl: string, scopes?: string[]) {
  const manifest = getAutomationCapabilityManifest(baseUrl);
  return {
    ...manifest,
    server: { ...manifest.server, transports: ["streamable-http", "stdio"], endpoint: `${baseUrl}/v1/mcp` },
    capabilities: [
      ...manifest.capabilities.map((capability) => {
        const schema = capability.id === "ai.simple" ? aiSimpleToolSchema
          : capability.id === "ai.advanced" ? aiAdvancedToolSchema : null;
        return schema ? { ...capability, inputSchema: z.toJSONSchema(schema, { io: "input" }) } : capability;
      }),
      {
        id: "ai.operation.get", title: "Get Automation Operation",
        description: "Read an automation operation by ID, including pending approval, progress, errors and final result. Poll on a later turn if still running.",
        category: "tool", endpoint: `${baseUrl}/v1/mcp/tools/ai.operation.get`,
        inputSchema: z.toJSONSchema(operationInputSchema),
      },
      ...[
        { name: "search", title: "Search Workspace", description: "Retrieve portable text passages with source citations. Use these as context for any LLM; this tool does not generate an answer.", inputSchema: queryInputSchema },
        { name: "search-many", title: "Search Multiple Queries", description: "Run up to 20 scoped retrieval queries with bounded parallelism. Results stay in input order; each contains cited context or its own error. No answer generation.", inputSchema: {
          type: "object", properties: { queries: { type: "array", minItems: 1, maxItems: 20, items: queryInputSchema }, concurrency: { type: "integer", minimum: 1, maximum: 4, default: 4 } }, required: ["queries"],
        } },
        { name: "chat", title: "Chat With Workspace", description: "Generate a grounded answer with citations and token usage using the workspace's configured model. This calls AI and can incur cost; use workspace.search for your own LLM.", inputSchema: {
          type: "object", properties: { workspaceId: { type: "string", minLength: 1, maxLength: 256, description: WORKSPACE_REF_DESCRIPTION }, q: { type: "string", minLength: 1, maxLength: 16_000 }, sessionId: { type: "string", minLength: 1, maxLength: 256 } }, required: ["q"],
        } },
        { name: "ingest-report", title: "Workspace Ingest Report", description: "Report how the workspace's files processed, without AI calls: pages, bytes and plain-text bytes per page (histograms), images per page, scanned-looking pages, pages read with vision, searchable pages with a reason for each unsearchable one, failed or skipped stages, cost and pages per minute, the pipeline settings that shaped it, and rule-based recommendations with estimated cost. Use it when a user asks why something cannot be found.", inputSchema: z.toJSONSchema(workspaceIngestReportSchema) },
        { name: "suggest", title: "Suggest Workspace Queries", description: "Read prior queries and suggestions without AI calls.", inputSchema: {
          type: "object", properties: { workspaceId: { type: "string", minLength: 1, maxLength: 256, description: WORKSPACE_REF_DESCRIPTION }, q: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 25 } },
        } },
      ].map(({ name, title, description, inputSchema }) => ({
        id: `workspace.${name}`,
        title,
        description,
        category: "tool",
        endpoint: `${baseUrl}/v1/mcp/tools/workspace.${name}`,
        inputSchema,
      })),
    ].filter((tool) => !scopes || tool.category !== "tool" || (tool.id.startsWith("ai.")
      ? scopes.some((scope) => scope === "search" || scope === "ingest")
      : scopes.includes("search"))),
  };
}

function routeBaseUrl(_url: string): string {
  return mcpOrigin(_url);
}

// The protocol and compatibility REST adapters share authorization and handlers.
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
    const toolId = c.req.param("id");
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
      if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("Expected object");
    } catch {
      return c.json({ error: "Expected a JSON object" }, 400);
    }

    if (toolId === "ai.operation.get") {
      if (apiKey && !apiKeyHasAnyScope(apiKey, ["search", "ingest"])) return c.json({ error: "Forbidden" }, 403);
      const parsed = operationInputSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: { issues: parsed.error.issues } }, 400);
      const operation = await getAutomationOperation({ ...parsed.data, userId: actor.userId, apiKey });
      return operation ? c.json({ operation }) : c.json({ error: "Operation not found" }, 404);
    }

    if (toolId === "ai.simple") {
      const parsed = aiSimpleToolSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: { issues: parsed.error.issues } }, 400);
      const request = { ...parsed.data, userId: actor.userId, workspaceId: await resolveActorWorkspaceId(actor, parsed.data.workspaceId) };
      if (request.sourceUrls.length && apiKey && !apiKeyHasAnyScope(apiKey, ["ingest"])) return c.json({ error: "Source ingestion requires ingest scope" }, 403);
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
      if (!parsed.success) return c.json({ error: { issues: parsed.error.issues } }, 400);
      const request = { ...parsed.data, userId: actor.userId, workspaceId: await resolveActorWorkspaceId(actor, parsed.data.workspaceId) };
      if (request.sourceUrls.length && apiKey && !apiKeyHasAnyScope(apiKey, ["ingest"])) return c.json({ error: "Source ingestion requires ingest scope" }, 403);
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

    if (["workspace.search", "workspace.search-many", "workspace.chat"].includes(toolId)) {
      if (apiKey && !apiKeyHasAnyScope(apiKey, ["search"])) return c.json({ error: "Forbidden" }, 403);
      const actor = c.get("requestActor");
      const native = new Hono().use("*", publicErrorMiddleware).use("*", async (inner, next) => {
        setRequestActor(inner, actor);
        await next();
      }).route("/", searchRoutes);
      native.onError(spendAwareErrorHandler);
      const path = toolId === "workspace.chat" ? "/chat" : toolId === "workspace.search-many" ? "/batch" : "/";
      return native.request(`http://mcp.internal${path}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: c.req.raw.signal,
      });
    }

    if (toolId === "workspace.aggregate-rag-search") {
      if (apiKey && !apiKeyHasAnyScope(apiKey, ["search"])) return c.json({ error: "Forbidden" }, 403);
      const parsed = aggregateWorkspaceRagSearchRequestSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ error: { issues: parsed.error.issues } }, 400);
      }
      const response = await aggregateWorkspaceRagSearch({
        userId: actor.userId,
        apiKey,
        request: parsed.data,
      });
      return c.json({ tool: toolId, ...response });
    }

    if (toolId === "workspace.ingest-report") {
      if (apiKey && !apiKeyHasAnyScope(apiKey, ["search"])) return c.json({ error: "Forbidden" }, 403);
      const parsed = workspaceIngestReportSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: { issues: parsed.error.issues } }, 400);
      const workspace = await loadActorScopedWorkspace(
        await resolveActorWorkspaceId(c.get("requestActor"), parsed.data.workspaceId),
        actor,
      );
      if (!workspace) return c.json({ error: "Workspace not found" }, 404);
      const report = await loadIngestReport({
        workspace, canEdit: false, runId: parsed.data.runId ?? null, documentIds: parsed.data.documentIds ?? null,
      });
      return c.json({ tool: toolId, summary: summarizeIngestReport(report), report });
    }

    if (toolId === "workspace.suggest") {
      if (apiKey && !apiKeyHasAnyScope(apiKey, ["search"])) return c.json({ error: "Forbidden" }, 403);
      const parsed = workspaceSuggestSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: { issues: parsed.error.issues } }, 400);
      const suggestBody = parsed.data;
      const workspace = await loadActorScopedWorkspace(
        await resolveActorWorkspaceId(c.get("requestActor"), suggestBody.workspaceId),
        actor,
      );
      if (!workspace) return c.json({ error: "Workspace not found" }, 404);
      const like = (suggestBody.q ?? "").trim() ? `${(suggestBody.q ?? "").trim()}%` : "%";
      const limit = Math.min(25, Math.max(1, suggestBody.limit ?? 8));
      const suggestions = await sql<{ phrase: string }[]>`
        select phrase
        from (
          select phrase, weight, created_at from query_suggestions where workspace_id = ${workspace.id}
            and user_id = ${actor.userId} and phrase ilike ${like}
          union all
          select s.query as phrase, 10 as weight, s.created_at from search_sessions s
            where s.user_id = ${actor.userId} and (s.metadata ->> 'workspaceId') = ${workspace.id} and s.query ilike ${like}
        ) x
        group by phrase
        order by max(weight) desc, max(created_at) desc
        limit ${limit}
      `;
      return c.json({ tool: toolId, suggestions: suggestions.map((r) => r.phrase) });
    }

    return c.json({ error: "Unknown MCP tool" }, 404);
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
        return c.json({ error: "Missing operationId" }, 400);
      }
      const operation = await getAutomationOperation({
        operationId,
        userId: actor.userId,
        apiKey
      });
      if (!operation) {
        return c.json({ error: "Operation not found" }, 404);
      }
      return c.json({ operation });
    }

    return c.json({ error: "Unknown MCP resource" }, 404);
  })
  .get("/prompts/:id", async (c) => {
    if (c.req.param("id") !== "workspace-grounded-answer") {
      return c.json({ error: "Unknown MCP prompt" }, 404);
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

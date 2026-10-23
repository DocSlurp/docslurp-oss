import { publicErrorMiddleware } from "../lib/public-errors.js";
import { apiErrorResponse, apiStatusError, usesNativeErrorEnvelope } from "../lib/api-error.js";
import { mapValidationIssues, type ValidationErrorSource } from "../lib/validation.js";
import { Hono, type Context } from "hono";

import type { ApiErrorCode } from "@docslurp/shared";

import { apiKeyHasAnyScope } from "../lib/api-key-authorization.js";
import { getApiKey, getRequestActor, loadActorScopedWorkspace, resolveActorWorkspaceId, setRequestActor, type RequestActor } from "../lib/request-actor.js";
import { listWorkspaces } from "./workspaces.js";
import { apiKeyCanUseWorkspace } from "../lib/api-key-workspace-scope.js";
import { completeUploadInput, mediaEvidenceInput, fullIndexInput, listWorkspacesInput, mcpManifest, mcpTools, openUploaderInput, suggestQueriesInput, uploadInput, uploadStatusInput } from "./mcp-catalog.js";
import { UPLOAD_UI_URI } from "../lib/mcp-ui-resources.js";
import { mcpOrigin } from "../lib/mcp-origin.js";
import { groundedWorkspaceChatRoutes, searchRoutes } from "../routes/search.js";
import { sql } from "../db.js";
import { isProtectedStoredQuery } from "../search/session.js";
import { deferredProfilesEnabled } from "@docslurp/shared";
import { getRun } from "./runs.js";
import { runLifecycle } from "./run-lifecycle.js";
import { resolveMaterializationPolicy } from "./materialization-policy.js";
import { IndexingModeError, requestFullIndex } from "./workspace-indexing-mode.js";
import { indexingModeErrorResponse } from "../lib/indexing-mode-error.js";
import {
  apiKeyMayUseEstimateTool, estimateToolUsesWorkspace, forwardInProcess, isEstimateToolName, jobsGetInputSchema, planEstimateTool,
} from "./mcp-estimate-tools.js";
import { spendAwareErrorHandler } from "./billing/spend-guard.js";
import { loadIngestReport, summarizeIngestReport } from "./ingest-report.js";

export { mcpManifest };

function routeBaseUrl(_url: string): string {
  return mcpOrigin(_url);
}

/** WebMCP (the cookie-authenticated native-envelope surface) never offers the uploader: it renders in MCP Apps hosts only. */
function withoutUploader<T extends { capabilities: { id: string }[] }>(c: Context, manifest: T): T {
  return usesNativeErrorEnvelope(c.req.path) ? { ...manifest, capabilities: manifest.capabilities.filter(item => item.id !== "openUploader") } : manifest;
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
    return c.json(withoutUploader(c, mcpManifest(routeBaseUrl(c.req.url), getApiKey(c)?.scopes, getApiKey(c)?.keyType)));
  })
  .get("/tools", async (c) => {
    const manifest = withoutUploader(c, mcpManifest(routeBaseUrl(c.req.url), getApiKey(c)?.scopes, getApiKey(c)?.keyType));
    return c.json({ tools: manifest.capabilities.filter((capability) => capability.category === "tool") });
  })
  .post("/tools/:id", async (c) => {
    const actor = getRequestActor(c);
    const apiKey = getApiKey(c);
    const toolId = c.req.param("id");
    const tool = mcpTools(routeBaseUrl(c.req.url)).find(item => item.id === toolId);
    if (!tool || (toolId === "openUploader" && usesNativeErrorEnvelope(c.req.path))) return adapterError(c, 404, "Unknown MCP tool");
    if (apiKey && !(tool.keyAccess ? tool.keyAccess(apiKey) : apiKeyHasAnyScope(apiKey, tool.scopes))) return adapterError(c, 403, "Forbidden");
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
      if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("Expected object");
    } catch {
      return adapterError(c, 400, "Expected a JSON object");
    }

    if (toolId === "listWorkspaces") {
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

    if (toolId === "openUploader") {
      const parsed = openUploaderInput.safeParse(body);
      if (!parsed.success) return invalidInput(c, parsed.error);
      // Read-only: resolves a target for the widget and never creates a workspace or returns upload URLs.
      const workspace = await loadActorScopedWorkspace(await resolveActorWorkspaceId(actor, parsed.data.workspace), actor);
      if (!workspace) return adapterError(c, 404, "Workspace not found", "workspace_not_found");
      const accessible = (await listWorkspaces(actor.userId, { refineNames: false }))
        .filter(item => !apiKey || apiKeyCanUseWorkspace(apiKey, item));
      const summary = (item: { id: string; slug: string; name: string; isDefault: boolean }) => ({ id: item.id, slug: item.slug, name: item.name, isDefault: item.isDefault });
      return c.json({
        workspace: summary(accessible.find(item => item.id === workspace.id) ?? { ...workspace, isDefault: false }),
        workspaces: accessible.slice(0, 50).map(summary),
        limits: { maxFiles: 10, maxFileBytes: 5 * 1024 ** 3 },
        uploader: { resourceUri: UPLOAD_UI_URI },
        hint: "Ask the user to drop files into the uploader. Hosts without MCP Apps: use upload with urls.",
      });
    }

    if (toolId === "upload") {
      const parsed = uploadInput.safeParse(body);
      if (!parsed.success) return invalidInput(c, parsed.error);
      const input = parsed.data;
      // Reuse upload authorization, workspace resolution (find or create; a
      // restricted key can do neither outside its allowlist), URL validation,
      // admission, spend checks and idempotency.
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
        method: "POST", headers, body: JSON.stringify({ workspace: input.workspace,
          ...(input.urls ? { urls: input.urls } : { files: input.files!.map(file => ({ ...file, singlePart: true })) }),
        }), signal: c.req.raw.signal,
      });
    }

    if (toolId === "completeUpload") {
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

    if (toolId === "search" || toolId === "chat") {
      const actor = c.get("requestActor");
      // The MCP chat tool is grounded retrieval only: it never starts another
      // agent (which would refresh the outer tool budget) or changes settings.
      const native = new Hono().use("*", publicErrorMiddleware).use("*", async (inner, next) => {
        setRequestActor(inner, actor);
        await next();
      }).route("/", toolId === "chat" ? groundedWorkspaceChatRoutes : searchRoutes);
      native.onError(spendAwareErrorHandler);
      return native.request("http://mcp.internal/", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: c.req.raw.signal,
      });
    }

    if (toolId === "getMediaEvidence") {
      const parsed = mediaEvidenceInput.safeParse(body);
      if (!parsed.success) return invalidInput(c, parsed.error);
      const workspace = await loadActorScopedWorkspace(await resolveActorWorkspaceId(actor, parsed.data.workspace), actor);
      if (!workspace) return adapterError(c, 404, "Workspace not found", "workspace_not_found");
      const { loadMediaEvidence } = await import("./media-evidence.js");
      const evidence = await loadMediaEvidence(workspace.id, parsed.data.documentId, parsed.data.offset);
      return evidence ? c.json(evidence) : adapterError(c, 404, "Indexed media not found");
    }

    if (toolId === "fullIndex") {
      const parsed = fullIndexInput.safeParse(body);
      if (!parsed.success) return invalidInput(c, parsed.error);
      const workspace = await loadActorScopedWorkspace(await resolveActorWorkspaceId(actor, parsed.data.workspace), actor);
      if (!workspace) return adapterError(c, 404, "Workspace not found", "workspace_not_found");
      const resolved = await resolveMaterializationPolicy({
        workspacePipeline: workspace.pipeline,
        apiKey,
        capabilityHeader: c.req.header("X-DocSlurp-Capability"),
        origin: c.req.header("Origin"),
        workspaceId: workspace.id,
      });
      if ("error" in resolved) return adapterError(c, 403, "Invalid capability");
      try {
        const result = await requestFullIndex({
          orgId: workspace.orgId, workspaceId: workspace.id, documentIds: parsed.data.documentIds, actor, policy: resolved.policy,
        });
        const run = await getRun(result.runId, actor.userId);
        if (run) await runLifecycle.start(run);
        return c.json({ tool: toolId, runId: result.runId, pages: result.pages, estimatedCredits: result.estimatedCredits, billing: result.billing }, 202);
      } catch (error) {
        if (error instanceof IndexingModeError) return indexingModeErrorResponse(c, error);
        throw error;
      }
    }

    if (toolId === "getUploadStatus") {
      const parsed = uploadStatusInput.safeParse(body);
      if (!parsed.success) return invalidInput(c, parsed.error);
      const workspace = await loadActorScopedWorkspace(
        await resolveActorWorkspaceId(c.get("requestActor"), parsed.data.workspace),
        actor,
      );
      if (!workspace) return adapterError(c, 404, "Workspace not found", "workspace_not_found");
      const report = await loadIngestReport({
        workspace, canEdit: false, runId: parsed.data.runId ?? null, documentIds: parsed.data.documentIds ?? null,
      });
      return c.json({ tool: toolId, summary: summarizeIngestReport(report), report });
    }

    if (toolId === "getJob") {
      const parsed = jobsGetInputSchema.safeParse(body);
      if (!parsed.success) return invalidInput(c, parsed.error);
      const response = await forwardInProcess(actor, "GET", `/v1/jobs/${encodeURIComponent(parsed.data.jobId)}`, undefined, c.req.raw.signal);
      if (!response.ok) return response;
      return c.json({ tool: toolId, job: await response.json() });
    }

    if (isEstimateToolName(toolId)) {
      // Estimates are read-only, but a key may only price work it could start (same scope and key type as the mutation).
      if (apiKey && !apiKeyMayUseEstimateTool(toolId, apiKey)) return adapterError(c, 403, "Forbidden");
      let workspaceRef = "";
      if (estimateToolUsesWorkspace(toolId, body)) {
        const requested = typeof body.workspace === "string" ? body.workspace : undefined;
        const workspace = await loadActorScopedWorkspace(await resolveActorWorkspaceId(actor, requested), actor);
        if (!workspace) return adapterError(c, 404, "Workspace not found", "workspace_not_found");
        workspaceRef = workspace.id;
      }
      const planned = planEstimateTool(toolId, body, workspaceRef);
      if (!planned.ok) return invalidInput(c, { issues: planned.issues });
      const response = await forwardInProcess(actor, "POST", planned.plan.path, planned.plan.body, c.req.raw.signal);
      if (!response.ok) return response;
      return c.json({ tool: toolId, ...(await response.json() as Record<string, unknown>) });
    }

    if (toolId === "suggestQueries") {
      const parsed = suggestQueriesInput.safeParse(body);
      if (!parsed.success) return invalidInput(c, parsed.error);
      const suggestBody = parsed.data;
      const workspace = await loadActorScopedWorkspace(
        await resolveActorWorkspaceId(c.get("requestActor"), suggestBody.workspace),
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
    if (c.req.param("id") === "capabilities") {
      return c.json(withoutUploader(c, mcpManifest(routeBaseUrl(c.req.url), getApiKey(c)?.scopes, getApiKey(c)?.keyType)));
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

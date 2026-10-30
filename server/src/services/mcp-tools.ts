import type { z } from "zod";
import { getWorkspaceSearchSettings } from "./search-controls.js";
import { workspaceSettingsPipelinePatchSchema } from "./workspace-settings-proposal-input.js";
import { workspaceSettingsProposalInputSchema } from "./workspace-settings-proposal-input.js";
import { currentChatSessionId, inChatAgentContext } from "../lib/chat-agent-context.js";
import { enforceActorCategoryRateLimit } from "../middleware/rate-limit.js";
import { acquireChatSlot } from "../middleware/chat-concurrency.js";
import { proposeWorkspaceSettings, SettingsProposalError } from "./workspace-settings-proposals.js";
import { publicErrorMiddleware } from "../lib/public-errors.js";
import { apiErrorResponse, apiStatusError, usesNativeErrorEnvelope } from "../lib/api-error.js";
import { mapValidationIssues, type ValidationErrorSource } from "../lib/validation.js";
import { Hono, type Context, type MiddlewareHandler } from "hono";

import type { ApiErrorCode } from "@docslurp/shared";

import { apiKeyHasAnyScope } from "../lib/api-key-authorization.js";
import { getApiKey, getRequestActor, isFirstPartyAppActor, loadActorScopedWorkspace, resolveActorWorkspaceId, setRequestActor, type RequestActor } from "../lib/request-actor.js";
import { listWorkspaces } from "./workspaces.js";
import { listEditableWorkspaceIds } from "./organizations.js";
import { apiKeyCanUseWorkspace } from "../lib/api-key-workspace-scope.js";
import { completeUploadInput, extractInput, INLINE_UPLOAD_MAX_BYTES, mediaEvidenceInput, fullIndexInput, listWorkspacesInput, mcpManifest, mcpTools, openUploaderInput, suggestQueriesInput, uploadInput, uploadStatusInput } from "./mcp-catalog.js";
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
import { dispatchWebTool, isWebToolId } from "./web/mcp-web-tools.js";

export { mcpManifest };

/** Standard or URL-safe base64, whitespace ignored; null when malformed. */
function decodeBase64(value: string): Buffer | null {
  const compact = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, "=");
  return /^[A-Za-z0-9+/]*={0,2}$/.test(padded) && compact.length % 4 !== 1 ? Buffer.from(padded, "base64") : null;
}

function routeBaseUrl(_url: string): string {
  return mcpOrigin(_url);
}

declare module "hono" {
  interface ContextVariableMap {
    /** Set by the cookie-authenticated WebMCP mount; absent on the bearer `/v1/mcp` surface. */
    mcpSurface?: "session-tools";
  }
}

/** Mount-time marker: WebMCP (`/v1/session-tools`) never offers the uploader, which renders in MCP Apps hosts only. */
export const markSessionToolsSurface: MiddlewareHandler = async (c, next) => {
  c.set("mcpSurface", "session-tools");
  await next();
};

const uploaderHidden = (c: Context) => c.get("mcpSurface") === "session-tools";

function withoutUploader<T extends { capabilities: { id: string }[] }>(c: Context, manifest: T): T {
  return uploaderHidden(c) ? { ...manifest, capabilities: manifest.capabilities.filter(item => item.id !== "openUploader") } : manifest;
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
    return c.json(withoutUploader(c, mcpManifest(routeBaseUrl(c.req.url), getApiKey(c)?.scopes, getApiKey(c)?.keyType, { ...getApiKey(c)?.oauth, firstPartyApp: isFirstPartyAppActor(c.get("requestActor")) })));
  })
  .get("/tools", async (c) => {
    const manifest = withoutUploader(c, mcpManifest(routeBaseUrl(c.req.url), getApiKey(c)?.scopes, getApiKey(c)?.keyType, { ...getApiKey(c)?.oauth, firstPartyApp: isFirstPartyAppActor(c.get("requestActor")) }));
    return c.json({ tools: manifest.capabilities.filter((capability) => capability.category === "tool") });
  })
  .post("/tools/:id", async (c) => {
    const actor = getRequestActor(c);
    const apiKey = getApiKey(c);
    const toolId = c.req.param("id");
    const tool = mcpTools(routeBaseUrl(c.req.url)).find(item => item.id === toolId);
    if (!tool || (toolId === "openUploader" && uploaderHidden(c))) return adapterError(c, 404, "Unknown MCP tool");
    // App-only settings tools answer like unknown tools to every other caller.
    if (tool.firstPartyAppOnly && (apiKey || !isFirstPartyAppActor(actor))) return adapterError(c, 404, "Unknown MCP tool");
    if (apiKey && !(tool.keyAccess ? tool.keyAccess(apiKey) : apiKeyHasAnyScope(apiKey, tool.scopes))) return adapterError(c, 403, "Forbidden");
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
      if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("Expected object");
    } catch {
      return adapterError(c, 400, "Expected a JSON object");
    }

    if (toolId === "getWorkspaceSettings") {
      if (Object.keys(body).some(key => key !== "workspace") || (body.workspace !== undefined && typeof body.workspace !== "string")) return adapterError(c, 400, "Invalid settings request");
      const workspace = await loadActorScopedWorkspace(await resolveActorWorkspaceId(actor, typeof body.workspace === "string" ? body.workspace : undefined), actor);
      if (!workspace) return adapterError(c, 404, "Workspace not found", "workspace_not_found");
      const settings = await getWorkspaceSearchSettings(workspace.id, actor.userId);
      return c.json({ workspaceId: workspace.id,
        pipeline: Object.fromEntries(Object.keys(workspaceSettingsPipelinePatchSchema.shape).map(key => [key, key === "mediaVideo" ? { enabled: workspace.pipeline.mediaVideo?.enabled !== false }
          : key === "vision" ? { forceAllPages: workspace.pipeline.vision.forceAllPages }
          : workspace.pipeline[key as keyof typeof workspace.pipeline]])),
        chat: settings.chat, retrieval: settings.retrievalDefaults });
    }

    if (toolId === "proposeWorkspaceSettings") {
      const parsed = workspaceSettingsProposalInputSchema.safeParse(body);
      if (!parsed.success) return invalidInput(c, parsed.error);
      const sessionId = currentChatSessionId();
      if (!sessionId) return adapterError(c, 403, "Settings proposals require a workspace chat session");
      const workspace = await loadActorScopedWorkspace(await resolveActorWorkspaceId(actor, parsed.data.workspace), actor);
      if (!workspace) return adapterError(c, 404, "Workspace not found", "workspace_not_found");
      try {
        const settingsProposal = await proposeWorkspaceSettings({ actor, workspaceId: workspace.id, sessionId, changes: parsed.data.changes });
        return c.json({ settingsProposal });
      } catch (error) {
        if (error instanceof SettingsProposalError) return adapterError(c, error.status, error.message);
        throw error;
      }
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
      // Same rule as the upload route's run creation (canContributeToWorkspace): editors and admins of a
      // workspace, plus any org member for the default workspace. Read-only shares are not offered.
      const editable = new Set(await listEditableWorkspaceIds(actor.userId));
      if (!editable.has(workspace.id)) return adapterError(c, 403, "You do not have permission to upload to this workspace", "forbidden");
      const accessible = (await listWorkspaces(actor.userId, { refineNames: false }))
        .filter(item => editable.has(item.id) && (!apiKey || apiKeyCanUseWorkspace(apiKey, item)));
      const summary = (item: { id: string; slug: string; name: string; isDefault: boolean }) => ({ id: item.id, slug: item.slug, name: item.name, isDefault: item.isDefault });
      return c.json({
        workspace: summary(accessible.find(item => item.id === workspace.id) ?? { ...workspace, isDefault: false }),
        workspaces: accessible.slice(0, 50).map(summary),
        limits: { maxFiles: 10, maxFileBytes: 5 * 1024 ** 3 },
        uploader: { resourceUri: UPLOAD_UI_URI },
        hint: "Ask the user to drop files into the uploader. Hosts without MCP Apps: use upload with urls.",
      });
    }

    if (toolId === "upload" || toolId === "extract") {
      const parsed = (toolId === "extract" ? extractInput : uploadInput).safeParse(body);
      if (!parsed.success) return invalidInput(c, parsed.error);
      const input = parsed.data as z.infer<typeof extractInput>;
      // Reuse upload (or extract) authorization, workspace resolution (find or create; a
      // restricted key can do neither outside its allowlist), URL validation,
      // admission, spend checks and idempotency.
      const routes = toolId === "extract"
        ? (await import("../routes/extracts.js")).extractsRoutes
        : (await import("../routes/uploads.js")).uploadsRoutes;
      const native = new Hono().use("*", publicErrorMiddleware).use("*", async (inner, next) => {
        setRequestActor(inner, actor);
        await next();
      }).route("/", routes);
      native.onError(spendAwareErrorHandler);
      const headers = new Headers();
      if (input.idempotencyKey) headers.set("Idempotency-Key", input.idempotencyKey);
      const extractFields = toolId === "extract"
        ? { ...(input.retentionDays !== undefined ? { retentionDays: input.retentionDays } : {}), ...(input.notifyEmail !== undefined ? { notifyEmail: input.notifyEmail } : {}), ...(input.download ? { download: input.download } : {}) }
        : {};
      if (input.inlineFiles) {
        // Clients without network egress cannot PUT to storage, so the bytes
        // arrive in the tool call and go through the multipart bulk intake.
        const decoded = input.inlineFiles.map(file => ({ ...file, bytes: file.text === undefined ? decodeBase64(file.contentBase64!) : Buffer.from(file.text, "utf8") }));
        const invalid = decoded.find(file => !file.bytes?.length);
        if (invalid) return adapterError(c, 400, `contentBase64 for ${invalid.filename} is not valid base64`);
        if (decoded.reduce((total, file) => total + file.bytes!.length, 0) > INLINE_UPLOAD_MAX_BYTES) {
          return adapterError(c, 413, `Inline files exceed ${INLINE_UPLOAD_MAX_BYTES / 1024} KiB in total; use files for direct storage upload or urls`);
        }
        const form = new FormData();
        if (input.workspace) form.set("workspace", input.workspace);
        for (const [name, value] of Object.entries(extractFields)) form.set(name, String(value));
        for (const file of decoded) form.append("files", new File([new Uint8Array(file.bytes!)], file.filename, { type: file.mimeType ?? "" }));
        return native.request("http://mcp.internal/bulk", { method: "POST", headers, body: form, signal: c.req.raw.signal });
      }
      headers.set("Content-Type", "application/json");
      return native.request(`http://mcp.internal/${input.urls ? "url" : "direct/sessions"}`, {
        method: "POST", headers, body: JSON.stringify({ workspace: input.workspace,
          ...(input.urls ? { urls: input.urls } : { files: input.files }),
          ...extractFields,
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
      // A direct MCP chat call runs a model turn: it counts as chat-ai and takes
      // a chat slot. A nested call from the chat agent is already inside its turn.
      let slot: { release: () => void } | null | "uncapped" = "uncapped";
      if (toolId === "chat" && !inChatAgentContext()) {
        const limited = await enforceActorCategoryRateLimit(c, "chat-ai");
        if (limited) return limited;
        slot = acquireChatSlot(c);
        if (!slot) {
          c.header("Retry-After", "5");
          return adapterError(c, 429, "Too many chat requests in progress for this key; wait for one to finish", "rate_limited");
        }
      }
      // The MCP chat tool is grounded retrieval only: it never starts another
      // agent (which would refresh the outer tool budget) or changes settings.
      const native = new Hono().use("*", publicErrorMiddleware).use("*", async (inner, next) => {
        setRequestActor(inner, actor);
        await next();
      }).route("/", toolId === "chat" ? groundedWorkspaceChatRoutes : searchRoutes);
      native.onError(spendAwareErrorHandler);
      try {
        const response = await native.request("http://mcp.internal/", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body), signal: c.req.raw.signal,
        });
        // Hold the slot until the answer body is read (the grounded route answers in one JSON body).
        return slot && slot !== "uncapped" ? new Response(await response.arrayBuffer(), response) : response;
      } finally {
        if (slot && slot !== "uncapped") slot.release();
      }
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
      if (parsed.data.sessionId) {
        const { loadDirectUploadSession, describeDirectUploadSession } = await import("./direct-upload-session.js");
        const loaded = await loadDirectUploadSession(parsed.data.sessionId, actor.userId);
        if (!loaded || (apiKey && (loaded.session.org_id !== apiKey.orgId ||
          (loaded.session.workspace_id ? !await loadActorScopedWorkspace(loaded.session.workspace_id, actor) : Boolean(apiKey.workspaceIds?.length))))) {
          return adapterError(c, 404, "Upload session not found");
        }
        return c.json({ tool: toolId, ...await describeDirectUploadSession(loaded, true) });
      }
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

    if (isWebToolId(toolId)) return dispatchWebTool(c, toolId, body, actor);

    return adapterError(c, 404, "Unknown MCP tool");
  })
  .get("/resources/:id", async (c) => {
    if (c.req.param("id") === "capabilities") {
      return c.json(withoutUploader(c, mcpManifest(routeBaseUrl(c.req.url), getApiKey(c)?.scopes, getApiKey(c)?.keyType, { ...getApiKey(c)?.oauth, firstPartyApp: isFirstPartyAppActor(c.get("requestActor")) })));
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

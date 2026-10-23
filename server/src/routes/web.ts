import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";

import { apiStatusError, nativeApiErrors } from "../lib/api-error.js";
import { requestIp, requestUserAgent } from "../lib/request-context.js";
import { actorHasAnyApiKeyScope, getRequestActor, loadActorScopedWorkspace, resolveActorWorkspaceId, setRequestActor, type RequestActor } from "../lib/request-actor.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { spendAwareErrorHandler } from "../services/billing/spend-guard.js";
import { validationHook } from "../lib/validation.js";
import { createWebsiteWorkspaceIntake } from "../services/workspace-intake-actions.js";
import { runCreationErrorResponse, workspaceIntakeErrorResponse } from "./uploads.js";
import { ingestWebsiteInput, webCrawlInput, webFetchInput, webMapInput, webSearchInput, type WebCrawlRequest } from "../services/web/schemas.js";
import { runWebCapability, type WebSurface } from "../services/web/service.js";
import { WebToolError, type WebCapability, type WebInput } from "../services/web/types.js";

/** Caller-facing error for a web call. Provider failures are already generic WebToolErrors. */
export function webErrorResponse(c: Context, error: unknown): Response | null {
  if (!(error instanceof WebToolError)) return null;
  if (error.retryAfterSeconds) c.header("Retry-After", String(error.retryAfterSeconds));
  return apiStatusError(c, error.status, error.message, {
    code: error.code, ...(error.retryAfterSeconds ? { details: { retryAfterSeconds: error.retryAfterSeconds } } : {}),
  });
}

/** The workspace whose privacy mode and billing apply to a web call (default when omitted). */
export async function webCallWorkspace(actor: RequestActor, workspace: string | undefined, orgId?: string | null) {
  const resolved = await loadActorScopedWorkspace(await resolveActorWorkspaceId(actor, workspace, orgId), actor);
  if (!resolved) throw new WebToolError(404, "invalid_request", "Workspace not found");
  return resolved;
}

export function crawlInput(body: WebCrawlRequest): WebInput<"crawl"> {
  return { url: body.url, limit: body.limit, maxDepth: body.maxDepth, includePaths: body.includePaths, excludePaths: body.excludePaths, maxCharacters: body.maxCharacters };
}

/** Strip routing-only fields (workspace, timeout) so the cache key and providers see the capability input alone. */
function capabilityInput<C extends WebCapability>(capability: C, body: Record<string, unknown>): WebInput<C> {
  const { workspace: _workspace, timeoutSeconds: _timeout, ...input } = body;
  return (capability === "crawl" ? crawlInput(body as WebCrawlRequest) : input) as WebInput<C>;
}

async function handle<C extends WebCapability>(c: Context, capability: C, body: Record<string, unknown>, surface: WebSurface): Promise<Response> {
  const actor = getRequestActor(c);
  try {
    const workspace = await webCallWorkspace(actor, body.workspace as string | undefined);
    const result = await runWebCapability(capability, capabilityInput(capability, body), {
      userId: actor.userId, orgId: workspace.orgId, workspaceId: workspace.id, surface, signal: c.req.raw.signal,
    }, capability === "crawl" ? { deadlineMs: (body.timeoutSeconds as number) * 1000 } : {});
    return c.json(result);
  } catch (error) {
    const response = webErrorResponse(c, error);
    if (response) return response;
    throw error;
  }
}

/**
 * Web Capabilities over REST: search the public web, read pages as Markdown,
 * map a site's URLs, crawl a site, and ingest a crawled site into a workspace.
 * API keys need `search` (ingest needs `ingest`). Each call is charged credits.
 */
function createWebRoutes(surface: WebSurface) {
  return new Hono()
  .use("*", nativeApiErrors)
  .use("*", async (c, next) => {
    const actor = getRequestActor(c);
    const ingest = c.req.path.endsWith("/ingest");
    if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, [ingest ? "ingest" : "search"])) return apiStatusError(c, 403, "Forbidden");
    await next();
  })
  .post("/search", zValidator("json", webSearchInput, validationHook), (c) => handle(c, "search", c.req.valid("json"), surface))
  .post("/fetch", zValidator("json", webFetchInput, validationHook), (c) => handle(c, "fetch", c.req.valid("json"), surface))
  .post("/map", zValidator("json", webMapInput, validationHook), (c) => handle(c, "map", c.req.valid("json"), surface))
  .post("/crawl", zValidator("json", webCrawlInput, validationHook), (c) => handle(c, "crawl", c.req.valid("json"), surface))
  .post("/ingest", zValidator("json", ingestWebsiteInput, validationHook), async (c) => {
    const actor = getRequestActor(c);
    const body = c.req.valid("json");
    const restricted = actor.type === "apiKey" && Boolean(actor.apiKey.workspaceIds?.length);
    // A workspace-restricted key never creates a workspace (intake also refuses names outside its allowlist).
    if (restricted && !body.workspace?.trim() && body.newWorkspace) {
      return apiStatusError(c, 403, "Workspace-scoped API keys cannot create new workspaces", { code: "workspace_scope_forbidden" });
    }
    try {
      // The crawl is billed to the target workspace, or the default one when this request creates a workspace.
      const scope = await webCallWorkspace(actor, body.workspace).catch(() => webCallWorkspace(actor, undefined));
      const result = await createWebsiteWorkspaceIntake({
        userId: actor.userId,
        orgId: scope.orgId,
        workspace: body.workspace?.trim() || null,
        newWorkspace: body.newWorkspace,
        allowedWorkspaceIds: restricted && actor.type === "apiKey" ? actor.apiKey.workspaceIds! : null,
        tags: body.tags,
        startUrl: body.url,
        crawlOptions: { limit: body.limit, maxDepth: body.maxDepth, includePaths: body.includePaths ?? null, excludePaths: body.excludePaths ?? null },
        crawl: async () => {
          const crawled = await runWebCapability("crawl", crawlInput({ ...body, maxCharacters: 100_000, workspace: undefined }), {
            userId: actor.userId, orgId: scope.orgId, workspaceId: scope.id, surface: surface === "api" ? "ingest" : surface, signal: c.req.raw.signal,
          }, { deadlineMs: body.timeoutSeconds * 1000 });
          return { pages: crawled.pages, credits: crawled.usage.credits };
        },
        idempotencyKey: c.req.header("Idempotency-Key")?.trim(),
        audit: { ipAddress: requestIp(c), userAgent: requestUserAgent(c) },
      });
      if (result.idempotencyReplayed) c.header("Idempotency-Replayed", "true");
      if (result.temporalDeferred) c.header("X-Temporal-Deferred", "true");
      return c.json(result.payload, result.status);
    } catch (error) {
      const response = webErrorResponse(c, error);
      if (response) return response;
      const intake = workspaceIntakeErrorResponse(c, error) ?? runCreationErrorResponse(c, error);
      if (intake) return intake;
      throw error;
    }
  });
}

export const webRoutes = acceptApiKeys(createWebRoutes("api"));

/** In-process web routes for a trusted dispatcher (MCP tools, chat agent): the actor is set, never read from headers. */
export function webRoutesFor(actor: RequestActor, surface: "mcp" | "chat") {
  const routes = new Hono().use("*", async (c, next) => {
    setRequestActor(c, actor);
    await next();
  }).route("/", createWebRoutes(surface));
  routes.onError(spendAwareErrorHandler);
  return routes;
}

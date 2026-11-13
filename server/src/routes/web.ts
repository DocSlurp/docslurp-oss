import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";

import { apiStatusError, nativeApiErrors } from "../lib/api-error.js";
import { requestIp, requestUserAgent } from "../lib/request-context.js";
import { actorHasAnyApiKeyScope, getRequestActor, loadActorScopedProject, lookupActorProject, resolveActorProjectId, setRequestActor, type RequestActor } from "../lib/request-actor.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { apiKeyCanUseWebTools } from "../lib/web-tool-access.js";
import { assertCanSpend, spendAwareErrorHandler } from "../services/billing/spend-guard.js";
import { ProjectIntakeError } from "../services/project-intake.js";
import { validationHook } from "../lib/validation.js";
import { createWebsiteProjectIntake } from "../services/project-intake-actions.js";
import { runCreationErrorResponse, projectIntakeErrorResponse } from "./uploads.js";
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

/** The project whose privacy mode and billing apply to a web call (default when omitted). */
export async function webCallProject(actor: RequestActor, project: string | undefined, orgId?: string | null) {
  const resolved = await loadActorScopedProject(await resolveActorProjectId(actor, project, orgId), actor);
  if (!resolved) throw new WebToolError(404, "invalid_request", "Project not found");
  return resolved;
}

export function crawlInput(body: WebCrawlRequest): WebInput<"crawl"> {
  return { url: body.url, limit: body.limit, maxDepth: body.maxDepth, includePaths: body.includePaths, excludePaths: body.excludePaths, maxCharacters: body.maxCharacters };
}

/** Strip routing-only fields (project, timeout) so the cache key and providers see the capability input alone. */
function capabilityInput<C extends WebCapability>(capability: C, body: Record<string, unknown>): WebInput<C> {
  const { project: _project, timeoutSeconds: _timeout, ...input } = body;
  return (capability === "crawl" ? crawlInput(body as WebCrawlRequest) : input) as WebInput<C>;
}

async function handle<C extends WebCapability>(c: Context, capability: C, body: Record<string, unknown>, surface: WebSurface): Promise<Response> {
  const actor = getRequestActor(c);
  try {
    const project = await webCallProject(actor, body.project as string | undefined);
    const result = await runWebCapability(capability, capabilityInput(capability, body), {
      userId: actor.userId, orgId: project.orgId, projectId: project.id, surface, signal: c.req.raw.signal,
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
 * map a site's URLs, crawl a site, and ingest a crawled site into a project.
 * API keys need `search` (ingest needs `ingest`); public client keys also need
 * the opt-in `web` scope. Each call is charged credits.
 */
function createWebRoutes(surface: WebSurface) {
  return new Hono()
  .use("*", nativeApiErrors)
  .use("*", async (c, next) => {
    const actor = getRequestActor(c);
    const ingest = c.req.path.endsWith("/ingest");
    if (actor.type === "apiKey" && !apiKeyCanUseWebTools(actor.apiKey, ingest)) {
      return actor.apiKey.keyType === "client" && actorHasAnyApiKeyScope(actor, [ingest ? "ingest" : "search:deep"])
        ? apiStatusError(c, 403, "Client API keys need the web scope to use web tools", { code: "web_scope_required" })
        : apiStatusError(c, 403, "Forbidden");
    }
    await next();
  })
  .post("/search", zValidator("json", webSearchInput, validationHook), (c) => handle(c, "search", c.req.valid("json"), surface))
  .post("/fetch", zValidator("json", webFetchInput, validationHook), (c) => handle(c, "fetch", c.req.valid("json"), surface))
  .post("/map", zValidator("json", webMapInput, validationHook), (c) => handle(c, "map", c.req.valid("json"), surface))
  .post("/crawl", zValidator("json", webCrawlInput, validationHook), (c) => handle(c, "crawl", c.req.valid("json"), surface))
  .post("/ingest", zValidator("json", ingestWebsiteInput, validationHook), async (c) => {
    const actor = getRequestActor(c);
    const body = c.req.valid("json");
    const restricted = actor.type === "apiKey" && Boolean(actor.apiKey.projectIds?.length);
    // A project-restricted key never creates a project (intake also refuses names outside its allowlist).
    if (restricted && !body.project?.trim() && body.newProject) {
      return apiStatusError(c, 403, "Project-scoped API keys cannot create new projects", { code: "project_scope_forbidden" });
    }
    try {
      // Preflight before any paid crawl: the target must exist and be usable, or be a
      // new name the actor may create; spend must allow the ingest run that follows.
      const lookup = await lookupActorProject(actor, body.project?.trim() || null);
      let scopeRef: string | undefined;
      if (lookup.ref.kind !== "default") {
        const found = "project" in lookup ? lookup.project : null;
        if (found) scopeRef = found.id;
        else if (lookup.ref.kind === "id") throw new ProjectIntakeError("Project not found", 404);
        else if (restricted) throw new ProjectIntakeError("This API key is limited to specific projects and cannot create new ones.", 403);
        // A new project name: the crawl is billed in the default project's scope.
      }
      const scope = await webCallProject(actor, scopeRef);
      await assertCanSpend(scope.orgId, scope.id, { kind: "job" });
      const result = await createWebsiteProjectIntake({
        userId: actor.userId,
        orgId: scope.orgId,
        // Intake's default branch is the org default; a restricted key's default is its own (preflighted) project.
        project: body.project?.trim() || (restricted ? scope.id : null),
        newProject: body.newProject,
        allowedProjectIds: restricted && actor.type === "apiKey" ? actor.apiKey.projectIds! : null,
        tags: body.tags,
        startUrl: body.url,
        crawlOptions: { limit: body.limit, maxDepth: body.maxDepth, includePaths: body.includePaths ?? null, excludePaths: body.excludePaths ?? null },
        crawl: async () => {
          const crawled = await runWebCapability("crawl", crawlInput({ ...body, maxCharacters: 100_000, project: undefined }), {
            userId: actor.userId, orgId: scope.orgId, projectId: scope.id, surface: surface === "api" ? "ingest" : surface, signal: c.req.raw.signal,
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
      const intake = projectIntakeErrorResponse(c, error) ?? runCreationErrorResponse(c, error);
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

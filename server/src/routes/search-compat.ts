import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { adapterQuery, runSearchAdapter, SearchCompatibilityError, type SearchProvider } from "@docslurp/sdk/search-adapters";
import { apiKeyAuth } from "../middleware/api-key-auth.js";
import { apiKeyHasAnyScope, loadApiKeyScopedWorkspace } from "../lib/api-key-authorization.js";
import { hybridSearch } from "../services/search.js";
import { publicSearchResponse } from "../lib/search-usage.js";
import { searchOptions } from "../lib/search-input.js";
import { resolveActorWorkspaceId } from "../lib/request-actor.js";
import { WorkspaceAccessError } from "../services/default-workspace.js";

async function execute(c: Context, provider: SearchProvider, requestedWorkspaceId: string, params: unknown) {
  adapterQuery(provider, requestedWorkspaceId, params);
  const key = c.get("apiKey");
  if (!apiKeyHasAnyScope(key, ["search"])) return Response.json({ error: "search scope required" }, { status: 403 });
  // Index/collection "default" maps to the key's organization default workspace.
  const workspaceId = await resolveActorWorkspaceId({ type: "apiKey", userId: key.userId, apiKey: key }, requestedWorkspaceId).catch((error: unknown) => {
    if (error instanceof WorkspaceAccessError) return null;
    throw error;
  });
  const workspace = workspaceId ? await loadApiKeyScopedWorkspace(workspaceId, key) : null;
  if (!workspace || !workspaceId) return Response.json({ error: "Workspace not found" }, { status: 404 });
  return await runSearchAdapter(provider, workspaceId, params, async input => publicSearchResponse(await hybridSearch(input.q, key.userId, searchOptions({ ...input, workspaceId, hyde: false, rerank: false, mmr: false, parentRetrieval: false, summarySeed: false, compression: false, queryRewrite: false, queryDecompose: false, stepback: false, selfQuery: false, iterativeMultiHop: false, graphExpansion: false, communityExpansion: false }))));
}
export const searchCompatRoutes = new Hono()
  .onError((error, c) => {
    if (error instanceof SearchCompatibilityError || error instanceof SyntaxError) return c.json({ code: "UNSUPPORTED_SEARCH_OPTION", error: error.message }, 400);
    console.error("[search-compat] retrieval failed", error);
    return c.json({ error: "Search failed" }, 500);
  })
  .use("*", bodyLimit({ maxSize: 64 * 1024 }))
  .use("*", async (c, next) => {
    // A supplied bearer token takes precedence over the native Typesense header.
    const key = c.req.header("X-TYPESENSE-API-KEY");
    if (!c.req.header("Authorization") && key && c.req.path.startsWith("/compat/typesense/")) c.req.raw.headers.set("Authorization", `Bearer ${key}`);
    c.header("Cache-Control", "private, no-store");
    try { await next(); } catch (error) {
      if (error instanceof SearchCompatibilityError || error instanceof SyntaxError) return c.json({ code: "UNSUPPORTED_SEARCH_OPTION", error: error.message }, 400);
      throw error;
    }
  })
  .use("*", apiKeyAuth)
  .on(["GET", "POST"], "/meilisearch/indexes/:workspaceId/search", async c => {
    const params = c.req.method === "GET" ? c.req.query() : await c.req.json();
    const response = await execute(c, "meilisearch", c.req.param("workspaceId"), params);
    return response instanceof Response ? response : c.json(response);
  })
  .on(["GET", "POST"], "/typesense/collections/:workspaceId/documents/search", async c => {
    const params = c.req.method === "GET" ? c.req.query() : await c.req.json();
    const response = await execute(c, "typesense", c.req.param("workspaceId"), params);
    return response instanceof Response ? response : c.json(response);
  })
  .post("/typesense/multi_search", async c => {
    const body = await c.req.json();
    if (!body || Object.keys(body).some(key => key !== "searches") || !Array.isArray(body.searches) || body.searches.length < 1 || body.searches.length > 10) return c.json({ error: "Expected 1–10 searches; union searches are unsupported" }, 400);
    const searches = body.searches.map((entry: Record<string, unknown>) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new SearchCompatibilityError("Each search must be an object");
      const { collection, ...params } = entry;
      if (typeof collection !== "string") throw new SearchCompatibilityError("collection is required");
      const merged = { ...c.req.query(), ...params }; adapterQuery("typesense", collection, merged);
      return { collection, params: merged };
    });
    // Authorize every collection before any retrieval/AI usage is incurred.
    const key = c.get("apiKey");
    if (!apiKeyHasAnyScope(key, ["search"])) return c.json({ error: "search scope required" }, 403);
    for (const entry of searches) if (!await loadApiKeyScopedWorkspace(entry.collection, key)) return c.json({ error: "Workspace not found" }, 404);
    const results = [];
    for (const entry of searches) {
      const result = await execute(c, "typesense", entry.collection, entry.params);
      if (result instanceof Response) return result;
      results.push(result);
    }
    return c.json({ results });
  })
  .post("/pagefind/:workspaceId/search", async c => {
    const response = await execute(c, "pagefind", c.req.param("workspaceId"), await c.req.json());
    return response instanceof Response ? response : c.json(response);
  });

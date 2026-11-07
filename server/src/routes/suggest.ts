import { readProjectSuggestions } from "../services/project-suggestions.js";
import { Hono } from "hono";

import { sql } from "../db.js";
import { awaitSearchSessionWrites } from "../search/session.js";
import { actorHasAnyApiKeyScope, getRequestActor, loadActorScopedProject, resolveActorProjectId } from "../lib/request-actor.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { apiStatusError } from "../lib/api-error.js";

function normalizePrefix(q: string | null): string {
  return (q ?? "").trim().slice(0, 64);
}

export const suggestRoutes = new Hono()
  .get("/suggest", async (c) => {
    const userId = c.get("sessionUser").id as string;
    const projectId = await resolveActorProjectId(
      getRequestActor(c),
      c.req.query("project"),
      c.req.query("orgId"),
    );
    const q = normalizePrefix(c.req.query("q") ?? null);
    const limit = Number(c.req.query("limit") ?? 8);

    const result = await readProjectSuggestions(userId, projectId, { q, limit });
    return result ? c.json(result) : apiStatusError(c, 404, "Project not found");
  })
  .get("/search/diagnostics", async (c) => {
    const sessionId = c.req.query("sessionId");
    if (!sessionId) return apiStatusError(c, 400, "Missing sessionId");
    const actor = getRequestActor(c);
    if (actor.type === "apiKey" && !actorHasAnyApiKeyScope(actor, ["search"])) {
      return apiStatusError(c, 403, "Forbidden");
    }

    // A write-behind search answers before its diagnostics row commits.
    await awaitSearchSessionWrites(sessionId);
    const [row] = await sql<{ reason: string; suggestions: unknown; created_at: string; project_id: string }[]>`
      select z.reason, z.suggestions, z.created_at, z.project_id
      from search_zero_results z
      where z.session_id = ${sessionId}
      order by z.created_at desc
      limit 1
    `;

    // Session IDs are not secrets: answer only for a project the actor (and,
    // for API keys, the key's org and project allowlist) can read, and treat
    // anything else exactly like a session with no diagnostics.
    if (!row || !(await loadActorScopedProject(row.project_id, actor))) return c.json({ diagnostics: null });
    return c.json({ diagnostics: { reason: row.reason, suggestions: row.suggestions, createdAt: row.created_at } });
  });

acceptApiKeys(suggestRoutes, ["GET /search/diagnostics"]);

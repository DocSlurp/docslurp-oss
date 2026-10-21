import { Hono } from "hono";

import { sql } from "../db.js";
import { awaitSearchSessionWrites, isProtectedStoredQuery } from "../search/session.js";
import { actorHasAnyApiKeyScope, getRequestActor, loadActorScopedWorkspace, resolveActorWorkspaceId } from "../lib/request-actor.js";
import { acceptApiKeys } from "../lib/route-auth.js";
import { apiStatusError } from "../lib/api-error.js";

function normalizePrefix(q: string | null): string {
  return (q ?? "").trim().slice(0, 64);
}

export const suggestRoutes = new Hono()
  .get("/suggest", async (c) => {
    const userId = c.get("sessionUser").id as string;
    const workspaceId = await resolveActorWorkspaceId(
      getRequestActor(c),
      c.req.query("workspaceId"),
      c.req.query("orgId"),
    );
    const q = normalizePrefix(c.req.query("q") ?? null);
    const limit = Number(c.req.query("limit") ?? 8);

    const like = q ? `${q}%` : "%";

    // 1) Recent queries for this workspace starting with prefix. Stored queries
    // are encrypted or hashed at rest; those rows have no text to suggest.
    const recentQueries = await sql<{ phrase: string; weight: number }[]>`
      select s.query as phrase, 10 as weight
      from search_sessions s
      where s.user_id = ${userId}
        and (s.metadata ->> 'workspaceId') = ${workspaceId}
        and s.query not like 'enc:%' and s.query not like 'redacted:%'
        and s.query ilike ${like}
      order by s.created_at desc
      limit ${limit}
    `;

    // 2) Curated suggestions
    const curated = await sql<{ phrase: string; weight: number }[]>`
      select phrase, weight
      from query_suggestions
      where user_id = ${userId} and workspace_id = ${workspaceId}
        and phrase ilike ${like}
      order by weight desc, created_at desc
      limit ${limit}
    `;

    // 3) Common filenames and headings as suggestions (workspace-scoped, not user-scoped)
    const headings = await sql<{ phrase: string; weight: number }[]>`
      select distinct on (phrase) phrase, weight from (
        select d.filename as phrase, 5 as weight
        from documents d
        join workspaces w on w.id = d.workspace_id
        left join org_memberships om on om.org_id = w.org_id and om.user_id = ${userId}
        left join workspace_members wm on wm.workspace_id = w.id and wm.user_id = ${userId}
        where d.workspace_id = ${workspaceId}
          and ((om.user_id is not null and (w.user_id = ${userId} or wm.user_id is not null or om.role in ('owner', 'admin') or w.is_default)) or (wm.user_id is not null and exists (select 1 from organizations o where o.id = w.org_id and o.is_personal)))
          and d.filename ilike ${like}
        limit ${limit}
      ) x
      order by phrase, weight desc
    `;

    const combined = [...(curated ?? []), ...(recentQueries ?? []), ...(headings ?? [])];
    const seen = new Set<string>();
    const suggestions = combined
      .sort((a, b) => b.weight - a.weight)
      .filter((r) => {
        if (isProtectedStoredQuery(r.phrase)) return false;
        const key = r.phrase.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit)
      .map((r) => r.phrase);

    // Current corpus (completed, not superseded) and its chunk total come from
    // trigger-maintained counters (documents.chunk_count, migration 0063); in-flight ingest uses the documents_workspace_in_flight_idx
    // partial index. Failed and superseded documents never keep the workspace
    // "partial", so the readiness poller can settle.
    const [semanticRow] = await sql<{
      indexed_chunk_count: number;
      completed_documents: number;
      in_flight_documents: number;
    }[]>`
      select
        coalesce((
          select sum(d.chunk_count)::int
          from documents d
          where d.workspace_id = w.id
            and d.status = 'completed' and d.superseded_at is null
        ), 0) as indexed_chunk_count,
        coalesce(cs.document_count, 0)::int as completed_documents,
        coalesce((
          select count(*)::int
          from documents d
          where d.workspace_id = w.id
            and d.status not in ('completed', 'failed', 'cancelled', 'pii_blocked')
        ), 0) as in_flight_documents
      from workspaces w
      left join workspace_corpus_stats cs on cs.workspace_id = w.id
      left join org_memberships om on om.org_id = w.org_id and om.user_id = ${userId}
      left join workspace_members wm on wm.workspace_id = w.id and wm.user_id = ${userId}
      where w.id = ${workspaceId}
        and ((om.user_id is not null and (w.user_id = ${userId} or wm.user_id is not null or om.role in ('owner', 'admin') or w.is_default)) or (wm.user_id is not null and exists (select 1 from organizations o where o.id = w.org_id and o.is_personal)))
      limit 1
    `;

    const headingSuggestions =
      semanticRow && semanticRow.indexed_chunk_count > 0
        ? await sql<{ heading: string; hits: number }[]>`
            select
              heading,
              count(*)::int as hits
            from (
              select trim(both from heading) as heading
              from document_chunks c
              join documents d on d.id = c.document_id
              join workspaces w on w.id = d.workspace_id
              left join org_memberships om on om.org_id = w.org_id and om.user_id = ${userId}
              left join workspace_members wm on wm.workspace_id = w.id and wm.user_id = ${userId}
              cross join unnest(c.heading_path) as heading
              where d.workspace_id = ${workspaceId}
                and d.status = 'completed' and d.superseded_at is null
                and trim(both from heading) <> ''
                and char_length(trim(both from heading)) >= 4
                and ((om.user_id is not null and (w.user_id = ${userId} or wm.user_id is not null or om.role in ('owner', 'admin') or w.is_default)) or (wm.user_id is not null and exists (select 1 from organizations o where o.id = w.org_id and o.is_personal)))
            ) headings
            group by heading
            order by hits desc, heading asc
            limit 4
          `
        : [];

    const filenameSuggestions =
      semanticRow && semanticRow.indexed_chunk_count > 0
        ? await sql<{ filename: string }[]>`
            select d.filename
            from documents d
            join workspaces w on w.id = d.workspace_id
            left join org_memberships om on om.org_id = w.org_id and om.user_id = ${userId}
            left join workspace_members wm on wm.workspace_id = w.id and wm.user_id = ${userId}
            where d.workspace_id = ${workspaceId}
              and d.status = 'completed' and d.superseded_at is null
              and ((om.user_id is not null and (w.user_id = ${userId} or wm.user_id is not null or om.role in ('owner', 'admin') or w.is_default)) or (wm.user_id is not null and exists (select 1 from organizations o where o.id = w.org_id and o.is_personal)))
            order by d.updated_at desc
            limit 3
          `
        : [];

    const contextualSeen = new Set<string>();
    const contextualSuggestions = [
      ...headingSuggestions.flatMap((row) => [
        `Summarize ${row.heading}`,
        `What are the key points in ${row.heading}?`,
      ]),
      ...filenameSuggestions.map((row) => `What matters most in ${row.filename}?`),
    ].filter((phrase) => {
      const key = phrase.toLowerCase();
      if (contextualSeen.has(key)) {
        return false;
      }
      contextualSeen.add(key);
      return true;
    }).slice(0, limit);

    const completedDocuments = semanticRow?.completed_documents ?? 0;
    const inFlightDocuments = semanticRow?.in_flight_documents ?? 0;
    const semanticStatus =
      !semanticRow || semanticRow.indexed_chunk_count === 0
        ? "none"
        : inFlightDocuments > 0
          ? "partial"
          : "ready";

    return c.json({
      suggestions,
      contextualSuggestions,
      semantic: {
        status: semanticStatus,
        indexedChunkCount: semanticRow?.indexed_chunk_count ?? 0,
        completedDocuments,
        totalDocuments: completedDocuments + inFlightDocuments,
      },
    });
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
    const [row] = await sql<{ reason: string; suggestions: unknown; created_at: string; workspace_id: string }[]>`
      select z.reason, z.suggestions, z.created_at, z.workspace_id
      from search_zero_results z
      where z.session_id = ${sessionId}
      order by z.created_at desc
      limit 1
    `;

    // Session IDs are not secrets: answer only for a workspace the actor (and,
    // for API keys, the key's org and workspace allowlist) can read, and treat
    // anything else exactly like a session with no diagnostics.
    if (!row || !(await loadActorScopedWorkspace(row.workspace_id, actor))) return c.json({ diagnostics: null });
    return c.json({ diagnostics: { reason: row.reason, suggestions: row.suggestions, createdAt: row.created_at } });
  });

acceptApiKeys(suggestRoutes, ["GET /search/diagnostics"]);

import type { ChatScope } from "./chat-instructions.js";
import { describeChatScope, SCOPE_PLACEHOLDER } from "./chat-instructions.js";
import { sql } from "../db.js";
import { scopeSubjectTerms, type ScopeDeclineDecision, type ScopeEvidence } from "../search/scope-relevance.js";
import { rankedLexicalChunks } from "./search.js";

/**
 * The workspace's scope for the default chat instructions and the scope
 * decline: its name and a few current document titles. Callers have already
 * authorized the workspace; every query is scoped to it.
 */

function cleanTitle(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[\r\n\t<>]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

export async function loadChatScope(workspaceId: string, workspaceName: string | null): Promise<ChatScope> {
  try {
    const rows = await sql<{ title: string | null }[]>`
      select coalesce(nullif(btrim(d.metadata ->> 'title'), ''), d.filename) as title
      from documents d
      where d.workspace_id = ${workspaceId} and d.status = 'completed' and d.superseded_at is null
      order by d.created_at
      limit 5
    `;
    return { workspaceName, documentTitles: rows.map(row => cleanTitle(row.title)).filter(Boolean) };
  } catch (error) {
    // The scope is a prompt hint: without titles the template uses the workspace name or a placeholder.
    console.warn("[chat-scope] document titles unavailable:", error instanceof Error ? error.message : String(error));
    return { workspaceName, documentTitles: [] };
  }
}

/**
 * Two or three questions the workspace can answer, from its document titles
 * and section headings. No model call.
 */
export async function loadScopeSuggestions(workspaceId: string, scope: ChatScope): Promise<string[]> {
  let headings: string[] = [];
  try {
    const rows = await sql<{ heading: string | null }[]>`
      select distinct on (lower(c.heading_path[1])) c.heading_path[1] as heading
      from document_chunks c
      join documents d on d.id = c.document_id
      where d.workspace_id = ${workspaceId} and d.status = 'completed' and d.superseded_at is null
        and array_length(c.heading_path, 1) > 0
      order by lower(c.heading_path[1]), c.chunk_index
      limit 6
    `;
    headings = rows.map(row => cleanTitle(row.heading)).filter(heading => heading.length >= 4);
  } catch (error) {
    console.warn("[chat-scope] headings unavailable:", error instanceof Error ? error.message : String(error));
  }
  const titles = (scope.documentTitles ?? []).filter(Boolean);
  const suggestions = [
    ...titles.slice(0, 2).map(title => `What does ${title} cover?`),
    ...headings.slice(0, 2).map(heading => `What do the documents say about ${heading}?`),
  ];
  if (suggestions.length === 0) suggestions.push("What topics do the documents in this workspace cover?");
  return [...new Set(suggestions)].slice(0, 3);
}

/** The polite templated decline: what the workspace covers and what to ask instead. */
export function buildScopeDeclineAnswer(scope: ChatScope, suggestions: readonly string[]): { answer: string; scope: string } {
  const covers = describeChatScope(scope);
  const scopeText = covers === SCOPE_PLACEHOLDER ? "the documents uploaded to it" : covers;
  const lines = [
    `That question doesn't look related to this workspace, which covers ${scopeText}, so I can't answer it from these documents.`,
  ];
  if (suggestions.length) {
    lines.push("", "You could ask, for example:", ...suggestions.map(suggestion => `- ${suggestion}`));
  }
  return { answer: lines.join("\n"), scope: scopeText };
}

/** Every decline is logged with its relevance score for tuning; the question text is never logged. */
export function logScopeDecline(args: { workspaceId: string; path: "retrieval" | "agent"; decision: ScopeDeclineDecision }): void {
  console.log(
    `[chat-scope-decline] workspace=${args.workspaceId} path=${args.path} relevance=${(args.decision.relevance.score ?? 0).toFixed(3)} threshold=${args.decision.threshold.toFixed(3)} content_terms=${args.decision.relevance.contentTerms} passages=${args.decision.relevance.passages}`,
  );
}

/** Longest the agent path waits for the scope probe; a slow probe never declines. */
const SCOPE_PROBE_TIMEOUT_MS = 1_500;

/**
 * Evidence for the scope decision before the chat agent runs: the workspace's
 * best lexical matches for any of the question's content terms (one bounded
 * Postgres full-text query, no model and no vector search). Coverage over these
 * candidates approximates coverage over the whole workspace, which is how the
 * threshold was calibrated. Empty on timeout or error, which never declines.
 */
export async function probeScopeEvidence(workspaceId: string, query: string): Promise<ScopeEvidence[]> {
  const terms = scopeSubjectTerms(query);
  if (terms.length < 2) return [];
  const probe = rankedLexicalChunks(sql, {
    where: sql`d.workspace_id = ${workspaceId} and d.status = 'completed' and d.superseded_at is null`,
    parser: "websearch",
    query: terms.slice(0, 16).join(" or "),
    limit: 12,
  }).then(rows => rows.map(row => ({ text: row.text, headingPath: row.heading_path, filename: row.filename })));
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ScopeEvidence[]>(resolve => { timer = setTimeout(() => resolve([]), SCOPE_PROBE_TIMEOUT_MS); });
  try {
    return await Promise.race([probe, timeout]);
  } catch (error) {
    console.warn("[chat-scope] scope probe failed:", error instanceof Error ? error.message : String(error));
    return [];
  } finally {
    clearTimeout(timer);
  }
}

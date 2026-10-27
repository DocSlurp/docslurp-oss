import type { ChatScope } from "./chat-instructions.js";
import { describeChatScope, neutralizeWorkspaceText, SCOPE_PLACEHOLDER } from "./chat-instructions.js";
import { sql } from "../db.js";
import type { ScopeDeclineDecision } from "../search/scope-relevance.js";

/**
 * The workspace's scope for the default chat instructions and the scope
 * decline. Only owner-controlled text describes it (the workspace name); no
 * query is needed. Callers have already authorized the workspace.
 */
export function chatScopeFor(workspace: { name?: string | null } | null | undefined): ChatScope {
  return { workspaceName: workspace?.name ?? null };
}

/**
 * A document title or heading made safe to show as a suggested question: it is
 * untrusted document content, so it is normalised, stripped of markup, URLs and
 * anything but words and light punctuation, and bounded. It is shown to the
 * user only, never placed in a prompt.
 */
export function suggestionTopic(value: string | null | undefined): string {
  const cleaned = neutralizeWorkspaceText(value ?? "", 400)
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, " ")
    .replace(/[^\p{L}\p{N}\s.,:;'’()&/-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= 60) return cleaned;
  const cut = cleaned.slice(0, 60);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).trim()}…`;
}

/**
 * Two or three questions the workspace can answer, from current document
 * titles and section headings (sanitised, quoted, bounded). No model call.
 */
export async function loadScopeSuggestions(workspaceId: string): Promise<string[]> {
  let titles: string[] = [];
  let headings: string[] = [];
  try {
    const [titleRows, headingRows] = await Promise.all([
      sql<{ title: string | null }[]>`
        select coalesce(nullif(btrim(d.metadata ->> 'title'), ''), d.filename) as title
        from documents d
        where d.workspace_id = ${workspaceId} and d.status = 'completed' and d.superseded_at is null
          and d.archived_at is null and d.purged_at is null
        order by d.created_at
        limit 4
      `,
      sql<{ heading: string | null }[]>`
        select distinct on (lower(c.heading_path[1])) c.heading_path[1] as heading
        from document_chunks c
        join documents d on d.id = c.document_id
        where d.workspace_id = ${workspaceId} and d.status = 'completed' and d.superseded_at is null
          and d.archived_at is null and d.purged_at is null
          and array_length(c.heading_path, 1) > 0
        order by lower(c.heading_path[1]), c.chunk_index
        limit 6
      `,
    ]);
    titles = titleRows.map(row => suggestionTopic(row.title)).filter(topic => topic.length >= 3);
    headings = headingRows.map(row => suggestionTopic(row.heading)).filter(topic => topic.length >= 4);
  } catch (error) {
    console.warn("[chat-scope] suggestion topics unavailable:", error instanceof Error ? error.message : String(error));
  }
  const suggestions = [
    ...titles.slice(0, 2).map(title => `What does “${title}” cover?`),
    ...headings.slice(0, 2).map(heading => `What do the documents say about “${heading}”?`),
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

/** Every decline is logged with its relevance for tuning; the question text is never logged. */
export function logScopeDecline(args: {
  workspaceId: string;
  path: "retrieval";
  decision: ScopeDeclineDecision;
  requestId?: string | null;
  sessionId?: string | null;
  searchSessionId?: string | null;
}): void {
  const signal = args.decision.signal;
  console.log(
    `[chat-scope-decline] workspace=${args.workspaceId} path=${args.path} request_id=${args.requestId ?? "none"} chat_session_id=${args.sessionId ?? "none"} search_session_id=${args.searchSessionId ?? "none"} relevance=${(args.decision.relevance ?? 0).toFixed(3)} threshold=${args.decision.threshold.toFixed(3)} top_cosine=${signal ? signal.topCosine.toFixed(3) : "none"} pipeline=${signal?.pipeline ?? "none"}`,
  );
}

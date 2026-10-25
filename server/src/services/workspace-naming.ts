import path from "node:path";

import { sql } from "../db.js";

/**
 * Automatic workspace titles move forward through phases, each a stronger signal
 * than the last: an untitled workspace (`empty`), its uploaded filenames
 * (`upload`), its content (`content`: a document summary, else the first
 * heading) and finally the subject of its first chat question (`chat`).
 *
 * The state lives in `workspace_search_settings.compat_metadata.autoTitle`
 * (`{ phase, name, source? }`). Automatic naming applies only while
 * `autoTitle.name` equals the workspace's name, so a manual rename stops it for
 * good. Renames run lazily (workspace reads, uploads and the first chat turn);
 * no timer or background job is involved.
 */
export const AUTO_TITLE_PHASES = ["empty", "upload", "content", "chat"] as const;
export type AutoTitlePhase = (typeof AUTO_TITLE_PHASES)[number];
/** Within the `content` phase a summary-derived title outranks a heading-derived one. */
export type AutoTitleSource = "summary" | "heading";

export function workspaceSubject(value: string): string | null {
  const title = value.replace(/^#+\s*/, "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (title.length < 3 || /^(?:untitled|contents|table of contents|copyright|all rights reserved|page \d+)$/i.test(title)) return null;
  const words = title.split(" ").slice(0, 9).join(" ");
  return words.slice(0, 72).replace(/\s+\S*$/, words.length > 72 ? "" : "$&");
}

export function workspaceChatSubject(message: string): string | null {
  return workspaceSubject(message.trim().replace(/^(?:please\s+)?(?:can you|could you|help me|i want to|i need to)\s+/i, "").replace(/[?!]+$/, ""));
}

const SUMMARY_NOTICE = /^Sampled document overview \([^)]*\)\.\s*/i;
const SUMMARY_LEAD_IN =
  /^(?:this|the)\s+(?:document|file|text|report|paper|page|pdf|article|transcript|recording|audio|video|presentation|spreadsheet|deck|book|chapter|excerpt|guide)\s+(?:is|provides|presents|describes|outlines|contains|details|covers|summarizes|discusses|explains|serves as|offers|documents|captures|records|lists)\s+/i;
const SUMMARY_CLAUSE_BREAK =
  /\s+(?:that|which|who|where|covering|detailing|describing|outlining|including|is|are|was|were|provides|presents|describes|outlines|details|covers|summarizes|discusses|explains|contains|offers|lists)\s+|[,;:()–—]|\s-\s/i;

/**
 * The subject of a stored one-paragraph document summary ("This document is a
 * quarterly revenue report for Acme, covering ..." -> "Quarterly revenue report
 * for Acme"). Null when the summary does not open with a usable noun phrase.
 */
export function workspaceSummarySubject(summary: string): string | null {
  const sentence = summary.replace(SUMMARY_NOTICE, "").trim().split(/(?<=[.!?])\s+/)[0] ?? "";
  let subject = sentence.replace(SUMMARY_LEAD_IN, "").replace(/^(?:a|an|the)\s+/i, "");
  subject = subject.split(SUMMARY_CLAUSE_BREAK)[0]!.replace(/[.!?]+$/, "").trim();
  if (subject.split(/\s+/).length < 2) return null;
  return workspaceSubject(subject.charAt(0).toUpperCase() + subject.slice(1));
}

function normalizeWorkspaceSeed(value: string): string | null {
  const normalized = value
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  return (normalized.charAt(0).toUpperCase() + normalized.slice(1)).slice(0, 120);
}

function formatAutoWorkspaceTitle(primary: string | null, additionalCount: number): string {
  if (!primary) return `New workspace ${new Date().toISOString().slice(0, 10)}`;
  const suffix = additionalCount > 0 ? ` + ${additionalCount} more` : "";
  return `${primary}${suffix}`.slice(0, 120);
}

export function inferWorkspaceTitleFromFilenames(filenames: string[]): string {
  return formatAutoWorkspaceTitle(
    normalizeWorkspaceSeed(path.basename(filenames[0] ?? "")),
    Math.max(0, filenames.length - 1),
  );
}

export function inferWorkspaceTitleFromUrls(urls: string[]): string {
  try {
    const firstUrl = new URL(urls[0] ?? "");
    return formatAutoWorkspaceTitle(
      normalizeWorkspaceSeed(path.basename(firstUrl.pathname)) ??
        normalizeWorkspaceSeed(firstUrl.hostname.replace(/^www\./, "")),
      Math.max(0, urls.length - 1),
    );
  } catch {
    return formatAutoWorkspaceTitle(null, 0);
  }
}

export async function markWorkspaceAutoNamed(workspaceId: string, userId: string, name: string, phase: "empty" | "upload" = "upload") {
  await sql`
    insert into workspace_search_settings (workspace_id, user_id, compat_metadata)
    values (${workspaceId}, ${userId}, jsonb_build_object('autoTitle', jsonb_build_object('phase', ${phase}::text, 'name', ${name}::text)))
    on conflict (workspace_id) do update set compat_metadata = workspace_search_settings.compat_metadata || excluded.compat_metadata
  `;
}

/**
 * Renames the workspace and advances its autoTitle, but only while its name is
 * still `currentName` (a concurrent manual rename wins). The workspace row is
 * left untouched when the name does not change. Returns whether the name changed.
 */
async function applyAutoTitle(args: { workspaceId: string; currentName: string; name: string; phase: AutoTitlePhase; source?: AutoTitleSource }): Promise<boolean> {
  const rows = await sql<{ renamed: boolean }[]>`
    with guard as (
      select id from workspaces where id = ${args.workspaceId} and name = ${args.currentName}
    ), renamed as (
      update workspaces set name = ${args.name}, updated_at = now()
      where id in (select id from guard) and name <> ${args.name}
      returning id
    ), marked as (
      update workspace_search_settings
      set compat_metadata = jsonb_set(compat_metadata, '{autoTitle}', jsonb_strip_nulls(jsonb_build_object(
        'phase', ${args.phase}::text, 'name', ${args.name}::text, 'source', ${args.source ?? null}::text)))
      where workspace_id in (select id from guard)
      returning workspace_id
    )
    select exists (select 1 from renamed) as renamed
  `;
  return rows[0]?.renamed === true;
}

/**
 * Names an untitled (`empty`) workspace from its first upload batch, and while
 * the title is still filename-based (`upload`) re-derives it from all of the
 * workspace's live files, so it describes the set rather than the first file.
 * Later phases are never touched. Returns the new name when it changed.
 */
export async function nameWorkspaceFromUpload(args: { workspaceId: string; filenames: string[]; urls?: string[] }): Promise<string | null> {
  const [row] = await sql<{ name: string; phase: AutoTitlePhase }[]>`
    select w.name, s.compat_metadata -> 'autoTitle' ->> 'phase' as phase
    from workspaces w
    join workspace_search_settings s on s.workspace_id = w.id
    where w.id = ${args.workspaceId} and s.compat_metadata -> 'autoTitle' ->> 'name' = w.name
      and s.compat_metadata -> 'autoTitle' ->> 'phase' in ('empty', 'upload')
  `;
  if (!row) return null;
  let name: string;
  if (row.phase === "empty") {
    if (args.urls?.length) name = inferWorkspaceTitleFromUrls(args.urls);
    else if (args.filenames.length) name = inferWorkspaceTitleFromFilenames(args.filenames);
    else return null;
  } else {
    // A URL-titled workspace keeps its title; filename re-derivation would only churn it.
    if (args.urls?.length) return null;
    const documents = await sql<{ filename: string }[]>`
      select filename from documents
      where workspace_id = ${args.workspaceId} and superseded_at is null and purged_at is null and archived_at is null
        and status not in ('failed', 'pii_blocked')
      order by created_at, id
    `;
    const filenames = [...new Set(documents.map((document) => document.filename))];
    if (!filenames.length) return null;
    name = inferWorkspaceTitleFromFilenames(filenames);
  }
  if (row.phase === "upload" && name === row.name) return null;
  return (await applyAutoTitle({ workspaceId: args.workspaceId, currentName: row.name, name, phase: "upload" })) ? name : null;
}

/**
 * Advances automatic titles from content (lazily, on workspace reads) or from
 * the first chat question (`firstMessage`). Content prefers the first stored
 * document summary over the first chunk heading or Index Map title; a
 * heading-titled workspace is upgraded once when a summary arrives. A manual
 * edit stops automatic naming.
 */
export async function refineWorkspaceNames(workspaceIds: string[], firstMessage?: string) {
  if (!workspaceIds.length) return;
  if (firstMessage) {
    const name = workspaceChatSubject(firstMessage);
    if (!name) return;
    const rows = await sql<{ id: string; name: string }[]>`
      select w.id, w.name from workspaces w
      join workspace_search_settings s on s.workspace_id = w.id
      where w.id = any(${workspaceIds}) and s.compat_metadata -> 'autoTitle' ->> 'name' = w.name
        and s.compat_metadata -> 'autoTitle' ->> 'phase' in ('empty', 'upload', 'content')
    `;
    for (const row of rows) await applyAutoTitle({ workspaceId: row.id, currentName: row.name, name, phase: "chat" });
    return;
  }
  const rows = await sql<{ id: string; name: string; phase: AutoTitlePhase; summary: string | null; title: string | null }[]>`
    select w.id, w.name,
      s.compat_metadata -> 'autoTitle' ->> 'phase' as phase,
      (select ds.summary from documents d
        join document_summaries ds on ds.user_id = d.user_id and ds.run_id = d.run_id and ds.document_id = d.id
        where d.workspace_id = w.id and d.superseded_at is null and length(trim(ds.summary)) > 0
        order by d.created_at, ds.created_at desc limit 1) as summary,
      case when s.compat_metadata -> 'autoTitle' ->> 'phase' = 'content' then null else coalesce(
        c.metadata ->> 'title', c.heading_path[1],
        -- Deferred documents have no chunks until pages are searched; their Index Map supplies a title.
        (select d.metadata ->> 'mapTitle' from documents d
          where d.workspace_id = w.id and d.metadata ->> 'mapTitle' is not null order by d.created_at limit 1)
      ) end as title
    from workspaces w
    join workspace_search_settings s on s.workspace_id = w.id
    left join lateral (
      select dc.metadata, dc.heading_path from document_chunks dc
      join documents d on d.id = dc.document_id
      where d.workspace_id = w.id and s.compat_metadata -> 'autoTitle' ->> 'phase' <> 'content'
        and (dc.metadata ->> 'title' is not null or array_length(dc.heading_path, 1) > 0)
      order by d.created_at, dc.chunk_index limit 1
    ) c on true
    where w.id = any(${workspaceIds}) and s.compat_metadata -> 'autoTitle' ->> 'name' = w.name
      and (
        s.compat_metadata -> 'autoTitle' ->> 'phase' in ('empty', 'upload')
        or (s.compat_metadata -> 'autoTitle' ->> 'phase' = 'content'
          and coalesce(s.compat_metadata -> 'autoTitle' ->> 'source', 'heading') <> 'summary')
      )
  `;
  for (const row of rows) {
    const fromSummary = row.summary ? workspaceSummarySubject(row.summary) : null;
    // Within the content phase only a summary may replace a heading-derived title.
    if (row.phase === "content") {
      if (fromSummary) await applyAutoTitle({ workspaceId: row.id, currentName: row.name, name: fromSummary, phase: "content", source: "summary" });
      continue;
    }
    const fromHeading = row.title ? workspaceSubject(row.title) : null;
    const name = fromSummary ?? fromHeading;
    if (!name) continue;
    await applyAutoTitle({ workspaceId: row.id, currentName: row.name, name, phase: "content", source: fromSummary ? "summary" : "heading" });
  }
}

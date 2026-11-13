import path from "node:path";

import { cleanDocumentTitle } from "@docslurp/shared";
import { sql } from "../db.js";

/** The pool, or the sweep's transaction. */
type Db = typeof sql;

/**
 * Automatic project titles move forward through phases, each a stronger signal
 * than the last: an untitled project (`empty`), its uploaded filenames
 * (`upload`) and its content (`content`: a document summary, else the first
 * heading). A chat message never names a project: it is one member's private
 * question ("thanks!" would become the name everyone sees). The `chat` phase
 * stays in the type only for titles written before this rule.
 *
 * The state lives in `project_search_settings.compat_metadata.autoTitle`
 * (`{ phase, name, source? }`). Automatic naming applies only while
 * `autoTitle.name` equals the project's name, so a manual rename stops it for
 * good. Upload titles are written by the upload itself; content titles by the
 * maintenance sweep after ingest (sweepProjectAutoTitles). Project reads never rename.
 */
export const AUTO_TITLE_PHASES = ["empty", "upload", "content", "chat"] as const;
export type AutoTitlePhase = (typeof AUTO_TITLE_PHASES)[number];
/** Within the `content` phase a summary-derived title outranks a heading-derived one. */
export type AutoTitleSource = "summary" | "heading";

export function projectSubject(value: string): string | null {
  const title = cleanDocumentTitle(value);
  if (!title || /^(?:copyright|all rights reserved)$/i.test(title)) return null;
  const words = title.split(" ").slice(0, 9).join(" ");
  return words.slice(0, 72).replace(/\s+\S*$/, words.length > 72 ? "" : "$&");
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
export function projectSummarySubject(summary: string): string | null {
  const sentence = summary.replace(SUMMARY_NOTICE, "").trim().split(/(?<=[.!?])\s+/)[0] ?? "";
  let subject = sentence.replace(SUMMARY_LEAD_IN, "").replace(/^(?:a|an|the)\s+/i, "");
  subject = subject.split(SUMMARY_CLAUSE_BREAK)[0]!.replace(/[.!?]+$/, "").trim();
  if (subject.split(/\s+/).length < 2) return null;
  return projectSubject(subject.charAt(0).toUpperCase() + subject.slice(1));
}

function normalizeProjectSeed(value: string): string | null {
  const normalized = value
    .replace(/\.[^.]+$/, "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  return (normalized.charAt(0).toUpperCase() + normalized.slice(1)).slice(0, 120);
}

function formatAutoProjectTitle(primary: string | null, additionalCount: number): string {
  if (!primary) return `New project ${new Date().toISOString().slice(0, 10)}`;
  const suffix = additionalCount > 0 ? ` + ${additionalCount} more` : "";
  return `${primary}${suffix}`.slice(0, 120);
}

export function inferProjectTitleFromFilenames(filenames: string[]): string {
  return formatAutoProjectTitle(
    normalizeProjectSeed(path.basename(filenames[0] ?? "")),
    Math.max(0, filenames.length - 1),
  );
}

export function inferProjectTitleFromUrls(urls: string[]): string {
  try {
    const firstUrl = new URL(urls[0] ?? "");
    return formatAutoProjectTitle(
      normalizeProjectSeed(path.basename(firstUrl.pathname)) ??
        normalizeProjectSeed(firstUrl.hostname.replace(/^www\./, "")),
      Math.max(0, urls.length - 1),
    );
  } catch {
    return formatAutoProjectTitle(null, 0);
  }
}

export async function markProjectAutoNamed(projectId: string, userId: string, name: string, phase: "empty" | "upload" = "upload") {
  await sql`
    insert into project_search_settings (project_id, user_id, compat_metadata)
    values (${projectId}, ${userId}, jsonb_build_object('autoTitle', jsonb_build_object('phase', ${phase}::text, 'name', ${name}::text)))
    on conflict (project_id) do update set compat_metadata = project_search_settings.compat_metadata || excluded.compat_metadata
  `;
}

/**
 * Renames the project and advances its autoTitle, but only while its name is
 * still `currentName` (a concurrent manual rename wins). The UPDATE predicate is
 * rechecked after acquiring the row lock; a snapshot-only CTE guard is unsafe.
 * Same-name transitions still admit a metadata update without changing updated_at.
 * Returns whether the name changed.
 */
async function applyAutoTitle(
  args: { projectId: string; currentName: string; name: string; phase: AutoTitlePhase; source?: AutoTitleSource },
  db: Db = sql,
): Promise<boolean> {
  const rows = await db<{ renamed: boolean }[]>`
    with admitted as (
      update projects set name = ${args.name},
        updated_at = case when name <> ${args.name} then now() else updated_at end
      where id = ${args.projectId} and name = ${args.currentName}
      returning id
    ), marked as (
      update project_search_settings
      set compat_metadata = jsonb_set(compat_metadata, '{autoTitle}', jsonb_strip_nulls(jsonb_build_object(
        'phase', ${args.phase}::text, 'name', ${args.name}::text, 'source', ${args.source ?? null}::text)))
      where project_id in (select id from admitted)
      returning project_id
    )
    select exists (select 1 from admitted) and ${args.currentName !== args.name}::boolean as renamed
  `;
  return rows[0]?.renamed === true;
}

/**
 * Names an untitled (`empty`) project from its first upload batch, and while
 * the title is still filename-based (`upload`) re-derives it from all of the
 * project's completed live files, so it describes the set rather than the first file.
 * Later phases are never touched. Returns the new name when it changed.
 */
export async function nameProjectFromUpload(args: { projectId: string; filenames: string[]; urls?: string[] }): Promise<string | null> {
  const [row] = await sql<{ name: string; phase: AutoTitlePhase }[]>`
    select w.name, s.compat_metadata -> 'autoTitle' ->> 'phase' as phase
    from projects w
    join project_search_settings s on s.project_id = w.id
    where w.id = ${args.projectId} and s.compat_metadata -> 'autoTitle' ->> 'name' = w.name
      and s.compat_metadata -> 'autoTitle' ->> 'phase' in ('empty', 'upload')
  `;
  if (!row) return null;
  let name: string;
  if (row.phase === "empty") {
    if (args.urls?.length) name = inferProjectTitleFromUrls(args.urls);
    else if (args.filenames.length) name = inferProjectTitleFromFilenames(args.filenames);
    else return null;
  } else {
    // A URL-titled project keeps its title; filename re-derivation would only churn it.
    if (args.urls?.length) return null;
    const documents = await sql<{ filename: string }[]>`
      select filename from documents
      where project_id = ${args.projectId} and superseded_at is null and purged_at is null and archived_at is null
        and status = 'completed'
      order by created_at, id
    `;
    const filenames = [...new Set(documents.map((document) => document.filename))];
    if (!filenames.length) return null;
    name = inferProjectTitleFromFilenames(filenames);
  }
  if (row.phase === "upload" && name === row.name) return null;
  return (await applyAutoTitle({ projectId: args.projectId, currentName: row.name, name, phase: "upload" })) ? name : null;
}

const AUTO_TITLE_SWEEP_BATCH = 50;
/** Batches per sweep, so a backlog (first run, or after an outage) drains over a few ticks without one long pass. */
const AUTO_TITLE_SWEEP_MAX_BATCHES = 10;
const AUTO_TITLE_SWEEP_LOCK = "project-auto-title-sweep";

/**
 * After ingest: refines the automatic titles of projects whose current corpus
 * changed since the sweep last examined them. project_corpus_stats.updated_at
 * moves as documents complete (trigger-maintained); auto_title_checked_at is
 * the updated_at the sweep last saw (0153). A project is pending while the two
 * differ, with no lookback window, and the oldest change goes first: a project
 * the sweep cannot rename is marked examined like any other, so it cannot hold
 * a place in the queue, and an outage of any length is caught up afterwards.
 *
 * Runs from the maintenance sweep, so project reads (dashboard, chat, search)
 * never write. One instance at a time (transaction-scoped advisory lock per
 * batch); the others skip the tick. Returns the number of projects examined.
 */
export async function sweepProjectAutoTitles(options: { batchSize?: number; maxBatches?: number } = {}): Promise<number> {
  const batchSize = options.batchSize ?? AUTO_TITLE_SWEEP_BATCH;
  let examined = 0;
  for (let i = 0; i < (options.maxBatches ?? AUTO_TITLE_SWEEP_MAX_BATCHES); i += 1) {
    // One transaction per batch: claim, read evidence, rename, checkpoint, commit. The claim row-locks each
    // project's stats row, and a summary write locks the same row (0153 trigger), so the two serialize:
    // - a summary written while the batch holds the row waits, then clears the checkpoint (pending again);
    // - a summary transaction already holding the row makes the claim skip it (still pending);
    // - a summary committed before the claim is visible to the evidence read.
    // A crash or failed rename rolls the checkpoint back with everything else. The advisory lock keeps one sweep
    // at a time, so overlapping sweeps cannot apply stale evidence over newer evidence.
    // Bounded: the claimed stats rows block summary writes and document completions for those projects until this
    // commits, so the batch never waits long on another lock or runs long. A timeout (or a deadlock) rolls the whole
    // batch back; its projects stay pending and the next tick retries.
    let batch: { claimed: number } | null;
    try {
      batch = await sql.begin(async (transaction) => {
        const tx = transaction as unknown as Db;
        await tx`set local lock_timeout = '2s'`;
        await tx`set local statement_timeout = '10s'`;
        const [lock] = await tx<{ locked: boolean }[]>`select pg_try_advisory_xact_lock(hashtext(${AUTO_TITLE_SWEEP_LOCK})) as locked`;
        if (!lock?.locked) return null;
        // updated_at as text: a JS Date drops the microseconds the comparison needs.
        const rows = await tx<{ id: string; seen: string }[]>`
          select cs.project_id as id, cs.updated_at::text as seen
          from project_corpus_stats cs
          where cs.auto_title_checked_at is distinct from cs.updated_at
          order by cs.updated_at, cs.project_id
          limit ${batchSize}
          for update skip locked
        `;
        if (rows.length === 0) return { claimed: 0 };
        const ids = rows.map((row) => row.id);
        const eligible = await tx<{ id: string }[]>`
          select w.id from projects w join project_search_settings s on s.project_id = w.id
          where w.id = any(${tx.array(ids)}::text[]) and s.compat_metadata -> 'autoTitle' ->> 'name' = w.name
            and (
              s.compat_metadata -> 'autoTitle' ->> 'phase' in ('empty', 'upload')
              or (s.compat_metadata -> 'autoTitle' ->> 'phase' = 'content'
                and coalesce(s.compat_metadata -> 'autoTitle' ->> 'source', 'heading') <> 'summary')
            )
        `;
        await refineProjectNames(eligible.map((row) => row.id), tx);
        // Recorded as the updated_at that was read: a document completing after the claim waits for this commit and
        // then moves updated_at past it, so the project is pending again.
        await tx`
          update project_corpus_stats cs set auto_title_checked_at = v.seen::timestamptz
          from unnest(${tx.array(ids)}::text[], ${tx.array(rows.map((row) => row.seen))}::text[]) as v(id, seen)
          where cs.project_id = v.id
        `;
        return { claimed: rows.length };
      });
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "55P03" && code !== "57014" && code !== "40P01") throw error;
      console.warn(`[project-naming] status=sweep-batch-rolled-back code=${code}: projects stay pending for the next sweep`);
      break;
    }
    // Another instance holds the lock and is doing this work.
    if (!batch) break;
    examined += batch.claimed;
    // A short page is the end of what can be claimed now; rows held by ingest wait for the next sweep.
    if (batch.claimed < batchSize) break;
  }
  return examined;
}

/**
 * Advances automatic titles from content (after ingest, from the maintenance sweep). Content prefers the first stored
 * document summary over the first chunk heading or Index Map title; a
 * heading-titled project is upgraded once when a summary arrives. A manual
 * edit stops automatic naming.
 */
export async function refineProjectNames(projectIds: string[], db: Db = sql) {
  if (!projectIds.length) return;
  const rows = await db<{ id: string; name: string; phase: AutoTitlePhase; summary: string | null; title: string | null }[]>`
    select w.id, w.name,
      s.compat_metadata -> 'autoTitle' ->> 'phase' as phase,
      (select ds.summary from documents d
        join document_summaries ds on ds.user_id = d.user_id and ds.run_id = d.run_id and ds.document_id = d.id
        where d.project_id = w.id and d.superseded_at is null and d.archived_at is null and d.purged_at is null
          and d.status = 'completed' and length(trim(ds.summary)) > 0
        order by d.created_at, ds.created_at desc limit 1) as summary,
      case when s.compat_metadata -> 'autoTitle' ->> 'phase' = 'content' then null else coalesce(
        -- Retain extraction-derived titles as a fallback when no summary exists.
        (select d.metadata ->> 'title' from documents d
          where d.project_id = w.id and d.superseded_at is null and d.archived_at is null and d.purged_at is null
          and d.status = 'completed' and nullif(btrim(d.metadata ->> 'title'), '') is not null
          order by d.created_at limit 1),
        c.metadata ->> 'title', c.heading_path[1],
        -- Deferred documents have no chunks until pages are searched; their Index Map supplies a title.
        (select d.metadata ->> 'mapTitle' from documents d
          where d.project_id = w.id and d.superseded_at is null and d.archived_at is null and d.purged_at is null
          and d.status = 'completed' and d.metadata ->> 'mapTitle' is not null order by d.created_at limit 1)
      ) end as title
    from projects w
    join project_search_settings s on s.project_id = w.id
    left join lateral (
      select dc.metadata, dc.heading_path from document_chunks dc
      join documents d on d.id = dc.document_id
      where d.project_id = w.id and d.superseded_at is null and d.archived_at is null and d.purged_at is null
          and d.status = 'completed' and s.compat_metadata -> 'autoTitle' ->> 'phase' <> 'content'
        and (dc.metadata ->> 'title' is not null or array_length(dc.heading_path, 1) > 0)
      order by d.created_at, dc.chunk_index limit 1
    ) c on true
    where w.id = any(${projectIds}) and s.compat_metadata -> 'autoTitle' ->> 'name' = w.name
      and (
        s.compat_metadata -> 'autoTitle' ->> 'phase' in ('empty', 'upload')
        or (s.compat_metadata -> 'autoTitle' ->> 'phase' = 'content'
          and coalesce(s.compat_metadata -> 'autoTitle' ->> 'source', 'heading') <> 'summary')
      )
  `;
  for (const row of rows) {
    const fromSummary = row.summary ? projectSummarySubject(row.summary) : null;
    // Within the content phase only a summary may replace a heading-derived title.
    if (row.phase === "content") {
      if (fromSummary) await applyAutoTitle({ projectId: row.id, currentName: row.name, name: fromSummary, phase: "content", source: "summary" }, db);
      continue;
    }
    const fromHeading = row.title ? projectSubject(row.title) : null;
    const name = fromSummary ?? fromHeading;
    if (!name) continue;
    await applyAutoTitle({ projectId: row.id, currentName: row.name, name, phase: "content", source: fromSummary ? "summary" : "heading" }, db);
  }
}

/*
 * On-demand figure resumes (docs/extraction/doppler-figures.md, "Resuming partial figures"): queue a document, or a
 * project's resumable documents (capped), for the worker's resume runner. Only queues: the runner claims under its own
 * caps (DOCSLURP_FIGURE_RESUME, one per organization, three attempts, spend checks). Every query is scoped by the
 * caller's organization and project, resolved by the route; a document of another scope is the same "not found".
 *
 * Also the backstop sweep: a resumable level the commit-time enqueue missed is queued again (auto projects only).
 */
import { FIGURE_RESUME_LIMITS, projectFigureResumeMode } from "@docslurp/shared";
import { sql } from "../db.js";

export type FigureResumeRequestStatus = "queued" | "already-queued" | "not-resumable" | "capped" | "off";

export interface FigureResumeScope {
  orgId: string;
  projectId: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DOCUMENT_ID = /^[A-Za-z0-9-]{1,64}$/;

function assertScope(scope: FigureResumeScope): void {
  if (!scope || typeof scope.orgId !== "string" || !ID.test(scope.orgId) || typeof scope.projectId !== "string" || !ID.test(scope.projectId)) {
    throw new Error("A figure resume needs an organization and a project");
  }
}

/**
 * Live, completed documents of the scope whose current level a resume could finish: the Markdown committed, under the
 * lifetime VM launch cap, not blocked `attempts` or `unscanned`, and some unit below its cap (the unsharded document, a resumable shard,
 * or a gap). The runner re-checks all of it at claim.
 */
function resumableWhere(scope: FigureResumeScope) {
  return sql`
    l.org_id = ${scope.orgId} and l.project_id = ${scope.projectId}
      and l.images_status = 'resumable' and l.assets_current and l.markdown_complete
      and l.resume_vm_launches < ${FIGURE_RESUME_LIMITS.maxVmLaunches} and coalesce(l.resume_blocked, '') not in ('attempts', 'unscanned')
      and d.id = l.document_id and d.org_id = l.org_id and d.project_id = l.project_id and d.run_id is not distinct from l.run_id
      and d.status = 'completed' and d.superseded_at is null and d.archived_at is null and d.purged_at is null
      and (
        (l.shards = 0 and l.resumes < ${FIGURE_RESUME_LIMITS.maxAttempts} and (l.assets_resumable > 0 or l.assets_pending > 0))
        or exists (select 1 from document_extraction_shards s where s.document_id = l.document_id and s.org_id = l.org_id
          and s.run_id is not distinct from l.run_id and s.images_status = 'resumable' and s.resumes < ${FIGURE_RESUME_LIMITS.maxAttempts})
        or coalesce(jsonb_array_length(l.gaps), 0) > 0
      )`;
}

async function projectMode(scope: FigureResumeScope) {
  const [project] = await sql<{ pipeline: unknown }[]>`select pipeline from projects where id = ${scope.projectId} and org_id = ${scope.orgId}`;
  return project ? projectFigureResumeMode(project.pipeline) : null;
}

/**
 * Queue one document's resume now. `off` when the project's figures or resumes are off; `capped` when every unit spent
 * its attempts or the document its lifetime VM launches; `not-resumable` when nothing is left (or the document is not this
 * scope's: the route answers 404 for that before calling). A request clears only an earlier block reason other than the
 * cap (`attempts`) and `unscanned` (no parse decision: only a new run that records one clears it, R6-H1 F3), and the
 * backoff: it never resets a counter (H4: a request cannot buy more VM time).
 */
export async function requestDocumentFigureResume(scope: FigureResumeScope & { documentId: string }): Promise<FigureResumeRequestStatus> {
  assertScope(scope);
  if (typeof scope.documentId !== "string" || !DOCUMENT_ID.test(scope.documentId)) return "not-resumable";
  const mode = await projectMode(scope);
  if (!mode || mode === "off") return "off";
  const [level] = await sql<{ queued: boolean; resumable: boolean; capped: boolean }[]>`
    select l.resume_after is not null and l.resume_blocked is null as queued,
      exists (select 1 from documents d where ${resumableWhere(scope)}) as resumable,
      (l.resume_blocked = 'attempts' or l.resume_vm_launches >= ${FIGURE_RESUME_LIMITS.maxVmLaunches}) as capped
    from document_extraction_levels l
    where l.document_id = ${scope.documentId} and l.org_id = ${scope.orgId} and l.project_id = ${scope.projectId}`;
  if (!level) return "not-resumable";
  if (level.capped) return "capped";
  if (!level.resumable) {
    const [spent] = await sql<{ n: number }[]>`
      select count(*)::int as n from document_extraction_levels l
      where l.document_id = ${scope.documentId} and l.org_id = ${scope.orgId} and l.images_status = 'resumable'`;
    return (spent?.n ?? 0) > 0 ? "capped" : "not-resumable";
  }
  if (level.queued) return "already-queued";
  const updated = await sql`
    update document_extraction_levels l set resume_after = now(), resume_blocked = null
    from documents d
    where l.document_id = ${scope.documentId} and ${resumableWhere(scope)} and (coalesce(l.resume_blocked, '') not in ('attempts', 'unscanned'))
    returning 1`;
  console.log(`[doppler-figures] resume requested doc=${scope.documentId} org=${scope.orgId} status=${updated.length > 0 ? "queued" : "not-resumable"}`);
  return updated.length > 0 ? "queued" : "not-resumable";
}

/** Queue up to `limit` (at most 100) of a project's resumable documents, oldest first. */
export async function requestProjectFigureResumes(scope: FigureResumeScope & { limit?: number }): Promise<{ status: "queued" | "off"; queued: number; alreadyQueued: number; capped: boolean }> {
  assertScope(scope);
  const limit = Math.min(Math.max(Math.floor(scope.limit ?? FIGURE_RESUME_LIMITS.bulkMax) || 1, 1), FIGURE_RESUME_LIMITS.bulkMax);
  const mode = await projectMode(scope);
  if (!mode || mode === "off") return { status: "off", queued: 0, alreadyQueued: 0, capped: false };
  const [already] = await sql<{ n: number }[]>`
    select count(*)::int as n from document_extraction_levels l join documents d on d.id = l.document_id
    where ${resumableWhere(scope)} and l.resume_after is not null and l.resume_blocked is null`;
  // One more than the cap is selected (never updated) only to say whether more remain (L10).
  const picked = await sql<{ document_id: string }[]>`
    select l.document_id from document_extraction_levels l join documents d on d.id = l.document_id
    where ${resumableWhere(scope)} and l.resume_after is null
    order by l.updated_at, l.document_id
    limit ${limit + 1}`;
  const capped = picked.length > limit;
  const ids = picked.slice(0, limit).map((row) => row.document_id);
  const queued = ids.length === 0 ? [] : await sql<{ document_id: string }[]>`
    update document_extraction_levels l set resume_after = now(), resume_blocked = null
    from documents d
    where l.document_id = any(${sql.array(ids)}::text[]) and ${resumableWhere(scope)} and l.resume_after is null
    returning l.document_id`;
  const count = Math.min(queued.length, limit);
  console.log(`[doppler-figures] resume requested project=${scope.projectId} org=${scope.orgId} queued=${count} already=${already?.n ?? 0} capped=${capped}`);
  return { status: "queued", queued: count, alreadyQueued: already?.n ?? 0, capped };
}

/** How many of a project's documents a resume could finish now (for the chat's offer and the settings read). */
export async function countResumableFigureDocuments(scope: FigureResumeScope): Promise<number> {
  assertScope(scope);
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from document_extraction_levels l join documents d on d.id = l.document_id where ${resumableWhere(scope)}`;
  return row?.n ?? 0;
}

/**
 * Backstop for a lost commit-time enqueue: resumable, current levels of `auto` projects with no queue entry and no block
 * are queued (at most 200 per pass, every 10 minutes at most).
 */
let lastBackstop = 0;
export async function sweepFigureResumeQueue(now = Date.now()): Promise<number> {
  if (now - lastBackstop < 10 * 60_000) return 0;
  lastBackstop = now;
  const rows = await sql<{ document_id: string }[]>`
    update document_extraction_levels l set resume_after = now()
    where l.document_id in (
      select l2.document_id from document_extraction_levels l2
      join projects p on p.id = l2.project_id and p.org_id = l2.org_id
      join documents d on d.id = l2.document_id and d.org_id = l2.org_id and d.run_id = l2.run_id
      where l2.images_status = 'resumable' and l2.assets_current and l2.markdown_complete and l2.resume_after is null and l2.resume_blocked is null
        and l2.resume_vm_launches < ${FIGURE_RESUME_LIMITS.maxVmLaunches} and l2.resume_failures < ${FIGURE_RESUME_LIMITS.maxAttempts}
        and d.status = 'completed' and d.superseded_at is null and d.archived_at is null and d.purged_at is null
        and l2.updated_at < now() - interval '5 minutes'
        and coalesce(p.pipeline ->> 'figureResume', 'auto') = 'auto'
        and coalesce(p.pipeline -> 'figures', 'true'::jsonb) not in ('false'::jsonb, '"off"'::jsonb)
        and coalesce(p.pipeline -> 'figures' ->> 'enabled', 'true') <> 'false'
      order by l2.updated_at
      limit 200)
    returning l.document_id`;
  if (rows.length > 0) console.log(`[doppler-figures] resume backstop queued=${rows.length}`);
  return rows.length;
}

/** Test hook: let the next backstop run immediately. */
export function resetFigureResumeBackstopForTest(): void {
  lastBackstop = 0;
}

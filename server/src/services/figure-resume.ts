/*
 * On-demand figure resumes (docs/extraction/doppler-figures.md, "Resuming partial figures"): queue a document, or a
 * project's resumable documents (capped), for the worker's resume runner. Only queues: the runner claims under its own
 * caps (DOCSLURP_FIGURE_RESUME, one per organization, three attempts, spend checks). Every query is scoped by the
 * caller's organization and project, resolved by the route; a document of another scope is the same "not found".
 *
 * Also the backstop sweep: a resumable level the commit-time enqueue missed is queued again (auto projects only).
 */
import {
  FIGURE_RESUME_BUDGET_BLOCKS, FIGURE_RESUME_LIMITS, figureResumeBudgetConfig, isFigureResumeBudgetBlock, projectFigureResumeMode,
  type FigureResumeBlockReason,
} from "@docslurp/shared";
import { sql } from "../db.js";

export type FigureResumeRequestStatus = "queued" | "already-queued" | "not-resumable" | "capped" | "off";

/**
 * A single-document request's answer: the status, the block reason the document has (or had, when this request cleared
 * it), and whether the request granted a budget extension. Reason codes are fixed (FIGURE_RESUME_BLOCK_REASONS).
 */
export interface FigureResumeRequestResult {
  status: FigureResumeRequestStatus;
  reason: FigureResumeBlockReason | null;
  granted: boolean;
  /** Extensions left for this run after this request. */
  grantsLeft: number;
}

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

/** Blocks no request clears (`unscanned`: only a new run that records a parse decision, R6-H1 F3). */
const STICKY_BLOCKS = ["unscanned"] as const;

/**
 * Live, completed documents of the scope whose current level has figure work left (the unsharded document's resumable
 * images, a resumable shard, or a gap), the Markdown committed. `budget`:
 *   - `exclude`: not blocked by a budget stop (`attempts`, `vm-budget`, `no-progress`) or `unscanned` (bulk, counts);
 *   - `grantable`: a budget-blocked document still counts while it has request grants left (one document's request).
 * The page-scaled caps themselves are the runner's (it re-checks everything at claim and blocks with a reason, never
 * starting a VM past them).
 */
export function resumableWhere(scope: FigureResumeScope, budget: "exclude" | "grantable" = "exclude") {
  const maxGrants = figureResumeBudgetConfig().maxGrants;
  const blocks = sql.array([...FIGURE_RESUME_BUDGET_BLOCKS]);
  const blockOk = budget === "exclude"
    ? sql`(l.resume_blocked is null or not (l.resume_blocked = any(${blocks}::text[]) or l.resume_blocked = any(${sql.array([...STICKY_BLOCKS])}::text[])))`
    : sql`(l.resume_blocked is null or not (l.resume_blocked = any(${sql.array([...STICKY_BLOCKS])}::text[]))) and (l.resume_blocked is null
        or not (l.resume_blocked = any(${blocks}::text[])) or l.resume_grants < ${maxGrants})`;
  return sql`
    l.org_id = ${scope.orgId} and l.project_id = ${scope.projectId}
      and l.images_status = 'resumable' and l.assets_current and l.markdown_complete and ${blockOk}
      and d.id = l.document_id and d.org_id = l.org_id and d.project_id = l.project_id and d.run_id is not distinct from l.run_id
      and d.status = 'completed' and d.superseded_at is null and d.archived_at is null and d.purged_at is null
      and (
        (l.shards = 0 and (l.assets_resumable > 0 or l.assets_pending > 0))
        or exists (select 1 from document_extraction_shards s where s.document_id = l.document_id and s.org_id = l.org_id
          and s.run_id is not distinct from l.run_id and s.images_status = 'resumable')
        or coalesce(jsonb_array_length(l.gaps), 0) > 0
      )`;
}

async function projectMode(scope: FigureResumeScope) {
  const [project] = await sql<{ pipeline: unknown }[]>`select pipeline from projects where id = ${scope.projectId} and org_id = ${scope.orgId}`;
  return project ? projectFigureResumeMode(project.pipeline) : null;
}

/**
 * Queue one document's resume now. `off` when the project's figures or resumes are off; `not-resumable` when nothing is
 * left (or the document is not this scope's: the route answers 404 for that before calling); `capped` with its reason when
 * the document is past a budget stop and has no grant left, or blocked `unscanned` (only a new run that records a parse
 * decision clears that, R6-H1 F3).
 *
 * A budget block (`attempts`, `vm-budget`, `no-progress`) is cleared by granting one extension: resume_grants + 1 (each
 * adds half the page-scaled caps again, figure-resume-limits.ts), the no-progress count and the unit failures reset. At
 * most DOCSLURP_FIGURE_RESUME_MAX_GRANTS per run, so a request buys a bounded amount of VM time (H4); a reprocess (a new,
 * customer-paid run) starts every counter clean. Other blocks and the backoff are cleared without a grant.
 */
export async function requestDocumentFigureResume(scope: FigureResumeScope & { documentId: string }): Promise<FigureResumeRequestResult> {
  assertScope(scope);
  const maxGrants = figureResumeBudgetConfig().maxGrants;
  const answer = (status: FigureResumeRequestStatus, reason: FigureResumeBlockReason | null = null, granted = false, grants = 0): FigureResumeRequestResult =>
    ({ status, reason, granted, grantsLeft: Math.max(0, maxGrants - grants) });
  if (typeof scope.documentId !== "string" || !DOCUMENT_ID.test(scope.documentId)) return answer("not-resumable");
  const mode = await projectMode(scope);
  if (!mode || mode === "off") return answer("off");
  const [level] = await sql<{ queued: boolean; resumable: boolean; blocked: FigureResumeBlockReason | null; grants: number; status: string }[]>`
    select l.resume_after is not null and l.resume_blocked is null as queued, l.resume_blocked as blocked, l.resume_grants as grants,
      l.images_status as status,
      exists (select 1 from documents d where ${resumableWhere(scope, "grantable")}) as resumable
    from document_extraction_levels l
    where l.document_id = ${scope.documentId} and l.org_id = ${scope.orgId} and l.project_id = ${scope.projectId}`;
  if (!level) return answer("not-resumable");
  const budgetBlocked = isFigureResumeBudgetBlock(level.blocked);
  if (!level.resumable) {
    const capped = level.status === "resumable" && (level.blocked === "unscanned" || (budgetBlocked && level.grants >= maxGrants));
    const result = answer(capped ? "capped" : "not-resumable", level.blocked, false, level.grants);
    console.log(`[doppler-figures] resume requested doc=${scope.documentId} org=${scope.orgId} status=${result.status} reason=${level.blocked ?? "none"} grants=${level.grants}/${maxGrants}`);
    return result;
  }
  if (level.queued) return answer("already-queued", null, false, level.grants);
  // One statement: the grant only when the row is still budget-blocked with grants left (a concurrent request grants once).
  const [updated] = await sql<{ grants: number; granted: boolean }[]>`
    update document_extraction_levels l set resume_after = now(), resume_blocked = null, resume_blocked_at = null,
      resume_grants = l.resume_grants + case when l.resume_blocked = any(${sql.array([...FIGURE_RESUME_BUDGET_BLOCKS])}::text[]) then 1 else 0 end,
      resume_stalls = case when l.resume_blocked = any(${sql.array([...FIGURE_RESUME_BUDGET_BLOCKS])}::text[]) then 0 else l.resume_stalls end,
      resume_failures = case when l.resume_blocked = any(${sql.array([...FIGURE_RESUME_BUDGET_BLOCKS])}::text[]) then 0 else l.resume_failures end,
      resume_unit_failures = case when l.resume_blocked = any(${sql.array([...FIGURE_RESUME_BUDGET_BLOCKS])}::text[]) then '{}'::jsonb else l.resume_unit_failures end
    from documents d
    where l.document_id = ${scope.documentId} and ${resumableWhere(scope, "grantable")}
      and l.resume_blocked is not distinct from ${level.blocked}::text
    returning l.resume_grants as grants, l.resume_grants > ${level.grants} as granted`;
  const result = updated ? answer("queued", level.blocked, updated.granted, updated.grants) : answer("not-resumable", level.blocked, false, level.grants);
  console.log(`[doppler-figures] resume requested doc=${scope.documentId} org=${scope.orgId} status=${result.status} reason=${level.blocked ?? "none"} granted=${result.granted} grants=${updated?.grants ?? level.grants}/${maxGrants}`);
  return result;
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

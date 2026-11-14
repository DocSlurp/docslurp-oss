/*
 * The figure resume runner (docs/extraction/doppler-figures.md, "Resuming partial figures"): finishes the images a figure
 * pass left resumable, and keeps storage and the ledger in agreement (adopt, audit, orphan GC, retention).
 *
 * Claim (one transaction): the oldest due document of each organization that holds no live lease (fair across
 * organizations, M6), re-locked `for update skip locked`, only for a `completed` document whose Markdown committed and
 * whose level belongs to the document's current run (M1), only while DOCSLURP_FIGURE_RESUME and the deploy figure flag
 * are on (M7), the project's figures are on and its `figureResume` is not `off`, the document is under its lifetime VM
 * launch cap, the organization may spend and has resume VM time left today (H4). The lease is fenced: every later runner
 * write matches the lease owner and the claimed run, so a reprocess or a second runner is never overwritten (M2).
 *
 * The bytes converted are the document's parse source (lib/parse-source.ts, R6-H1): quarantine's decision, hash-bound, never
 * the upload's key; a document without a decision from this build's quarantine is blocked `unscanned` with no VM.
 *
 * One unit per claim (a shard, a gap or the unsharded document), then the document goes back to the queue (M6):
 *   1. adopt pending uploads a crashed attempt left (streamed SHA-256, no VM);
 *   2. if a runnable unit remains (below #355's per-unit and per-document caps): the lease is extended for the unit's
 *      pages (heartbeat), the launch is counted (lifetime and per organization per day), the unit's stored manifest only
 *      (none for a gap: a fresh pass over its pages becomes its shard), the provider's `figures.resume` in a fresh VM, the
 *      folder validated whole (resume mode: stored images keep their digest), new files stored pending → stored with
 *      conditional creates, figure files only (`folderFiles: false`); the new manifests are staged by content before the
 *      ledger write and published after it, the index rebuilt after it with the stored Markdown's markers (unsharded);
 *   3. the VM time recorded as a cost-only event at its real cost, `billable: false`, for failed and timed-out runs too.
 * With no runnable unit left the document is blocked `attempts` (H1), never re-queued forever.
 *
 * PII (owner rule: one PII page never blocks or fails a document): figures resumed on a page the PII stage withheld are
 * added to the document's withheld list before they are uploaded, so they are never served; clean pages resume normally.
 *
 * Nothing here deletes a figure except the orphan GC (DOCSLURP_FIGURE_GC_DELETE, dry run by default): objects under a
 * document's folder that no ledger row vouches for, re-checked under the document's ledger lock right before the delete,
 * 24 hours after their last write; and, past their retention, the figures of failed or cancelled documents (7 days) and of
 * levels that are no longer current (24 hours). The audit (DOCSLURP_FIGURE_AUDIT, dry run by default) adopts aged pending
 * rows and turns a current stored row whose object is confirmed missing (HEAD 404) or of another size into a resumable
 * `aborted` image; a truncated listing is never read as "missing".
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Sql } from "postgres";
import {
  DOPPLER_STORE_LAYOUT, dopplerFigureSlot, dopplerImageExtractEnabled, dopplerImageLimits, dopplerShardFolder, figureAuditWrites,
  figureGcDeletes, figureResumeBackoffMs, figureResumeBudgetConfig, figureResumeConcurrency, figureResumeDeployEnabled, figureResumeGlobalMax,
  figureResumeLaunchCap as launchCapFor, figureResumeOrgDailyVmMs, figureResumeLaunchPages, figureResumeLaunchVmMs, figureResumeProgressed, figureResumeUnitCap, figureResumeUnitStrikeLimit,
  figureResumeVmBudgetMs, parseDopplerFigureId,
  projectFigureResumeMode, projectFiguresOff, FIGURE_RESUME_LIMITS, type FigureResumeBlockReason,
} from "@docslurp/shared";
import { recordFigureTelemetry } from "@docslurp/shared/observability";

import {
  adoptPendingAssets, figureLedgerHooks, isMissingObject, ledgerWriteForStoredFigures, markAssetsLost,
  markAssetsPending, markAssetsStored, writeDocumentAssetLedger, DocumentAssetLedgerError,
  type DocumentAssetLedgerScope, type FigureObjectReader,
} from "../db/document-asset-ledger.js";
import { persistScopedUsageEvents } from "../db/usage-event-store.js";
import { documentParseSource } from "../db/store.js";
import { isUnscannedParseSourceKey } from "../lib/parse-source.js";
import { SourceRefusalError, stageSourceFile } from "../sandbox/source-integrity.js";
import { spendBlockCode, spendCheckConfig } from "../db/spend-check.js";
import {
  DopplerFigureRejection, disposeDopplerFigureSet, dopplerFolderKey, downloadDopplerImagesDir, readDopplerFigureDir, storeDopplerFigureIndex,
  storeDopplerFigures, storeDopplerFolderManifests, type DopplerFigureSet, type DopplerFigureStorage, type DopplerFolderReader,
} from "../extractors/doppler-figures.js";
import { parseSandboxedPdfFigureOutcome, type FigureResumeJob } from "../extractors/plugins.js";
import { buildAllocatedResourceObservation, buildLocalComputeUsageEvent, resolveWorkerDeploymentProfile } from "../pipeline/local-compute-cost.js";

type Client = Sql<Record<string, unknown>>;

/** The figure part of the provider (SandboxedPdfExtractorProvider.figures.resume), or a fake in tests. */
export interface FigureResumeProvider {
  resume(job: FigureResumeJob, signal?: AbortSignal): Promise<unknown>;
  timeoutMs(pages: number): number;
}

export type FigureResumeStorage = Omit<DopplerFigureStorage, "openStream"> & DopplerFolderReader & FigureObjectReader & {
  bucket?: string;
  downloadToTempFile(key: string, pattern: string): Promise<string>;
  listKeys?(options: { prefix: string; maxKeys?: number }): Promise<{ keys: string[]; truncated: boolean }>;
  headObject?(key: string): Promise<{ size: number; lastModified: Date | null } | null>;
};

export interface FigureResumeDeps {
  sql: Client;
  storage: FigureResumeStorage;
  provider: FigureResumeProvider | null;
  workerId: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
}

export const FIGURE_RESUME_METRIC = "doppler-figures-resume-vm";
/** The claim's first lease; each unit extends it to its own VM budget (heartbeat). */
const CLAIM_LEASE_MS = 10 * 60_000;

interface ClaimedLevel {
  document_id: string; org_id: string; project_id: string; run_id: string; user_id: string; page_count: number;
  source_sha256: string | null; shards: number; resumes: number; manifest_sha256: string | null; storage_prefix: string | null;
  pipeline: unknown; run_pipeline: unknown; resume_vm_launches: number; gap_count: number;
  /** Measured resume VM time, resumes in a row without progress, and request grants of this run (migration 0161). */
  resume_vm_ms: number; resume_stalls: number; resume_grants: number;
  /** This claim's lease token (`<worker>:<uuid>`): every later runner write is fenced by it (R2 adversarial 5). */
  lease: string;
}

/**
 * A document's resume budget for its current run (packages/shared figure-resume-limits.ts): lifetime launches and VM time
 * scaled by its pages (plus what request grants added), and the no-progress stop. A new run resets the counters.
 */
export function documentResumeBudget(
  row: { page_count: number; shards: number; gap_count: number; resume_grants: number },
  env: Record<string, string | undefined> = process.env,
): { launchCap: number; vmBudgetMs: number; noProgressLimit: number } {
  const config = figureResumeBudgetConfig(env);
  return {
    launchCap: launchCapFor({ pageCount: row.page_count, units: row.shards + row.gap_count, grants: row.resume_grants }, config),
    // Per launch, the pages a resume actually converts (M2): one shard, or every page of an unsharded document.
    vmBudgetMs: figureResumeVmBudgetMs({ pageCount: row.page_count, shards: row.shards, grants: row.resume_grants }, config),
    noProgressLimit: config.noProgressLimit,
  };
}

/** Which budget stop a document is past, if any: launches, measured VM time (with a minute to spare), or no progress. */
export function resumeBudgetBlock(
  row: { page_count: number; shards: number; gap_count: number; resume_grants: number; resume_vm_launches: number; resume_vm_ms: number; resume_stalls: number },
  env: Record<string, string | undefined> = process.env,
): "attempts" | "vm-budget" | "no-progress" | null {
  const budget = documentResumeBudget(row, env);
  if (row.resume_stalls >= budget.noProgressLimit) return "no-progress";
  if (row.resume_vm_launches >= budget.launchCap) return "attempts";
  if (budget.vmBudgetMs - row.resume_vm_ms < MIN_LAUNCH_MS) return "vm-budget";
  return null;
}
/** The shortest launch the runner starts (a resume VM's timeout floor). */
const MIN_LAUNCH_MS = 60_000;

/** The budget's numbers for a block's log line (counts only, never document content). */
function budgetDetail(
  row: { page_count: number; shards: number; gap_count: number; resume_grants: number; resume_vm_launches: number; resume_vm_ms: number; resume_stalls: number },
  env: Record<string, string | undefined>,
): string {
  const budget = documentResumeBudget(row, env);
  return ` pages=${row.page_count} launches=${row.resume_vm_launches}/${budget.launchCap} vmMs=${Math.round(row.resume_vm_ms)}/${budget.vmBudgetMs}`
    + ` stalls=${row.resume_stalls}/${budget.noProgressLimit} grants=${row.resume_grants}`;
}

/** The figures of documents the queue may claim: completed, current run, Markdown committed (M1, PII rule). */
function claimableSql(sql: Client) {
  return sql`l.resume_after is not null and l.resume_after <= now() and l.resume_blocked is null
    and l.images_status = 'resumable' and l.assets_current and l.markdown_complete
    and d.status = 'completed' and d.superseded_at is null and d.archived_at is null and d.purged_at is null
    and (l.resume_lease_until is null or l.resume_lease_until < now())`;
}

async function block(tx: Client, row: Pick<ClaimedLevel, "document_id" | "org_id">, reason: FigureResumeBlockReason, detail = ""): Promise<void> {
  await tx`update document_extraction_levels set resume_after = null, resume_blocked = ${reason}, resume_blocked_at = now()
    where document_id = ${row.document_id} and org_id = ${row.org_id}`;
  console.log(`[doppler-figures] resume capped doc=${row.document_id} reason=${reason}${detail}`);
  recordFigureTelemetry("resume.capped", 1, { reason });
}

/**
 * Claim the next due document, or null. One transaction: the oldest due document of each organization with no live
 * lease (`distinct on`), oldest first; each candidate re-locked (`skip locked`) and re-checked, a per-org advisory lock and
 * live-lease check (at most one resume per organization), then the gates and the lease.
 */
export async function claimFigureResume(sql: Client, workerId: string, env: Record<string, string | undefined> = process.env): Promise<ClaimedLevel | null> {
  return await sql.begin(async (tx) => {
    // A fleet-wide ceiling on resumes running at once (every worker runs the runner), counted under one lock so concurrent
    // claims never overshoot it (R2-L2).
    await tx`select pg_advisory_xact_lock(hashtext('figure-resume-global'))`;
    const [live] = await tx<{ n: number }[]>`select count(*)::int as n from document_extraction_levels where resume_lease_until > now()`;
    if ((live?.n ?? 0) >= figureResumeGlobalMax(env)) return null;
    const candidates = await tx<ClaimedLevel[]>`
      select c.* from (
        select distinct on (l.org_id) l.document_id, l.org_id, l.project_id, l.run_id, d.user_id, d.page_count, l.source_sha256,
          l.shards, l.resumes, l.manifest_sha256, r.storage_prefix, p.pipeline, r.pipeline as run_pipeline, l.resume_vm_launches, l.resume_after,
          l.resume_vm_ms::float8 as resume_vm_ms, l.resume_stalls, l.resume_grants,
          coalesce(jsonb_array_length(l.gaps), 0)::int as gap_count
        from document_extraction_levels l
        join documents d on d.id = l.document_id and d.org_id = l.org_id and d.project_id = l.project_id and d.run_id = l.run_id
        join projects p on p.id = l.project_id and p.org_id = l.org_id
        join organizations o on o.id = l.org_id and o.deleted_at is null
        left join project_runs r on r.id = l.run_id
        where ${claimableSql(tx as unknown as Client)}
          and not exists (select 1 from document_extraction_levels b where b.org_id = l.org_id and b.resume_lease_until > now())
        order by l.org_id, l.resume_after, l.document_id
      ) c
      order by c.resume_after, c.document_id
      limit 16`;
    for (const row of candidates) {
      const [locked] = await tx<{ ok: number }[]>`
        select 1 as ok from document_extraction_levels l
        join documents d on d.id = l.document_id and d.org_id = l.org_id and d.run_id = l.run_id
        where l.document_id = ${row.document_id} and l.org_id = ${row.org_id} and l.run_id = ${row.run_id} and ${claimableSql(tx as unknown as Client)}
        for update of l skip locked`;
      if (!locked) continue;
      const [org] = await tx<{ ok: boolean }[]>`select pg_try_advisory_xact_lock(hashtext(${`figure-resume-org:${row.org_id}`})) as ok`;
      if (!org?.ok) continue;
      const [busy] = await tx<{ n: number }[]>`
        select count(*)::int as n from document_extraction_levels where org_id = ${row.org_id} and resume_lease_until > now()`;
      if ((busy?.n ?? 0) > 0) continue;
      // #363 H2: the project or the run opted out of figures: the level closes `disabled` (never resumable again, nothing
      // served, counted or billed from it; the retention GC collects what was stored) and leaves the queue.
      if (projectFiguresOff(row.pipeline) || projectFiguresOff(row.run_pipeline)) {
        await tx`update document_extraction_levels set images_status = 'disabled', assets_current = false, gaps = null,
            assets_total = 0, assets_extracted = 0, assets_not_extracted = 0, assets_unlinked = 0, assets_resumable = 0, assets_pending = 0,
            source_copy = 0, source_decode = 0, source_render = 0, asset_bytes = 0, folder_bytes = 0, updated_at = now()
          where document_id = ${row.document_id} and org_id = ${row.org_id} and run_id = ${row.run_id}`;
        await block(tx as unknown as Client, row, "figures-off");
        continue;
      }
      if (projectFigureResumeMode(row.pipeline) === "off") { await block(tx as unknown as Client, row, "resume-off"); continue; }
      // The document's own budget (page-scaled launches and VM time, the no-progress stop): blocked, counted and logged
      // with its numbers; a request may grant an extension, a reprocess clears it.
      const spent = resumeBudgetBlock(row, env);
      if (spent) { await block(tx as unknown as Client, row, spent, budgetDetail(row, env)); continue; }
      // A resume adds billable stored bytes: never for an organization that may not spend now (re-queued later).
      const [spend] = await tx<Array<{ funded: boolean | null; available: string | number; project_budget_paused: boolean; org_budget_paused: boolean; project_in_org: boolean }>>`
        select funded, available, project_budget_paused, org_budget_paused, project_in_org from org_spend_status(${row.org_id}, ${row.project_id}::text, 0)`;
      if (spendCheckConfig().enabled && spendBlockCode(spend ? { ...spend, org_id: row.org_id } : spend)) {
        await tx`update document_extraction_levels set resume_after = now() + interval '1 hour' where document_id = ${row.document_id} and org_id = ${row.org_id}`;
        console.log(`[doppler-figures] resume deferred doc=${row.document_id} reason=spend-paused`);
        recordFigureTelemetry("resume.deferred", 1, { reason: "spend-paused" });
        continue;
      }
      // Resume VM time is ours: each organization gets a daily budget (UTC); past it, the next day.
      const [today] = await tx<{ vm_ms: number }[]>`
        select (vm_ms + reserved_ms)::float8 as vm_ms from figure_resume_org_days where org_id = ${row.org_id} and day = (now() at time zone 'utc')::date`;
      if ((today?.vm_ms ?? 0) >= figureResumeOrgDailyVmMs(env)) {
        await tx`update document_extraction_levels
          set resume_after = ((now() at time zone 'utc')::date + 1)::timestamp at time zone 'utc' + interval '5 minutes'
          where document_id = ${row.document_id} and org_id = ${row.org_id}`;
        console.log(`[doppler-figures] resume deferred doc=${row.document_id} org=${row.org_id} reason=org-daily-vm-budget`);
        recordFigureTelemetry("resume.deferred", 1, { reason: "org-daily-vm-budget" });
        continue;
      }
      const lease = `${workerId.slice(0, 80)}:${randomUUID()}`;
      await tx`
        update document_extraction_levels set resume_lease_until = now() + ${`${CLAIM_LEASE_MS} milliseconds`}::interval,
          resume_lease_owner = ${lease}
        where document_id = ${row.document_id} and org_id = ${row.org_id} and run_id = ${row.run_id}`;
      return { ...row, lease };
    }
    return null;
  });
}

/**
 * Every runner write after the claim matches this claim's lease token and run (M2, R2 adversarial 5): a lost lease, a
 * second lane of the same worker, or a new run makes it a no-op.
 */
function fenced(sql: Client, row: ClaimedLevel) {
  return sql`document_id = ${row.document_id} and org_id = ${row.org_id} and run_id = ${row.run_id} and resume_lease_owner = ${row.lease}`;
}

/** Extend the lease; false when it is no longer ours (stop, touch nothing). */
async function heartbeat(sql: Client, row: ClaimedLevel, ms: number): Promise<boolean> {
  const extended = await sql`
    update document_extraction_levels set resume_lease_until = now() + ${`${Math.max(60_000, Math.round(ms))} milliseconds`}::interval
    where ${fenced(sql, row)} returning 1`;
  return extended.length === 1;
}
/** How often a running unit renews its lease, and how far ahead (R2-L3). */
const HEARTBEAT_EVERY_MS = 2 * 60_000;
const HEARTBEAT_LEASE_MS = 10 * 60_000;

type Outcome = "done" | "retry" | "blocked" | "lost" | "deferred";

/**
 * Release a lease (fenced): `done` re-queues at once while the document is still resumable (the next unit); `retry` counts
 * a failure and backs off; the document is blocked `attempts` once failures reach the cap, the lifetime VM launches reach
 * theirs, or nothing runnable is left (H1). A lease that is no longer ours, or a level that moved to another run, is left
 * untouched.
 */
async function release(
  sql: Client, row: ClaimedLevel, outcome: Exclude<Outcome, "lost">, blocked?: string, exhausted = false, unitKey?: string,
  progress: { launched: boolean; progressed: boolean; otherUnits: number } = { launched: false, progressed: false, otherUnits: 0 },
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  const [level] = await sql<{ images_status: string; resume_failures: number; resume_vm_launches: number; resume_unit_failures: Record<string, number>; resume_unit_stalls: Record<string, number>; shards: number; gap_count: number; resume_vm_ms: number; resume_stalls: number; resume_grants: number }[]>`
    select images_status, resume_failures, resume_vm_launches, resume_unit_failures, resume_unit_stalls, shards, coalesce(jsonb_array_length(gaps), 0)::int as gap_count,
      resume_vm_ms::float8 as resume_vm_ms, resume_stalls, resume_grants
    from document_extraction_levels where ${fenced(sql, row)}`;
  if (!level) return;
  const config = figureResumeBudgetConfig(env);
  // Failures and no-progress resumes count per unit (R2-M3, H1): one failing shard never blocks the others.
  const retry = outcome === "retry";
  const unitFailures = { ...(level.resume_unit_failures ?? {}) };
  if (retry && unitKey) unitFailures[unitKey] = (unitFailures[unitKey] ?? 0) + 1;
  const unitStalls = { ...(level.resume_unit_stalls ?? {}) };
  if (progress.launched && unitKey) unitStalls[unitKey] = progress.progressed ? 0 : (unitStalls[unitKey] ?? 0) + 1;
  // This resume closed its unit (its own failure or no-progress limit): with other units open, that is the document
  // moving on, not stalling (H1), so it resets the document's count.
  const closedUnit = !!unitKey && progress.launched && !progress.progressed && progress.otherUnits > 0 && (
    (unitFailures[unitKey] ?? 0) >= figureResumeUnitStrikeLimit(FIGURE_RESUME_LIMITS.maxAttempts, level.resume_grants)
    || (unitStalls[unitKey] ?? 0) >= figureResumeUnitStrikeLimit(config.noProgressLimit, level.resume_grants));
  // The document's no-progress count (R3-L3 follow-up, L1): launched resumes in a row, across units, whose gain is under
  // the minimum (figureResumeProgressed), failed ones included. Units are taken fewest strikes first, so consecutive
  // stalls land on different units: N in a row means every open unit stalls (a systemic fault), not one poisoned unit.
  const stalls = !progress.launched ? level.resume_stalls : progress.progressed || closedUnit ? 0 : level.resume_stalls + 1;
  if (closedUnit) {
    console.log(`[doppler-figures] resume unit-closed doc=${row.document_id} unit=${unitKey} failures=${unitFailures[unitKey!] ?? 0} stalls=${unitStalls[unitKey!] ?? 0} others=${progress.otherUnits}`);
    // The limit that actually closed it, with grants (r2 L2).
    const byFailures = (unitFailures[unitKey!] ?? 0) >= figureResumeUnitStrikeLimit(FIGURE_RESUME_LIMITS.maxAttempts, level.resume_grants);
    recordFigureTelemetry("resume.unit_closed", 1, { reason: byFailures ? "failures" : "no-progress" });
  }
  const failures = level.resume_failures + (retry ? 1 : 0);
  const resumable = level.images_status === "resumable";
  const budgetStop = resumeBudgetBlock({ ...level, page_count: row.page_count, resume_stalls: stalls }, env);
  const nextBlocked = outcome === "blocked" ? blocked ?? "refused" : resumable && exhausted ? "attempts" : resumable ? budgetStop : null;
  const after = !resumable || nextBlocked ? null
    : outcome === "done" ? new Date().toISOString()
    // Past the organization's daily resume VM budget: the next UTC day, no failure counted.
    : outcome === "deferred" ? new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1, 0, 5)).toISOString()
    : new Date(Date.now() + figureResumeBackoffMs(unitKey ? unitFailures[unitKey] ?? failures : failures)).toISOString();
  await sql`
    update document_extraction_levels set resume_lease_until = null, resume_lease_owner = null, resume_failures = ${failures},
      resume_unit_failures = ${sql.json(unitFailures)}::jsonb, resume_unit_stalls = ${sql.json(unitStalls)}::jsonb, resume_stalls = ${stalls},
      resume_after = ${after}::timestamptz, resume_blocked = coalesce(${nextBlocked}, resume_blocked),
      resume_blocked_at = case when ${nextBlocked}::text is null then resume_blocked_at else now() end
    where ${fenced(sql, row)}`;
  if (nextBlocked) {
    const detail = budgetDetail({ ...level, page_count: row.page_count, resume_stalls: stalls }, env);
    console.log(`[doppler-figures] resume capped doc=${row.document_id} reason=${nextBlocked}${detail}`);
    recordFigureTelemetry("resume.capped", 1, { reason: nextBlocked });
  }
}

type ResumeUnit = {
  shard: { first: number; last: number } | null; manifestSha256: string | null; gap: boolean;
  /** A shard resume narrowed to an inner gap's pages (`--images-resume-pages`, FigureResumeJob.resumePages). */
  resumePages?: [number, number];
  /** The unit's key for per-unit failure counts: `<first>-<last>`, or `doc`. */
  key: string;
};

/**
 * The runnable units of a claimed document, each one range, below its resume caps (figureResumeUnitCap per unit, scaled
 * by its pages; the document's launch cap across its shards) and below 3 failures of its own (R2-M3):
 *   - every resumable shard of the claimed run (its manifest);
 *   - every gap no shard covers (a fresh pass over its pages becomes its shard);
 *   - a gap inside a shard that is not complete (e.g. a gap resume's own inner gaps, R2 adversarial 8): that shard's resume
 *     narrowed to the gap's pages, unless the shard is already a unit;
 *   - or the unsharded document itself.
 */
async function units(sql: Client, row: ClaimedLevel, env: Record<string, string | undefined> = process.env): Promise<ResumeUnit[]> {
  const [level] = await sql<{ gaps: Array<{ first: number; last: number }> | null; resumes: number; assets_resumable: number; manifest_sha256: string | null; shards: number; resume_unit_failures: Record<string, number> | null; resume_unit_stalls: Record<string, number> | null; resume_grants: number }[]>`
    select gaps, resumes, assets_resumable, manifest_sha256, shards, resume_unit_failures, resume_unit_stalls, resume_grants from document_extraction_levels
    where document_id = ${row.document_id} and org_id = ${row.org_id} and project_id = ${row.project_id} and run_id = ${row.run_id}`;
  if (!level) return [];
  const failed = level.resume_unit_failures ?? {};
  const stalled = level.resume_unit_stalls ?? {};
  const grants = level.resume_grants ?? row.resume_grants;
  const noProgressLimit = figureResumeBudgetConfig(env).noProgressLimit;
  // A unit is open below its own failure and no-progress limits (H1); a grant raises both, never clears them.
  const open = (key: string) => (failed[key] ?? 0) < figureResumeUnitStrikeLimit(FIGURE_RESUME_LIMITS.maxAttempts, grants)
    && (stalled[key] ?? 0) < figureResumeUnitStrikeLimit(noProgressLimit, grants);
  // Each unit's resumes scale with the passes its share needs (figureResumeUnitCap, M1); the document's across its shards
  // with the launch cap.
  const unitCap = (first: number, last: number) => figureResumeUnitCap({ unitPages: last - first + 1, documentPages: row.page_count, grants });
  const shards = await sql<Array<{ first_page: number; last_page: number; manifest_sha256: string; resumes: number; images_status: string }>>`
    select first_page, last_page, manifest_sha256, resumes, images_status from document_extraction_shards
    where document_id = ${row.document_id} and org_id = ${row.org_id} and project_id = ${row.project_id}
    order by first_page`;
  const out: ResumeUnit[] = [];
  const docCap = figureResumeUnitCap({ unitPages: row.page_count, documentPages: row.page_count, whole: true, grants });
  if (shards.length === 0 && level.manifest_sha256 && level.resumes < docCap && level.assets_resumable > 0 && open("doc")) {
    out.push({ shard: null, manifestSha256: level.manifest_sha256, gap: false, key: "doc" });
  }
  const total = shards.reduce((sum, shard) => sum + shard.resumes, 0);
  const totalOpen = total < documentResumeBudget({ ...row, shards: Math.max(1, shards.length) }, env).launchCap;
  if (totalOpen) {
    const keyOfRange = (first: number, last: number) => `${first}-${last}`;
    for (const shard of shards) {
      const key = keyOfRange(shard.first_page, shard.last_page);
      if (shard.images_status === "resumable" && shard.resumes < unitCap(shard.first_page, shard.last_page) && open(key)) {
        out.push({ shard: { first: shard.first_page, last: shard.last_page }, manifestSha256: shard.manifest_sha256, gap: false, key });
      }
    }
    for (const gap of level.gaps ?? []) {
      const owner = shards.find((shard) => shard.first_page <= gap.last && gap.first <= shard.last_page);
      if (!owner) {
        const key = keyOfRange(gap.first, gap.last);
        if (open(key)) out.push({ shard: { first: gap.first, last: gap.last }, manifestSha256: null, gap: true, key });
        continue;
      }
      // Covered by a complete shard: no work. Inside a shard that is not complete: that shard's narrowed resume.
      if (owner.images_status === "complete" || owner.resumes >= unitCap(owner.first_page, owner.last_page)) continue;
      const shardKey = keyOfRange(owner.first_page, owner.last_page);
      if (out.some((unit) => unit.key === shardKey) || !open(shardKey)) continue;
      out.push({
        shard: { first: owner.first_page, last: owner.last_page }, manifestSha256: owner.manifest_sha256, gap: false, key: shardKey,
        resumePages: [Math.max(gap.first, owner.first_page), Math.min(gap.last, owner.last_page)],
      });
    }
  }
  // Fewest strikes (failures plus no-progress resumes) first, then page order (H1): a unit that keeps failing yields to
  // the others instead of being retried first every time.
  const strikes = (unit: ResumeUnit) => (failed[unit.key] ?? 0) + (stalled[unit.key] ?? 0);
  return out.sort((a, b) => strikes(a) - strikes(b) || (a.shard?.first ?? 0) - (b.shard?.first ?? 0));
}

/**
 * Claim and resume due documents until none is due (or `max`), with at most DOCSLURP_FIGURE_RESUME_CONCURRENCY at once.
 * Returns how many were processed. A no-op while DOCSLURP_FIGURE_RESUME or DOCSLURP_DOPPLER_IMAGE_EXTRACT is off, or the
 * provider cannot resume (requests stay queued; nothing is lost).
 */
export async function runFigureResumes(deps: FigureResumeDeps, max = 8): Promise<number> {
  const env = deps.env ?? process.env;
  if (!figureResumeDeployEnabled(env) || !dopplerImageExtractEnabled(env) || !deps.provider) return 0;
  let processed = 0;
  let drained = false;
  const lane = async () => {
    while (!drained && processed < max) {
      deps.signal?.throwIfAborted();
      const row = await claimFigureResume(deps.sql, deps.workerId, env);
      if (!row) { drained = true; return; }
      processed += 1;
      await resumeClaimed(deps, row);
    }
  };
  await Promise.all(Array.from({ length: figureResumeConcurrency(env) }, lane));
  return processed;
}

async function resumeClaimed(deps: FigureResumeDeps, row: ClaimedLevel): Promise<void> {
  const scope: DocumentAssetLedgerScope = { orgId: row.org_id, projectId: row.project_id, documentId: row.document_id, runId: row.run_id };
  const document = { id: row.document_id, userId: row.user_id, runId: row.run_id, artifactRoot: row.storage_prefix };
  const started = Date.now();
  let outcome: Outcome = "done";
  let blocked: string | undefined;
  let exhausted = false;
  let vmMs = 0;
  let added = 0;
  let addedBytes = 0;
  let unitKey: string | undefined;
  let before: { work: number; launches: number } | null = null;
  let otherUnits = 0;
  try {
    const adopted = await adoptPendingAssets(deps.sql, deps.storage, { scope, signal: deps.signal });
    if (adopted.adopted > 0) recordFigureTelemetry("adopted_files", adopted.adopted);
    // Slots a crash after an earlier unit's ledger commit left out (R2-L1).
    const repaired = await repairFigureSlots(deps.sql, deps.storage, scope).catch(() => 0);
    if (repaired > 0) recordFigureTelemetry("resume.slots_repaired", repaired);
    // PII: a document withheld whole (or whose outcome cannot be read) resumes nothing and leaves the queue; a unit whose
    // pages are all withheld is skipped; clean pages resume normally.
    const withholding = await documentPiiWithholding(deps.sql, row);
    if (withholding.scope === "document") {
      outcome = "blocked"; blocked = "refused";
      console.log(`[doppler-figures] resume skipped doc=${row.document_id} reason=pii-${withholding.reason}`);
      recordFigureTelemetry("resume.pii_skipped", 1, { scope: "document" });
      return;
    }
    const pageRange = (unit: ResumeUnit) => {
      const first = unit.shard?.first ?? 1;
      const last = unit.shard?.last ?? Math.max(1, row.page_count);
      return Array.from({ length: Math.min(last - first + 1, 100_000) }, (_, i) => first + i);
    };
    const all = await units(deps.sql, row, deps.env ?? process.env);
    const todo = withholding.scope === "pages" ? all.filter((unit) => !pageRange(unit).every((page) => isPageWithheld(withholding, page))) : all;
    if (todo.length < all.length) recordFigureTelemetry("resume.pii_skipped", all.length - todo.length, { scope: "pages" });
    console.log(`[doppler-figures] resume claim doc=${row.document_id} org=${row.org_id} launches=${row.resume_vm_launches} units=${todo.length} adopt=${adopted.adopted} lost=${adopted.lost}`);
    recordFigureTelemetry("resume.claimed", 1);
    const unit = todo[0];
    if (!unit) {
      // Nothing runnable (caps spent, or adopt finished it): never re-queued forever (H1).
      exhausted = true;
    } else {
      unitKey = unit.key;
      otherUnits = todo.length - 1;
      before = await remainingWork(deps.sql, row);
      const result = await resumeUnit(deps, row, scope, document, unit);
      vmMs = result.vmMs;
      added = result.added;
      addedBytes = result.addedBytes ?? 0;
      outcome = result.outcome;
      blocked = result.blocked;
    }
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    // A ledger refusal inside the upload step arrives wrapped (DopplerFigureStoreError's cause).
    const cause = (error as { cause?: unknown } | null)?.cause;
    const ruled = error instanceof DocumentAssetLedgerError || error instanceof DopplerFigureRejection ? error
      : cause instanceof DocumentAssetLedgerError || cause instanceof DopplerFigureRejection ? cause : null;
    const rule = ruled ? ruled.rule : error instanceof Error ? error.name : "error";
    // A reprocess or a newer run overtook this resume: a no-op, never a mix (the fenced release then touches nothing).
    if (rule === "stale-write" || rule === "scope-mismatch") { outcome = "blocked"; blocked = "stale"; }
    // A resume handing back other bytes for a stored image (a Doppler build change after a crash) can only repeat: refused
    // at once, never three more VMs (R2-L4).
    else if (rule === "resume-rewrite" || rule === "manifest-resume-rewrite") { outcome = "blocked"; blocked = "refused"; }
    else outcome = "retry";
    console.warn(`[doppler-figures] resume ${outcome === "blocked" ? "stale" : "failed"} doc=${row.document_id} rule=${rule}`);
  } finally {
    if (outcome !== "lost") {
      // Progress (L1): work closed (a unit, a gap, resumable images settled) or files added, at least the minimum gain
      // (figureResumeProgressed: a share of the work left, and real bytes for files). Only a resume that launched a VM
      // (its launch counted, whatever happened after) counts toward the no-progress stop.
      const after = before ? await remainingWork(deps.sql, row).catch(() => before) : null;
      const launched = !!before && !!after && after.launches > before.launches;
      const progressed = !!before && !!after
        && figureResumeProgressed({ before: before.work, after: after.work, added, addedBytes, units: Math.max(1, row.shards + row.gap_count) }, figureResumeBudgetConfig(deps.env ?? process.env));
      await release(deps.sql, row, outcome, blocked, exhausted, unitKey, { launched, progressed, otherUnits }, deps.env ?? process.env)
        .catch((error) => console.warn(`[doppler-figures] resume release-failed doc=${row.document_id} error=${error instanceof Error ? error.name : typeof error}`));
    }
  }
  // The attempt's own outcome (L1), never the level another writer left.
  const label = outcome === "done" ? (exhausted ? "exhausted" : "completed") : outcome === "blocked" ? (blocked === "stale" ? "stale" : "blocked")
    : outcome === "lost" ? "lease-lost" : outcome === "deferred" ? "deferred" : "failed";
  console.log(`[doppler-figures] resume done doc=${row.document_id} outcome=${label} added=${added} vmMs=${vmMs} ms=${Date.now() - started}`);
  recordFigureTelemetry("resume.attempts", 1, { outcome: label });
  if (added > 0) recordFigureTelemetry("resume.added_files", added);
}

/** The document's launches so far and its open figure work as one number: resumable images, gaps, and shards not complete with their resumable images. */
async function remainingWork(sql: Client, row: ClaimedLevel): Promise<{ work: number; launches: number }> {
  const [work] = await sql<{ n: number; launches: number }[]>`
    select l.resume_vm_launches as launches, (l.assets_resumable + coalesce(jsonb_array_length(l.gaps), 0)
      + coalesce((select sum(s.assets_resumable + case when s.images_status = 'complete' then 0 else 1 end)
        from document_extraction_shards s where s.document_id = l.document_id and s.org_id = l.org_id and s.project_id = l.project_id), 0))::float8 as n
    from document_extraction_levels l
    where l.document_id = ${row.document_id} and l.org_id = ${row.org_id} and l.project_id = ${row.project_id} and l.run_id = ${row.run_id}`;
  return { work: work?.n ?? 0, launches: work?.launches ?? 0 };
}

/**
 * Resume VM time is ours (the failure was ours): a cost-only event at its real allocated cost through the usage ledger,
 * `billable: false` (never a customer charge), plus the organization's daily total. Recorded for failed and timed-out
 * runs too.
 */
async function recordResumeVmTime(sql: Client, row: ClaimedLevel, wallTimeMs: number, outcome: string, reservedMs = 0): Promise<void> {
  const ms = Math.max(0, Math.round(wallTimeMs));
  // The real time joins the day's total and the launch's reservation is released (R2 adversarial 4).
  await sql`
    insert into figure_resume_org_days (org_id, day, launches, vm_ms) values (${row.org_id}, (now() at time zone 'utc')::date, 0, ${ms})
    on conflict (org_id, day) do update set vm_ms = figure_resume_org_days.vm_ms + excluded.vm_ms,
      reserved_ms = greatest(0, figure_resume_org_days.reserved_ms - ${Math.max(0, Math.round(reservedMs))})`;
  // And the document's lifetime VM budget, scoped to its run (not the lease: VM time a lost lease spent still counts).
  await sql`update document_extraction_levels set resume_vm_ms = resume_vm_ms + ${ms}
    where document_id = ${row.document_id} and org_id = ${row.org_id} and run_id = ${row.run_id}`;
  const profile = resolveWorkerDeploymentProfile();
  const event = buildLocalComputeUsageEvent({
    metric: FIGURE_RESUME_METRIC, profile, observation: buildAllocatedResourceObservation({ profile, wallTimeMs: ms }),
    costRollup: "authoritative",
    metadata: { stage: "figure-resume", scope: "document", documentId: row.document_id, measurement: "allocated-capacity", billable: false, outcome },
  });
  await persistScopedUsageEvents({ client: sql, userId: row.user_id, scope: { orgId: row.org_id, projectId: row.project_id }, usageEvents: [event] });
  recordFigureTelemetry("resume.vm_ms", ms, { outcome });
}

// ---- PII. piiWithholding and isPageWithheld are verbatim copies of feat/pii-page-scoped's
// packages/shared/src/pii-withholding.ts (same names, same semantics); whichever lands later dedupes to the shared ones. ----

export type PiiWithholding =
  | { scope: "none" }
  | { scope: "sections"; sectionCount: number }
  | { scope: "pages"; pages: ReadonlySet<number> }
  | { scope: "document"; reason: string };

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * The withholding recorded for a document. Fails closed: status `pii_blocked`, `pii.blocked`, an unknown scope or a
 * malformed page list all withhold the whole document.
 */
export function piiWithholding(document: { status?: string | null; metadata?: unknown }): PiiWithholding {
  if (document.status === "pii_blocked") return { scope: "document", reason: "pii-blocked" };
  const metadata = document.metadata;
  if (metadata === null || metadata === undefined) return { scope: "none" };
  if (typeof metadata !== "object" || Array.isArray(metadata)) return { scope: "document", reason: "malformed-metadata" };
  const pii = (metadata as { pii?: unknown }).pii;
  if (pii === null || pii === undefined) return { scope: "none" };
  if (typeof pii !== "object" || Array.isArray(pii)) return { scope: "document", reason: "malformed-metadata" };
  const record = pii as { blocked?: unknown; scope?: unknown; withheldPages?: unknown; withheldSectionCount?: unknown };
  if (record.blocked === true) return { scope: "document", reason: "pii-blocked" };
  switch (record.scope) {
    case undefined:
    case null:
    case "none":
      if (record.withheldPages !== undefined) return { scope: "document", reason: "malformed-metadata" };
      return { scope: "none" };
    case "pages": {
      const pages = record.withheldPages;
      if (!Array.isArray(pages) || pages.length === 0 || !pages.every(isPositiveInteger)) {
        return { scope: "document", reason: "malformed-metadata" };
      }
      return { scope: "pages", pages: new Set(pages) };
    }
    case "sections":
      return { scope: "sections", sectionCount: isPositiveInteger(record.withheldSectionCount) ? record.withheldSectionCount : 1 };
    case "document":
      return { scope: "document", reason: "pii-blocked" };
    default:
      return { scope: "document", reason: "unknown-scope" };
  }
}

/**
 * Whether a page (or any page of a hit spanning several) is withheld. A hit without a page on a document that
 * withholds pages is withheld: its text cannot be shown to come from a clean page.
 */
export function isPageWithheld(
  withholding: PiiWithholding,
  page: number | readonly (number | null | undefined)[] | null | undefined,
): boolean {
  if (withholding.scope === "document") return true;
  if (withholding.scope !== "pages") return false;
  const pages = Array.isArray(page) ? page : [page];
  const known = pages.filter(isPositiveInteger);
  if (known.length === 0 || known.length !== pages.length) return true;
  return known.some((value) => withholding.pages.has(value));
}

/**
 * What a figure resume may do under a document's PII outcome (R2 adversarial 1 and 7). Only a page-scoped outcome the
 * PII stage itself wrote (`scope: "pages"` with its page list) narrows withholding to pages. Anything else that withholds
 * artifacts is whole-document for a resume: a legacy outcome (no scope: `main`'s PII stage withholds every artifact under
 * `redact_artifacts`), `scope: "none"` or `"sections"` with `redacted`, `blocked` or a non-empty withheld list
 * (inconsistent metadata fails closed), and every `document` outcome. Never inferred from `pii_detections`, which records
 * only the primary source's matches.
 */
export function resumeWithholding(document: { status?: string | null; metadata?: unknown }): PiiWithholding {
  const withholding = piiWithholding(document);
  if (withholding.scope === "document" || withholding.scope === "pages") return withholding;
  const pii = (document.metadata as { pii?: unknown } | null | undefined)?.pii as { redacted?: unknown; blocked?: unknown; withheldArtifactUris?: unknown } | undefined;
  const listed = pii?.withheldArtifactUris;
  if (listed !== undefined && !Array.isArray(listed)) return { scope: "document", reason: "malformed-metadata" };
  if (withholding.scope === "sections") return { scope: "document", reason: "sections" };
  if (pii && (pii.redacted === true || pii.blocked === true || (Array.isArray(listed) && listed.length > 0))) {
    return { scope: "document", reason: "legacy-withholding" };
  }
  return { scope: "none" };
}

/** The claimed document's resume withholding (its status and metadata only). */
async function documentPiiWithholding(sql: Client, row: ClaimedLevel): Promise<PiiWithholding> {
  const [doc] = await sql<{ status: string; metadata: unknown }[]>`select status, metadata from documents where id = ${row.document_id} and org_id = ${row.org_id}`;
  if (!doc) return { scope: "document", reason: "missing" };
  return resumeWithholding({ status: doc.status, metadata: doc.metadata });
}

/** Add URIs to the document's withheld list (scoped by its organization); throws when the write did not land. */
async function withholdUris(sql: Client, row: ClaimedLevel, uris: readonly string[]): Promise<void> {
  if (uris.length === 0) return;
  const updated = await sql`
    update documents d
    set metadata = jsonb_set(d.metadata, '{pii,withheldArtifactUris}', (
          select coalesce(jsonb_agg(u order by u), '[]'::jsonb) from (
            select jsonb_array_elements_text(case when jsonb_typeof(d.metadata->'pii'->'withheldArtifactUris') = 'array'
              then d.metadata->'pii'->'withheldArtifactUris' else '[]'::jsonb end) as u
            union
            select unnest(${sql.array([...uris])}::text[])
          ) withheld), true),
        updated_at = now()
    where d.id = ${row.document_id} and d.org_id = ${row.org_id} and jsonb_typeof(d.metadata->'pii') = 'object'
    returning 1`;
  if (updated.length !== 1) throw new Error("PII withheld list not updated");
}

/** A provider's failure reason for the log: a fixed slug, else `other` (never provider free text; R2-L7). */
function reasonSlug(reason: unknown): string {
  return typeof reason === "string" && /^[a-z0-9:_-]{1,64}$/.test(reason) ? reason : "other";
}

async function resumeUnit(
  deps: FigureResumeDeps, claimed: ClaimedLevel, scope: DocumentAssetLedgerScope, document: { id: string; userId: string; runId: string; artifactRoot: string | null },
  unit: ResumeUnit,
): Promise<{ outcome: Outcome; blocked?: string; vmMs: number; added: number; addedBytes?: number }> {
  const row = claimed;
  if (!row.source_sha256) return { outcome: "blocked", blocked: "refused", vmMs: 0, added: 0 };
  // The bytes to convert are quarantine's decision for this document (R6-H1), resolved by the loader's own rule.
  const parse = await documentParseSource(deps.sql, { orgId: row.org_id, documentId: row.document_id, runId: row.run_id }, deps.env ?? process.env);
  if (!parse || parse.parseSourceDecision === "unscanned" || isUnscannedParseSourceKey(parse.sourceKey)) {
    // No decision from this build's quarantine (never scanned, refused, or rejected): no VM, blocked `unscanned` until a
    // reprocess (a new run) records a decision; no request clears it (counted; never a silent drop).
    console.warn(`[doppler-figures] resume refused doc=${row.document_id} reason=parse-source-unscanned`);
    recordFigureTelemetry("resume.parse_source_refused", 1, { reason: "unscanned" });
    return { outcome: "blocked", blocked: "unscanned", vmMs: 0, added: 0 };
  }
  // The figures were made from exactly these bytes: the level's source digest must be the decided parse source's hash.
  if (!parse.sourceSha256 || parse.sourceSha256 !== row.source_sha256) {
    console.warn(`[doppler-figures] resume refused doc=${row.document_id} reason=parse-source-mismatch`);
    recordFigureTelemetry("resume.parse_source_refused", 1, { reason: "mismatch" });
    return { outcome: "blocked", blocked: "refused", vmMs: 0, added: 0 };
  }
  // Every ledger write of this unit is fenced by the claim's lease token (R2 adversarial 5).
  const fencedScope: DocumentAssetLedgerScope = { ...scope, lease: row.lease };
  const asked = unit.resumePages ?? (unit.shard ? [unit.shard.first, unit.shard.last] as const : [1, row.page_count] as const);
  const pages = asked[1] - asked[0] + 1;
  // The launch's timeout is capped at what is left of the organization's daily resume VM budget (R2 adversarial 4).
  const [today] = await deps.sql<{ used: number }[]>`
    select (vm_ms + reserved_ms)::float8 as used from figure_resume_org_days where org_id = ${row.org_id} and day = (now() at time zone 'utc')::date`;
  const env = deps.env ?? process.env;
  const remaining = figureResumeOrgDailyVmMs(env) - (today?.used ?? 0);
  if (remaining < MIN_LAUNCH_MS) return { outcome: "deferred", vmMs: 0, added: 0 };
  // And at what is left of the document's own lifetime VM budget (page-scaled): under a minute, the document is spent.
  const budget = documentResumeBudget(row, env);
  const docRemaining = budget.vmBudgetMs - row.resume_vm_ms;
  if (docRemaining < MIN_LAUNCH_MS) return { outcome: "blocked", blocked: "vm-budget", vmMs: 0, added: 0 };
  const timeoutMs = Math.max(MIN_LAUNCH_MS, Math.min(deps.provider!.timeoutMs(pages), remaining, docRemaining));
  // Heartbeat: renewed every two minutes while this unit runs (R2-L3); a lease no longer ours aborts the unit.
  if (!await heartbeat(deps.sql, row, HEARTBEAT_LEASE_MS)) return { outcome: "lost", vmMs: 0, added: 0 };
  const lost = new AbortController();
  const beat = setInterval(() => {
    void heartbeat(deps.sql, row, HEARTBEAT_LEASE_MS).then((ok) => { if (!ok) lost.abort(); }, () => undefined);
  }, HEARTBEAT_EVERY_MS);
  beat.unref?.();
  const signal = deps.signal ? AbortSignal.any([deps.signal, lost.signal]) : lost.signal;
  const work = await mkdtemp(path.join(tmpdir(), "figure-resume-"));
  let source: string | null = null;
  try {
    // 1. The stored manifest only (none for a gap: a fresh pass over its pages).
    const manifestDir = path.join(work, "in");
    if (unit.manifestSha256) {
      await downloadDopplerImagesDir({
        storage: deps.storage, document, runId: row.run_id, manifestSha256: unit.manifestSha256, pageCount: row.page_count, dir: manifestDir,
        ...(unit.shard ? { shard: unit.shard } : {}), signal,
      });
    }
    // 2. The parse source quarantine decided (lib/parse-source.ts, R6-H1), never the upload: an encrypted PDF's scanned copy,
    //    or the upload exactly as the scan read it; hash-bound when staged (stageSourceFile). The provider stages it into a
    //    fresh VM (the host never parses it), counted before it starts and timed whatever happens.
    source = await stageSourceFile(deps.storage, { id: row.document_id, ...parse! }, "figure-resume-source-*.pdf");
    const outDir = path.join(work, "out");
    await mkdir(outDir, { mode: 0o700 });
    const counted = await deps.sql`
      update document_extraction_levels set resume_vm_launches = resume_vm_launches + 1
      where ${fenced(deps.sql, row)} and resume_vm_launches < ${budget.launchCap} returning 1`;
    if (counted.length !== 1) return { outcome: "lost", vmMs: 0, added: 0 };
    await deps.sql`
      insert into figure_resume_org_days (org_id, day, launches, vm_ms, reserved_ms) values (${row.org_id}, (now() at time zone 'utc')::date, 1, 0, ${timeoutMs})
      on conflict (org_id, day) do update set launches = figure_resume_org_days.launches + 1, reserved_ms = figure_resume_org_days.reserved_ms + ${timeoutMs}`;
    const vmStarted = Date.now();
    let wall = 0;
    let raw: unknown;
    let vmOutcome = "failed";
    try {
      raw = await deps.provider!.resume({
        input: source, sourceSha256: parse!.sourceSha256!, manifest: unit.manifestSha256 ? path.join(manifestDir, "manifest.jsonl") : null,
        pages: unit.shard ? [unit.shard.first, unit.shard.last] : null, resumePages: unit.resumePages ?? null, dir: outDir,
        limits: dopplerImageLimits(row.page_count), timeoutMs,
      }, signal);
      vmOutcome = "returned";
    } finally {
      wall = Date.now() - vmStarted;
      await recordResumeVmTime(deps.sql, row, wall, vmOutcome, timeoutMs)
        .catch((error) => console.warn(`[doppler-figures] resume vm-cost-unrecorded doc=${row.document_id} error=${error instanceof Error ? error.name : typeof error}`));
      // The measured pass against the budget's estimate (M3): what DOCSLURP_FIGURE_RESUME_VM_MS_PER_PAGE and _PER_LAUNCH are
      // tuned from before the runner is switched on.
      const config = figureResumeBudgetConfig(env);
      const estimateMs = figureResumeLaunchVmMs({ pageCount: row.page_count, shards: row.shards }, config);
      console.log(`[doppler-figures] resume pass doc=${row.document_id} pages=${pages} launchPages=${figureResumeLaunchPages({ pageCount: row.page_count, shards: row.shards })}`
        + ` vmMs=${wall} msPerPage=${(wall / Math.max(1, pages)).toFixed(1)} estimateMs=${estimateMs} outcome=${vmOutcome}`);
      recordFigureTelemetry("resume.pass_ms_per_page", Math.round(wall / Math.max(1, pages)), { outcome: vmOutcome });
    }
    const vmMs = wall;
    const outcome = parseSandboxedPdfFigureOutcome(raw, 500, row.page_count);
    if (outcome.status === "failed") {
      console.warn(`[doppler-figures] resume failed doc=${row.document_id} pages=${asked[0]}-${asked[1]} reason=${reasonSlug(outcome.reason)}`);
      return { outcome: "retry", vmMs, added: 0 };
    }
    // 3. Validated whole; stored images keep their digest and are never uploaded again.
    const stored = new Map((await deps.sql<{ asset_id: string; sha256: string }[]>`
      select asset_id, sha256 from document_assets where org_id = ${row.org_id} and project_id = ${row.project_id} and document_id = ${row.document_id}
        and run_id = ${row.run_id} and storage_state = 'stored'`).map((r) => [r.asset_id, r.sha256]));
    const set = await readDopplerFigureDir(outDir, {
      pageCount: row.page_count, signal, expect: outcome.status === "partial" ? "partial" : "complete", sourceSha256: row.source_sha256,
      // A range resume (a shard or a gap) is checked over its own pages (dopplerShardCoverage), with its declared gaps.
      gaps: outcome.gaps ?? null, ...(unit.shard ? { range: [unit.shard.first, unit.shard.last] as const } : {}),
      resume: { stored },
    });
    try {
      // The contract's shape, before anything is uploaded (R2-L5): a range resume publishes exactly one shard folder for
      // that range; an unsharded resume, one manifest and no shards.
      const shape = unit.shard
        ? set.manifests.length === 1 && set.manifests[0]!.range?.[0] === unit.shard.first && set.manifests[0]!.range?.[1] === unit.shard.last
        : set.manifests.length === 1 && set.manifests[0]!.range === null;
      if (!shape) {
        console.warn(`[doppler-figures] resume contract doc=${row.document_id} pages=${asked[0]}-${asked[1]} manifests=${set.manifests.length}`);
        return { outcome: "blocked", blocked: "refused", vmMs, added: 0 };
      }
      // PII (page-scoped): figures on a withheld page join the withheld list before any upload, so they are never served.
      // (They are still uploaded and not billed: the ledger records the folder whole. Ranges withheld whole are skipped.)
      const withheld = await documentPiiWithholding(deps.sql, row);
      if (withheld.scope === "document") return { outcome: "blocked", blocked: "refused", vmMs, added: 0 };
      if (withheld.scope === "pages") {
        const uris = set.files.filter((file) => isPageWithheld(withheld, parseDopplerFigureId(file.id)?.pageNumber ?? null))
          .map((file) => deps.storage.uri(dopplerFolderKey(document, row.run_id, { id: file.id, format: file.format })));
        await withholdUris(deps.sql, row, uris);
        if (uris.length > 0) recordFigureTelemetry("resume.pii_withheld_files", uris.length);
      }
      // The new manifest staged by content before any file (R2-L4): a crash anywhere later still finds it.
      await storeDopplerFolderManifests({ storage: deps.storage, set, document, runId: row.run_id, phase: "stage", signal });
      const ledger = figureLedgerHooks({ store: { markAssetsPending: (args) => markAssetsPending(deps.sql, args), markAssetsStored: (args) => markAssetsStored(deps.sql, args) }, run: { id: row.run_id, orgId: row.org_id, projectId: row.project_id } }, row.document_id, row.lease);
      // Figure files only: the folder's manifests, Markdown and index are never rewritten before the ledger commits.
      const result = await storeDopplerFigures({ storage: deps.storage, document, runId: row.run_id, figures: set, markdown: "", folderFiles: false, ...(ledger ? { ledger } : {}), signal });
      const pending = ledgerWriteForStoredFigures({ set, stored: result, outcome });
      await writeDocumentAssetLedger(deps.sql, {
        scope: fencedScope, level: { ...pending.level, markdownComplete: true }, assets: pending.assets,
        resume: unit.shard ? unit.shard : true, ...(pending.shards ? { shards: unit.shard ? pending.shards.filter((s) => s.first === unit.shard!.first) : pending.shards } : {}),
      });
      // After the commit: the manifests at their places, and (unsharded) the index with the stored Markdown's markers.
      await storeDopplerFolderManifests({ storage: deps.storage, set, document, runId: row.run_id, phase: "publish", signal });
      if (!unit.shard) await rebuildIndex(deps, set, document, row.run_id).catch((error) => console.warn(`[doppler-figures] resume index-not-rebuilt doc=${row.document_id} error=${error instanceof Error ? error.name : typeof error}`));
      // The new files are served: their slots join the document's run, only while this claim still holds the lease (a
      // crash here is repaired by the next claim or the audit: repairFigureSlots, R2-L1).
      const slots: Record<string, string> = {};
      for (const { slot, uri } of result.slots) if (slot.startsWith("doppler-figure:")) slots[`${row.document_id}:${slot}`] = uri;
      if (Object.keys(slots).length > 0) {
        await deps.sql`update project_runs set artifacts = coalesce(artifacts, '{}'::jsonb) || ${deps.sql.json(slots)}::jsonb
          where id = ${row.run_id} and org_id = ${row.org_id} and project_id = ${row.project_id}
            and exists (select 1 from document_extraction_levels l where ${fenced(deps.sql, row)})`;
      }
      console.log(`[doppler-figures] resume unit doc=${row.document_id} pages=${asked[0]}-${asked[1]}${unit.gap ? " gap" : ""} added=${result.stats.files} bytes=${result.stats.bytes} vmMs=${vmMs}`);
      return { outcome: "done", vmMs, added: result.stats.files, addedBytes: result.stats.bytes };
    } finally {
      await disposeDopplerFigureSet(set);
    }
  } catch (error) {
    // A lease lost mid-unit (heartbeat): nothing more is written; the new owner carries on.
    if (lost.signal.aborted && !deps.signal?.aborted) return { outcome: "lost", vmMs: 0, added: 0 };
    // The staged bytes are not the decided parse source (swapped object, the original of a scanned copy): refused, no VM.
    if (error instanceof SourceRefusalError) {
      console.warn(`[doppler-figures] resume refused doc=${row.document_id} reason=${error.name}`);
      recordFigureTelemetry("resume.parse_source_refused", 1, { reason: "integrity" });
      return { outcome: "blocked", blocked: "refused", vmMs: 0, added: 0 };
    }
    throw error;
  } finally {
    clearInterval(beat);
    if (source) await rm(source, { force: true }).catch(() => undefined);
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function rebuildIndex(deps: FigureResumeDeps, set: DopplerFigureSet, document: { id: string; userId: string; runId: string; artifactRoot: string | null }, runId: string): Promise<void> {
  let file: string | null = null;
  try {
    file = await deps.storage.downloadToTempFile(dopplerFolderKey(document, runId, "markdown"), "figure-resume-md-*.md");
    const markdown = await readFile(file, "utf8");
    await storeDopplerFigureIndex({ storage: deps.storage, set, document, runId, markdown, signal: deps.signal });
  } finally {
    if (file) await rm(file, { force: true }).catch(() => undefined);
  }
}


// ---- Orphan GC, retention and audit ----

/** Objects younger than this are never collected (an upload in flight writes its pending row first, but be generous). */
export const FIGURE_ORPHAN_GRACE_MS = 24 * 3600_000;
/** Figures of failed or cancelled documents are kept this long for a retry, then collected (M11). */
export const FIGURE_FAILED_RETENTION_MS = 7 * 24 * 3600_000;
/** Keys one listing may return: the largest folder (file caps plus manifests) with room; a longer one is skipped whole. */
const AUDIT_LIST_MAX = 40_000;
/** Stored rows HEAD-checked per document per pass. */
const AUDIT_HEAD_MAX = 2_000;
const FIGURE_FILE = /^page-[0-9]{4,10}\/(?:image|figure)-[0-9]{3,7}\.(?:webp|svg|png|jpg)$/;

export interface FigureAuditResult {
  documents: number; orphans: number; orphanBytes: number; expiredFiles: number; missing: number; sizeMismatch: number; adopted: number;
  skippedTruncated: number; skippedChanged: number; slotsRepaired: number; dryRun: { audit: boolean; gc: boolean };
}

interface AuditDoc {
  document_id: string; org_id: string; project_id: string; run_id: string | null; assets_current: boolean; doc_status: string;
  expired: boolean; manifest_key: string | null; level_at: string; user_id: string; storage_prefix: string | null;
}
/** Keys collected per locked transaction (R2-L9). */
const GC_BATCH = 500;

/**
 * The retention predicate (M11, R2-M4), one SQL fragment used for the selection and every re-check under the lock: a
 * failed, cancelled or `pii_blocked` document past FIGURE_FAILED_RETENTION_MS, or a level that is no longer current past
 * the grace period. `l` and `d` are the level and its document.
 */
function expiredSql(sql: Client, now: Date) {
  return sql`((d.status in ('failed', 'cancelled', 'pii_blocked') and d.updated_at < ${now}::timestamptz - ${`${FIGURE_FAILED_RETENTION_MS} milliseconds`}::interval)
    or (not l.assets_current and l.updated_at < ${now}::timestamptz - ${`${FIGURE_ORPHAN_GRACE_MS} milliseconds`}::interval))`;
}

/**
 * One pass over up to `limit` documents with figures, oldest audited first. The selection is exactly the partial index's
 * predicate (`asset_bytes > 0 or assets_pending > 0 or not assets_current`, R2-M1): documents whose figure step never ran
 * stay current with no bytes and are never in it. Per document:
 *   - adopt pending rows older than the grace period (no VM; M3);
 *   - re-add the figure slots of stored current rows a crash left without one (R2-L1);
 *   - list its folders whole (a truncated listing skips the document: never "absent" read as "missing", H2);
 *   - collect objects no row vouches for (page files only), or, for an expired document, every object of its folder, in
 *     batches, each under the document's ledger lock with the full retention predicate re-checked against the level and
 *     run that were selected (R2-H1): a document retried, reprocessed or revived meanwhile is left alone;
 *   - for an expired document whose objects are all gone, drop only the rows whose objects were collected, close the level
 *     (`none`, current, no bytes, no manifest: it leaves the audit set) and reset the run's extract-markdown checkpoint and
 *     figure slots, so a retry re-extracts instead of completing with dangling links (R2-H1 b);
 *   - confirm each current stored row with HEAD: a 404 or another size turns it into a resumable `aborted` image.
 * The ledger writes need DOCSLURP_FIGURE_AUDIT and the deletes DOCSLURP_FIGURE_GC_DELETE (dry runs by default, M7).
 */
export async function auditFigureStorage(deps: { sql: Client; storage: FigureResumeStorage; limit?: number; now?: Date; env?: Record<string, string | undefined> }): Promise<FigureAuditResult> {
  const env = deps.env ?? process.env;
  const writes = figureAuditWrites(env);
  const deletes = figureGcDeletes(env);
  const result: FigureAuditResult = {
    documents: 0, orphans: 0, orphanBytes: 0, expiredFiles: 0, missing: 0, sizeMismatch: 0, adopted: 0, skippedTruncated: 0,
    skippedChanged: 0, slotsRepaired: 0, dryRun: { audit: !writes, gc: !deletes },
  };
  if (!deps.storage.listKeys) return result;
  const now = deps.now ?? new Date();
  const documents = await deps.sql<AuditDoc[]>`
    select l.document_id, l.org_id, l.project_id, l.run_id, l.assets_current, d.status as doc_status, l.manifest_key, l.updated_at::text as level_at,
      d.user_id, r.storage_prefix, ${expiredSql(deps.sql, now)} as expired
    from (
      select * from document_extraction_levels
      where asset_bytes > 0 or assets_pending > 0 or not assets_current
      order by audited_at nulls first, document_id
      limit ${Math.min(Math.max(deps.limit ?? 50, 1), 500)}
    ) l
    join documents d on d.id = l.document_id and d.org_id = l.org_id
    left join project_runs r on r.id = l.run_id
    order by l.audited_at nulls first, l.document_id`;
  for (const doc of documents) {
    result.documents += 1;
    await deps.sql`update document_extraction_levels set audited_at = now() where document_id = ${doc.document_id} and org_id = ${doc.org_id}`;
    await auditDocument(deps, doc, now, writes, deletes, result).catch((error) => {
      console.warn(`[figure-audit] doc=${doc.document_id} failed error=${error instanceof Error ? error.name : typeof error}`);
    });
  }
  // Housekeeping (R2-L10): the per-org daily resume budget rows older than five weeks.
  if (writes) await deps.sql`delete from figure_resume_org_days where day < (now() at time zone 'utc')::date - 35`.catch(() => undefined);
  recordFigureTelemetry("gc.orphan_files", result.orphans, { mode: deletes ? "delete" : "dry-run" });
  recordFigureTelemetry("gc.orphan_bytes", result.orphanBytes, { mode: deletes ? "delete" : "dry-run" }, "counter", "By");
  recordFigureTelemetry("gc.expired_files", result.expiredFiles, { mode: deletes ? "delete" : "dry-run" });
  recordFigureTelemetry("audit.ledger_storage_drift", result.missing + result.sizeMismatch, { mode: writes ? "write" : "dry-run" });
  recordFigureTelemetry("audit.adopted_files", result.adopted);
  recordFigureTelemetry("audit.skipped_truncated", result.skippedTruncated);
  recordFigureTelemetry("audit.skipped_changed", result.skippedChanged);
  recordFigureTelemetry("audit.slots_repaired", result.slotsRepaired);
  return result;
}

/** Under the document's ledger lock: is the level still the one selected (same run, untouched) and does the rule still hold? */
async function stillAsSelected(tx: Client, doc: AuditDoc, now: Date, expired: boolean): Promise<boolean> {
  const [row] = await tx<{ ok: boolean }[]>`
    select (l.run_id is not distinct from ${doc.run_id} and l.updated_at::text = ${doc.level_at}
      and ${expired ? expiredSql(tx, now) : tx`true`}) as ok
    from document_extraction_levels l join documents d on d.id = l.document_id and d.org_id = l.org_id
    where l.document_id = ${doc.document_id} and l.org_id = ${doc.org_id}`;
  return !!row?.ok;
}

async function auditDocument(
  deps: { sql: Client; storage: FigureResumeStorage }, doc: AuditDoc, now: Date, writes: boolean, deletes: boolean, result: FigureAuditResult,
): Promise<void> {
  const scope = doc.run_id ? { orgId: doc.org_id, projectId: doc.project_id, documentId: doc.document_id, runId: doc.run_id } : null;
  // 1. Pending rows a crash left on a level that is not queued (M3): adopted without a VM.
  if (scope && writes && !doc.expired) {
    const [aged] = await deps.sql<{ n: number }[]>`
      select count(*)::int as n from document_assets
      where document_id = ${doc.document_id} and org_id = ${doc.org_id} and run_id = ${doc.run_id} and storage_state = 'pending'
        and updated_at < ${now}::timestamptz - ${`${FIGURE_ORPHAN_GRACE_MS} milliseconds`}::interval`;
    if ((aged?.n ?? 0) > 0) {
      const adopted = await adoptPendingAssets(deps.sql, deps.storage, { scope }).catch((error) => {
        if (error instanceof DocumentAssetLedgerError) return null;
        throw error;
      });
      if (adopted) result.adopted += adopted.adopted;
    }
  }
  // 2. Slots a crash between a resume's ledger commit and its slot update left out (R2-L1).
  if (scope && writes && !doc.expired && doc.assets_current && doc.doc_status === "completed") {
    result.slotsRepaired += await repairFigureSlots(deps.sql, deps.storage, { documentId: doc.document_id, orgId: doc.org_id, projectId: doc.project_id, runId: doc.run_id! });
  }
  const rows = await deps.sql<Array<{ asset_id: string; storage_key: string; bytes: number; storage_state: string; run_id: string | null }>>`
    select asset_id, storage_key, bytes, storage_state, run_id from document_assets
    where document_id = ${doc.document_id} and org_id = ${doc.org_id} and storage_key is not null`;
  // 3. The document's folders (every root its rows or its level use), each strictly this document's own.
  const marker = `/${DOPPLER_STORE_LAYOUT.folder}/${doc.document_id}/`;
  const folders = new Set<string>();
  for (const key of [...rows.map((row) => row.storage_key), ...(doc.manifest_key ? [doc.manifest_key] : [])]) {
    const at = key.indexOf(marker);
    if (at > 0) folders.add(key.slice(0, at + marker.length));
  }
  const vouched = new Set(rows.map((row) => row.storage_key));
  const candidates: Array<{ key: string; size: number }> = [];
  let young = 0;
  for (const folder of folders) {
    const listed = await deps.storage.listKeys!({ prefix: folder, maxKeys: AUDIT_LIST_MAX });
    if (listed.truncated) {
      result.skippedTruncated += 1;
      console.warn(`[figure-audit] doc=${doc.document_id} listing truncated: skipped (no GC, no loss verdict)`);
      return;
    }
    for (const key of listed.keys) {
      const relative = key.slice(folder.length + DOPPLER_STORE_LAYOUT.imagesFolder.length);
      const figureFile = key.startsWith(`${folder}${DOPPLER_STORE_LAYOUT.imagesFolder}`) && FIGURE_FILE.test(relative);
      // Unexpired: only page files no row vouches for. Expired: every object of the document's folder.
      if (!doc.expired && (!figureFile || vouched.has(key))) continue;
      const head = deps.storage.headObject ? await deps.storage.headObject(key).catch(() => null) : null;
      if (!head || !head.lastModified || now.getTime() - head.lastModified.getTime() < FIGURE_ORPHAN_GRACE_MS) { young += 1; continue; }
      candidates.push({ key, size: head.size });
    }
  }
  // 4. Collect in batches, each under the ledger lock with the selection re-checked (R2-H1, R2-L9).
  for (let at = 0; at < candidates.length; at += GC_BATCH) {
    const batch = candidates.slice(at, at + GC_BATCH);
    const outcome = await deps.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext(${`document-assets:${doc.document_id}`}))`;
      if (!(await stillAsSelected(tx as unknown as Client, doc, now, doc.expired))) return { changed: true, collected: [] as typeof batch };
      // Unexpired: only keys no row vouches for now (an adopt or a same-run retry may have just accepted one).
      const vouching = doc.expired ? new Set<string>() : new Set((await tx<{ storage_key: string }[]>`
        select storage_key from document_assets where document_id = ${doc.document_id} and org_id = ${doc.org_id}
          and storage_key = any(${tx.array(batch.map((c) => c.key))}::text[])`).map((r) => r.storage_key));
      const collected = batch.filter((c) => !vouching.has(c.key));
      if (deletes && collected.length > 0) {
        await deps.storage.deleteKeys?.(collected.map((c) => c.key));
        // Only rows whose objects were just removed (an expired document's own rows; never another run's young ones).
        await tx`delete from document_assets where document_id = ${doc.document_id} and org_id = ${doc.org_id}
          and storage_key = any(${tx.array(collected.map((c) => c.key))}::text[])`;
      }
      return { changed: false, collected };
    });
    if (outcome.changed) {
      result.skippedChanged += 1;
      console.log(`[figure-audit] doc=${doc.document_id} changed since selection: left alone`);
      return;
    }
    for (const c of outcome.collected) {
      if (doc.expired) result.expiredFiles += 1;
      else { result.orphans += 1; result.orphanBytes += c.size; }
    }
  }
  if (doc.expired) {
    // Every object gone (none skipped as young): close the level and reset the run's checkpoint for this document.
    if (deletes && young === 0) await closeExpired(deps.sql, doc, now);
    console.log(`[figure-audit] doc=${doc.document_id} expired status=${doc.doc_status} current=${doc.assets_current} files=${result.expiredFiles} young=${young} mode=${deletes ? "delete" : "dry-run"}`);
    return;
  }
  // 5. Current stored rows: HEAD each (bounded); only a confirmed 404 or another size is a loss.
  if (!scope || !deps.storage.headObject) return;
  const lost: string[] = [];
  let checked = 0;
  for (const row of rows) {
    if (row.storage_state !== "stored" || row.run_id !== doc.run_id) continue;
    if (++checked > AUDIT_HEAD_MAX) break;
    const head = await deps.storage.headObject(row.storage_key).catch((error) => (isMissingObject(error) ? null : undefined));
    if (head === null) { lost.push(row.asset_id); result.missing += 1; }
    else if (head && head.size !== row.bytes) { lost.push(row.asset_id); result.sizeMismatch += 1; }
  }
  if (lost.length === 0) return;
  console.log(`[figure-audit] doc=${doc.document_id} lost=${lost.length} mode=${writes ? "write" : "dry-run"}`);
  if (!writes) return;
  try {
    await markAssetsLost(deps.sql, { scope, ids: lost });
    // Queued again, but never clearing a block (an `attempts` block stays; H2, adversarial 13).
    await deps.sql`update document_extraction_levels set resume_after = coalesce(resume_after, now())
      where document_id = ${doc.document_id} and org_id = ${doc.org_id} and images_status = 'resumable' and resume_blocked is null`;
  } catch (error) {
    if (!(error instanceof DocumentAssetLedgerError)) throw error;
  }
}

/**
 * An expired document whose figure objects are all collected, under the ledger lock and only if still as selected: its
 * remaining rows (none vouch for an object any more) are dropped, the level is closed (`none`, current, no counts, bytes
 * or manifest, off the queue: it leaves the audit set), and its run's extract-markdown checkpoint and figure slots are
 * reset, so "Retry failed documents" re-extracts instead of completing with links to deleted objects (R2-H1 b).
 */
async function closeExpired(sql: Client, doc: AuditDoc, now: Date): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`document-assets:${doc.document_id}`}))`;
    if (!(await stillAsSelected(tx as unknown as Client, doc, now, true))) return;
    await tx`delete from document_assets where document_id = ${doc.document_id} and org_id = ${doc.org_id}`;
    await tx`delete from document_extraction_shards where document_id = ${doc.document_id} and org_id = ${doc.org_id}`;
    await tx`update document_extraction_levels set images_status = 'none', assets_current = true, gaps = null, shards = 0,
        manifest_key = null, manifest_sha256 = null, assets_total = 0, assets_extracted = 0, assets_not_extracted = 0, assets_unlinked = 0,
        assets_resumable = 0, assets_pending = 0, source_copy = 0, source_decode = 0, source_render = 0, asset_bytes = 0, folder_bytes = 0,
        resume_after = null, updated_at = now()
      where document_id = ${doc.document_id} and org_id = ${doc.org_id}`;
    if (doc.run_id) {
      await tx`delete from document_run_stage_states where run_id = ${doc.run_id} and document_id = ${doc.document_id} and stage_name = 'extract-markdown'`;
      await tx`update project_runs set artifacts = (
          select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(coalesce(artifacts, '{}'::jsonb))
          where key not like ${`${doc.document_id}:doppler-%`})
        where id = ${doc.run_id} and org_id = ${doc.org_id}`;
    }
  });
}

/**
 * Re-add `<doc>:doppler-figure:<id>` slots for the stored rows of the current run that have none (a crash between a
 * resume's ledger commit and its slot update, R2-L1). Returns how many were added.
 */
export async function repairFigureSlots(sql: Client, storage: Pick<FigureResumeStorage, "uri">, scope: { documentId: string; orgId: string; projectId: string; runId: string }): Promise<number> {
  const rows = await sql<{ asset_id: string; storage_key: string; has: boolean }[]>`
    select a.asset_id, a.storage_key, coalesce(r.artifacts ? (${scope.documentId} || ':doppler-figure:' || a.asset_id), false) as has
    from document_assets a join project_runs r on r.id = a.run_id and r.org_id = a.org_id
    join document_extraction_levels l on l.document_id = a.document_id and l.org_id = a.org_id and l.run_id = a.run_id and l.assets_current
    where a.document_id = ${scope.documentId} and a.org_id = ${scope.orgId} and a.run_id = ${scope.runId}
      and a.storage_state = 'stored' and a.status = 'extracted'`;
  const missing: Record<string, string> = {};
  for (const row of rows) if (!row.has) missing[`${scope.documentId}:${dopplerFigureSlot(row.asset_id)}`] = storage.uri(row.storage_key);
  if (Object.keys(missing).length === 0) return 0;
  await sql`update project_runs set artifacts = coalesce(artifacts, '{}'::jsonb) || ${sql.json(missing)}::jsonb
    where id = ${scope.runId} and org_id = ${scope.orgId} and project_id = ${scope.projectId}`;
  return Object.keys(missing).length;
}

/** Backlog gauges for SigNoz: queued live documents and the oldest one's age (L3: dead documents are not counted). */
export async function figureResumeBacklog(sql: Client): Promise<{ queued: number; oldestAgeS: number }> {
  const [row] = await sql<{ queued: number; oldest: number | null }[]>`
    select count(*)::int as queued, extract(epoch from now() - min(l.resume_after))::float8 as oldest
    from document_extraction_levels l
    join documents d on d.id = l.document_id and d.org_id = l.org_id and d.run_id = l.run_id
    where l.resume_after is not null and l.resume_blocked is null and l.images_status = 'resumable'
      and d.status = 'completed' and d.superseded_at is null and d.archived_at is null and d.purged_at is null`;
  const backlog = { queued: row?.queued ?? 0, oldestAgeS: Math.max(0, Math.round(row?.oldest ?? 0)) };
  recordFigureTelemetry("resumable_backlog", backlog.queued, {}, "gauge");
  recordFigureTelemetry("resume_oldest_age_s", backlog.oldestAgeS, {}, "gauge", "s");
  return backlog;
}

export { dopplerFigureSlot, dopplerShardFolder };

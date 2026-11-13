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
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Sql } from "postgres";
import {
  DOPPLER_STORE_LAYOUT, dopplerFigureSlot, dopplerImageExtractEnabled, dopplerImageLimits, dopplerShardFolder, figureAuditWrites,
  figureGcDeletes, figureResumeBackoffMs, figureResumeConcurrency, figureResumeDeployEnabled, figureResumeGlobalMax, figureResumeOrgDailyVmMs,
  parseDopplerFigureId, projectFigureResumeMode, projectFiguresOff, FIGURE_RESUME_LIMITS,
} from "@docslurp/shared";
import { recordFigureTelemetry } from "@docslurp/shared/observability";

import {
  adoptPendingAssets, documentResumeTotalCap, figureLedgerHooks, isMissingObject, ledgerWriteForStoredFigures, markAssetsLost,
  markAssetsPending, markAssetsStored, writeDocumentAssetLedger, DocumentAssetLedgerError, DOCUMENT_ASSET_RESUME_CAP,
  type DocumentAssetLedgerScope, type FigureObjectReader,
} from "../db/document-asset-ledger.js";
import { persistScopedUsageEvents } from "../db/usage-event-store.js";
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
  document_id: string; org_id: string; project_id: string; run_id: string; user_id: string; page_count: number; source_key: string;
  source_sha256: string | null; shards: number; resumes: number; manifest_sha256: string | null; storage_prefix: string | null;
  pipeline: unknown; run_pipeline: unknown; resume_vm_launches: number;
}

/** The figures of documents the queue may claim: completed, current run, Markdown committed (M1, PII rule). */
function claimableSql(sql: Client) {
  return sql`l.resume_after is not null and l.resume_after <= now() and l.resume_blocked is null
    and l.images_status = 'resumable' and l.assets_current and l.markdown_complete
    and d.status = 'completed' and d.superseded_at is null and d.archived_at is null and d.purged_at is null
    and (l.resume_lease_until is null or l.resume_lease_until < now())`;
}

async function block(tx: Client, row: Pick<ClaimedLevel, "document_id" | "org_id">, reason: "attempts" | "figures-off" | "resume-off" | "stale" | "refused"): Promise<void> {
  await tx`update document_extraction_levels set resume_after = null, resume_blocked = ${reason} where document_id = ${row.document_id} and org_id = ${row.org_id}`;
  console.log(`[doppler-figures] resume capped doc=${row.document_id} reason=${reason}`);
  recordFigureTelemetry("resume.capped", 1, { reason });
}

/**
 * Claim the next due document, or null. One transaction: the oldest due document of each organization with no live
 * lease (`distinct on`), oldest first; each candidate re-locked (`skip locked`) and re-checked, a per-org advisory lock and
 * live-lease check (at most one resume per organization), then the gates and the lease.
 */
export async function claimFigureResume(sql: Client, workerId: string, env: Record<string, string | undefined> = process.env): Promise<ClaimedLevel | null> {
  return await sql.begin(async (tx) => {
    // A fleet-wide ceiling on resumes running at once (every worker runs the runner).
    const [live] = await tx<{ n: number }[]>`select count(*)::int as n from document_extraction_levels where resume_lease_until > now()`;
    if ((live?.n ?? 0) >= figureResumeGlobalMax(env)) return null;
    const candidates = await tx<ClaimedLevel[]>`
      select c.* from (
        select distinct on (l.org_id) l.document_id, l.org_id, l.project_id, l.run_id, d.user_id, d.page_count, d.source_key, l.source_sha256,
          l.shards, l.resumes, l.manifest_sha256, r.storage_prefix, p.pipeline, r.pipeline as run_pipeline, l.resume_vm_launches, l.resume_after
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
      if (row.resume_vm_launches >= FIGURE_RESUME_LIMITS.maxVmLaunches) { await block(tx as unknown as Client, row, "attempts"); continue; }
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
        select vm_ms::float8 as vm_ms from figure_resume_org_days where org_id = ${row.org_id} and day = (now() at time zone 'utc')::date`;
      if ((today?.vm_ms ?? 0) >= figureResumeOrgDailyVmMs(env)) {
        await tx`update document_extraction_levels
          set resume_after = ((now() at time zone 'utc')::date + 1)::timestamp at time zone 'utc' + interval '5 minutes'
          where document_id = ${row.document_id} and org_id = ${row.org_id}`;
        console.log(`[doppler-figures] resume deferred doc=${row.document_id} org=${row.org_id} reason=org-daily-vm-budget`);
        recordFigureTelemetry("resume.deferred", 1, { reason: "org-daily-vm-budget" });
        continue;
      }
      await tx`
        update document_extraction_levels set resume_lease_until = now() + ${`${CLAIM_LEASE_MS} milliseconds`}::interval,
          resume_lease_owner = ${workerId.slice(0, 128)}
        where document_id = ${row.document_id} and org_id = ${row.org_id} and run_id = ${row.run_id}`;
      return row;
    }
    return null;
  });
}

/** Every runner write after the claim matches its lease and run (M2): a lost lease or a new run makes it a no-op. */
function fenced(sql: Client, row: ClaimedLevel, workerId: string) {
  return sql`document_id = ${row.document_id} and org_id = ${row.org_id} and run_id = ${row.run_id} and resume_lease_owner = ${workerId.slice(0, 128)}`;
}

/** Extend the lease for the next unit; false when the lease is no longer ours (stop, touch nothing). */
async function heartbeat(sql: Client, row: ClaimedLevel, workerId: string, ms: number): Promise<boolean> {
  const extended = await sql`
    update document_extraction_levels set resume_lease_until = now() + ${`${Math.max(60_000, Math.round(ms))} milliseconds`}::interval
    where ${fenced(sql, row, workerId)} returning 1`;
  return extended.length === 1;
}

type Outcome = "done" | "retry" | "blocked" | "lost";

/**
 * Release a lease (fenced): `done` re-queues at once while the document is still resumable (the next unit); `retry` counts
 * a failure and backs off; the document is blocked `attempts` once failures reach the cap, the lifetime VM launches reach
 * theirs, or nothing runnable is left (H1). A lease that is no longer ours, or a level that moved to another run, is left
 * untouched.
 */
async function release(sql: Client, row: ClaimedLevel, workerId: string, outcome: Exclude<Outcome, "lost">, blocked?: string, exhausted = false): Promise<void> {
  const [level] = await sql<{ images_status: string; resume_failures: number; resume_vm_launches: number }[]>`
    select images_status, resume_failures, resume_vm_launches from document_extraction_levels where ${fenced(sql, row, workerId)}`;
  if (!level) return;
  const failures = level.resume_failures + (outcome === "retry" ? 1 : 0);
  const resumable = level.images_status === "resumable";
  const spent = failures >= FIGURE_RESUME_LIMITS.maxAttempts || level.resume_vm_launches >= FIGURE_RESUME_LIMITS.maxVmLaunches || exhausted;
  const nextBlocked = outcome === "blocked" ? blocked ?? "refused" : resumable && spent ? "attempts" : null;
  const after = !resumable || nextBlocked ? null
    : outcome === "done" ? new Date().toISOString()
    : new Date(Date.now() + figureResumeBackoffMs(failures)).toISOString();
  await sql`
    update document_extraction_levels set resume_lease_until = null, resume_lease_owner = null, resume_failures = ${failures},
      resume_after = ${after}::timestamptz, resume_blocked = coalesce(${nextBlocked}, resume_blocked)
    where ${fenced(sql, row, workerId)}`;
  if (nextBlocked) {
    console.log(`[doppler-figures] resume capped doc=${row.document_id} reason=${nextBlocked}`);
    recordFigureTelemetry("resume.capped", 1, { reason: nextBlocked });
  }
}

type ResumeUnit = { shard: { first: number; last: number } | null; manifestSha256: string | null; gap: boolean };

/**
 * The runnable units of a claimed document, each one range, below #355's caps: every resumable shard of the claimed run
 * under its own cap and the document's total (documentResumeTotalCap); every effective gap (no shard covers it; a fresh
 * pass over its pages becomes its shard) while the document's total is not spent; or the unsharded document itself.
 */
async function units(sql: Client, row: ClaimedLevel): Promise<ResumeUnit[]> {
  const [level] = await sql<{ gaps: Array<{ first: number; last: number }> | null; resumes: number; assets_resumable: number; manifest_sha256: string | null; shards: number }[]>`
    select gaps, resumes, assets_resumable, manifest_sha256, shards from document_extraction_levels
    where document_id = ${row.document_id} and org_id = ${row.org_id} and project_id = ${row.project_id} and run_id = ${row.run_id}`;
  if (!level) return [];
  const shards = await sql<Array<{ first_page: number; last_page: number; manifest_sha256: string; resumes: number; images_status: string }>>`
    select first_page, last_page, manifest_sha256, resumes, images_status from document_extraction_shards
    where document_id = ${row.document_id} and org_id = ${row.org_id} and project_id = ${row.project_id}
    order by first_page`;
  const out: ResumeUnit[] = [];
  if (shards.length === 0 && level.manifest_sha256 && level.resumes < DOCUMENT_ASSET_RESUME_CAP && level.assets_resumable > 0) {
    out.push({ shard: null, manifestSha256: level.manifest_sha256, gap: false });
  }
  const total = shards.reduce((sum, shard) => sum + shard.resumes, 0);
  const totalOpen = total < documentResumeTotalCap(Math.max(1, shards.length));
  if (totalOpen) {
    for (const shard of shards) {
      if (shard.images_status === "resumable" && shard.resumes < DOCUMENT_ASSET_RESUME_CAP) {
        out.push({ shard: { first: shard.first_page, last: shard.last_page }, manifestSha256: shard.manifest_sha256, gap: false });
      }
    }
    for (const gap of level.gaps ?? []) {
      if (shards.some((shard) => shard.first_page <= gap.last && gap.first <= shard.last_page)) continue;
      out.push({ shard: { first: gap.first, last: gap.last }, manifestSha256: null, gap: true });
    }
  }
  return out.sort((a, b) => (a.shard?.first ?? 0) - (b.shard?.first ?? 0));
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
  try {
    const adopted = await adoptPendingAssets(deps.sql, deps.storage, { scope, signal: deps.signal });
    if (adopted.adopted > 0) recordFigureTelemetry("adopted_files", adopted.adopted);
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
    const all = await units(deps.sql, row);
    const todo = withholding.scope === "pages" ? all.filter((unit) => !pageRange(unit).every((page) => isPageWithheld(withholding, page))) : all;
    if (todo.length < all.length) recordFigureTelemetry("resume.pii_skipped", all.length - todo.length, { scope: "pages" });
    console.log(`[doppler-figures] resume claim doc=${row.document_id} org=${row.org_id} launches=${row.resume_vm_launches} units=${todo.length} adopt=${adopted.adopted} lost=${adopted.lost}`);
    recordFigureTelemetry("resume.claimed", 1);
    const unit = todo[0];
    if (!unit) {
      // Nothing runnable (caps spent, or adopt finished it): never re-queued forever (H1).
      exhausted = true;
    } else {
      const result = await resumeUnit(deps, row, scope, document, unit);
      vmMs = result.vmMs;
      added = result.added;
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
    else outcome = "retry";
    console.warn(`[doppler-figures] resume ${outcome === "blocked" ? "stale" : "failed"} doc=${row.document_id} rule=${rule}`);
  } finally {
    if (outcome !== "lost") {
      await release(deps.sql, row, deps.workerId, outcome, blocked, exhausted)
        .catch((error) => console.warn(`[doppler-figures] resume release-failed doc=${row.document_id} error=${error instanceof Error ? error.name : typeof error}`));
    }
  }
  // The attempt's own outcome (L1), never the level another writer left.
  const label = outcome === "done" ? (exhausted ? "exhausted" : "completed") : outcome === "blocked" ? (blocked === "stale" ? "stale" : "blocked") : outcome === "lost" ? "lease-lost" : "failed";
  console.log(`[doppler-figures] resume done doc=${row.document_id} outcome=${label} added=${added} vmMs=${vmMs} ms=${Date.now() - started}`);
  recordFigureTelemetry("resume.attempts", 1, { outcome: label });
  if (added > 0) recordFigureTelemetry("resume.added_files", added);
}

/**
 * Resume VM time is ours (the failure was ours): a cost-only event at its real allocated cost through the usage ledger,
 * `billable: false` (never a customer charge), plus the organization's daily total. Recorded for failed and timed-out
 * runs too.
 */
async function recordResumeVmTime(sql: Client, row: ClaimedLevel, wallTimeMs: number, outcome: string): Promise<void> {
  const ms = Math.max(0, Math.round(wallTimeMs));
  await sql`
    insert into figure_resume_org_days (org_id, day, launches, vm_ms) values (${row.org_id}, (now() at time zone 'utc')::date, 0, ${ms})
    on conflict (org_id, day) do update set vm_ms = figure_resume_org_days.vm_ms + excluded.vm_ms`;
  const profile = resolveWorkerDeploymentProfile();
  const event = buildLocalComputeUsageEvent({
    metric: FIGURE_RESUME_METRIC, profile, observation: buildAllocatedResourceObservation({ profile, wallTimeMs: ms }),
    costRollup: "authoritative",
    metadata: { stage: "figure-resume", scope: "document", documentId: row.document_id, measurement: "allocated-capacity", billable: false, outcome },
  });
  await persistScopedUsageEvents({ client: sql, userId: row.user_id, scope: { orgId: row.org_id, projectId: row.project_id }, usageEvents: [event] });
  recordFigureTelemetry("resume.vm_ms", ms, { outcome });
}

// ---- PII (page-scoped). Local until feat/pii-page-scoped lands: the same names and semantics as its
// packages/shared/src/pii-withholding.ts (piiWithholding, isPageWithheld); whichever lands later dedupes. ----

export type PiiWithholding = { scope: "none" } | { scope: "document"; reason: string } | { scope: "pages"; pages: Set<number> };

/**
 * A document's PII withholding from its status and metadata, failing closed: status `pii_blocked`, `pii.blocked`, or a
 * malformed `metadata.pii` is `document`. `pii.scope = "pages"` with its page list is `pages`; a page-scoped outcome whose
 * pages cannot be read is `document`. A legacy outcome (no scope) that withholds anything takes its pages from the run's
 * `pii_detections` (`detectedPages`), or is `document` when they are missing or unpaged.
 */
export function piiWithholding(args: { status: string | null | undefined; metadata: unknown; detectedPages?: ReadonlyArray<number | null> }): PiiWithholding {
  if (args.status === "pii_blocked") return { scope: "document", reason: "pii_blocked" };
  const metadata = args.metadata as { pii?: unknown } | null | undefined;
  if (metadata !== null && metadata !== undefined && typeof metadata !== "object") return { scope: "document", reason: "malformed" };
  const pii = metadata?.pii;
  if (pii === undefined || pii === null) return { scope: "none" };
  if (typeof pii !== "object" || Array.isArray(pii)) return { scope: "document", reason: "malformed" };
  const value = pii as { blocked?: unknown; redacted?: unknown; scope?: unknown; pages?: unknown; withheldPages?: unknown; withheldArtifactUris?: unknown };
  if (value.blocked === true) return { scope: "document", reason: "blocked" };
  const pageList = (list: unknown): Set<number> | null =>
    Array.isArray(list) && list.every((n) => Number.isSafeInteger(n) && (n as number) >= 1) ? new Set(list as number[]) : null;
  if (value.scope === "document") return { scope: "document", reason: "document" };
  if (value.scope === "pages") {
    const pages = pageList(value.pages ?? value.withheldPages);
    return pages ? { scope: "pages", pages } : { scope: "document", reason: "unreadable-pages" };
  }
  if (value.scope !== undefined && value.scope !== "none") return { scope: "document", reason: "malformed" };
  const uris = value.withheldArtifactUris;
  if (uris !== undefined && !Array.isArray(uris)) return { scope: "document", reason: "malformed" };
  const withholds = value.redacted === true || (Array.isArray(uris) && uris.length > 0);
  if (!withholds || value.scope === "none") return { scope: "none" };
  const detected = args.detectedPages ?? [];
  if (detected.length === 0 || detected.some((page) => page === null)) return { scope: "document", reason: "unpaged" };
  return { scope: "pages", pages: new Set(detected as number[]) };
}

/** Whether a page (or any of several) is withheld; `document` always; a null or unknown page whenever any page is. */
export function isPageWithheld(withholding: PiiWithholding, page: number | readonly number[] | null): boolean {
  if (withholding.scope === "none") return false;
  if (withholding.scope === "document") return true;
  if (page === null) return withholding.pages.size > 0;
  const pages = typeof page === "number" ? [page] : page;
  if (pages.length === 0) return withholding.pages.size > 0;
  return pages.some((n) => !Number.isSafeInteger(n) || withholding.pages.has(n));
}

/** The claimed document's withholding (its status, metadata and, for a legacy outcome, its run's detections). */
async function documentPiiWithholding(sql: Client, row: ClaimedLevel): Promise<PiiWithholding> {
  const [doc] = await sql<{ status: string; metadata: unknown }[]>`select status, metadata from documents where id = ${row.document_id} and org_id = ${row.org_id}`;
  if (!doc) return { scope: "document", reason: "missing" };
  const first = piiWithholding({ status: doc.status, metadata: doc.metadata });
  if (first.scope !== "document" || first.reason !== "unpaged") return first;
  const detections = await sql<{ page_number: number | null }[]>`
    select distinct page_number from pii_detections where document_id = ${row.document_id} and run_id = ${row.run_id}`;
  return piiWithholding({ status: doc.status, metadata: doc.metadata, detectedPages: detections.map((d) => d.page_number) });
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

async function resumeUnit(
  deps: FigureResumeDeps, row: ClaimedLevel, scope: DocumentAssetLedgerScope, document: { id: string; userId: string; runId: string; artifactRoot: string | null },
  unit: ResumeUnit,
): Promise<{ outcome: Outcome; blocked?: string; vmMs: number; added: number }> {
  if (!row.source_sha256) return { outcome: "blocked", blocked: "refused", vmMs: 0, added: 0 };
  const pages = unit.shard ? unit.shard.last - unit.shard.first + 1 : row.page_count;
  const timeoutMs = deps.provider!.timeoutMs(pages);
  // Heartbeat: the lease covers this unit's VM budget, the download and the store (M2).
  if (!await heartbeat(deps.sql, row, deps.workerId, 2 * timeoutMs + 10 * 60_000)) return { outcome: "lost", vmMs: 0, added: 0 };
  const work = await mkdtemp(path.join(tmpdir(), "figure-resume-"));
  let source: string | null = null;
  try {
    // 1. The stored manifest only (none for a gap: a fresh pass over its pages).
    const manifestDir = path.join(work, "in");
    if (unit.manifestSha256) {
      await downloadDopplerImagesDir({
        storage: deps.storage, document, runId: row.run_id, manifestSha256: unit.manifestSha256, pageCount: row.page_count, dir: manifestDir,
        ...(unit.shard ? { shard: unit.shard } : {}), signal: deps.signal,
      });
    }
    // 2. The source (the provider stages it into its VM; the host never parses it) and a fresh VM, counted before it
    //    starts (lifetime, per organization per day) and timed whatever happens.
    const sourceKey = deps.storage.bucket ? keyOf(row.source_key, deps.storage.bucket) : row.source_key;
    source = await deps.storage.downloadToTempFile(sourceKey, "figure-resume-source-*.pdf");
    const outDir = path.join(work, "out");
    await mkdir(outDir, { mode: 0o700 });
    const counted = await deps.sql`
      update document_extraction_levels set resume_vm_launches = resume_vm_launches + 1
      where ${fenced(deps.sql, row, deps.workerId)} and resume_vm_launches < ${FIGURE_RESUME_LIMITS.maxVmLaunches} returning 1`;
    if (counted.length !== 1) return { outcome: "lost", vmMs: 0, added: 0 };
    await deps.sql`
      insert into figure_resume_org_days (org_id, day, launches, vm_ms) values (${row.org_id}, (now() at time zone 'utc')::date, 1, 0)
      on conflict (org_id, day) do update set launches = figure_resume_org_days.launches + 1`;
    const vmStarted = Date.now();
    let raw: unknown;
    let vmOutcome = "failed";
    try {
      raw = await deps.provider!.resume({
        input: source, sourceSha256: row.source_sha256, manifest: unit.manifestSha256 ? path.join(manifestDir, "manifest.jsonl") : null,
        pages: unit.shard ? [unit.shard.first, unit.shard.last] : null, resumePages: null, dir: outDir, limits: dopplerImageLimits(row.page_count), timeoutMs,
      }, deps.signal);
      vmOutcome = "returned";
    } finally {
      await recordResumeVmTime(deps.sql, row, Date.now() - vmStarted, vmOutcome)
        .catch((error) => console.warn(`[doppler-figures] resume vm-cost-unrecorded doc=${row.document_id} error=${error instanceof Error ? error.name : typeof error}`));
    }
    const vmMs = Date.now() - vmStarted;
    const outcome = parseSandboxedPdfFigureOutcome(raw, 500, row.page_count);
    if (outcome.status === "failed") {
      console.warn(`[doppler-figures] resume failed doc=${row.document_id} pages=${unit.shard ? `${unit.shard.first}-${unit.shard.last}` : "all"} reason=${JSON.stringify(outcome.reason)}`);
      return { outcome: "retry", vmMs, added: 0 };
    }
    // 3. Validated whole; stored images keep their digest and are never uploaded again.
    const stored = new Map((await deps.sql<{ asset_id: string; sha256: string }[]>`
      select asset_id, sha256 from document_assets where org_id = ${row.org_id} and project_id = ${row.project_id} and document_id = ${row.document_id}
        and run_id = ${row.run_id} and storage_state = 'stored'`).map((r) => [r.asset_id, r.sha256]));
    const set = await readDopplerFigureDir(outDir, {
      pageCount: row.page_count, signal: deps.signal, expect: outcome.status === "partial" ? "partial" : "complete", sourceSha256: row.source_sha256,
      // A range resume (a shard or a gap) returns only its own range: the pages before it are not this folder's, so they
      // count as covered for the contiguity rule (reader only; never written to the ledger).
      gaps: [...(unit.shard && unit.shard.first > 1 ? [{ first: 1, last: unit.shard.first - 1, reason: "other" as const }] : []), ...(outcome.gaps ?? [])],
      resume: { stored },
    });
    try {
      // PII (page-scoped): figures on a withheld page join the withheld list before any upload, so they are never served.
      // (They are still uploaded: the ledger records the folder whole. The unit filter above skips ranges withheld whole.)
      const withheld = await documentPiiWithholding(deps.sql, row);
      if (withheld.scope === "document") return { outcome: "blocked", blocked: "refused", vmMs, added: 0 };
      if (withheld.scope === "pages") {
        const uris = set.files.filter((file) => isPageWithheld(withheld, parseDopplerFigureId(file.id)?.pageNumber ?? null))
          .map((file) => deps.storage.uri(dopplerFolderKey(document, row.run_id, { id: file.id, format: file.format })));
        await withholdUris(deps.sql, row, uris);
        if (uris.length > 0) recordFigureTelemetry("resume.pii_withheld_files", uris.length);
      }
      const ledger = figureLedgerHooks({ store: { markAssetsPending: (args) => markAssetsPending(deps.sql, args), markAssetsStored: (args) => markAssetsStored(deps.sql, args) }, run: { id: row.run_id, orgId: row.org_id, projectId: row.project_id } }, row.document_id);
      // Figure files only: the folder's manifests, Markdown and index are never rewritten before the ledger commits.
      const result = await storeDopplerFigures({ storage: deps.storage, document, runId: row.run_id, figures: set, markdown: "", folderFiles: false, ...(ledger ? { ledger } : {}), signal: deps.signal });
      // The new manifest staged by content first: a crash after the commit still finds it (downloadDopplerImagesDir).
      await storeDopplerFolderManifests({ storage: deps.storage, set, document, runId: row.run_id, phase: "stage", signal: deps.signal });
      const pending = ledgerWriteForStoredFigures({ set, stored: result, outcome });
      await writeDocumentAssetLedger(deps.sql, {
        scope, level: { ...pending.level, markdownComplete: true }, assets: pending.assets,
        resume: unit.shard ? unit.shard : true, ...(pending.shards ? { shards: unit.shard ? pending.shards.filter((s) => s.first === unit.shard!.first) : pending.shards } : {}),
      });
      // After the commit: the manifests at their places, and (unsharded) the index with the stored Markdown's markers.
      await storeDopplerFolderManifests({ storage: deps.storage, set, document, runId: row.run_id, phase: "publish", signal: deps.signal });
      if (!unit.shard) await rebuildIndex(deps, set, document, row.run_id).catch((error) => console.warn(`[doppler-figures] resume index-not-rebuilt doc=${row.document_id} error=${error instanceof Error ? error.name : typeof error}`));
      // The new files are served: their slots join the document's run (fenced by the lease, scoped by org and project).
      const slots: Record<string, string> = {};
      for (const { slot, uri } of result.slots) if (slot.startsWith("doppler-figure:")) slots[`${row.document_id}:${slot}`] = uri;
      if (Object.keys(slots).length > 0) {
        await deps.sql`update project_runs set artifacts = coalesce(artifacts, '{}'::jsonb) || ${deps.sql.json(slots)}::jsonb
          where id = ${row.run_id} and org_id = ${row.org_id} and project_id = ${row.project_id}`;
      }
      console.log(`[doppler-figures] resume unit doc=${row.document_id} pages=${unit.shard ? `${unit.shard.first}-${unit.shard.last}` : "all"}${unit.gap ? " gap" : ""} added=${result.stats.files} bytes=${result.stats.bytes} vmMs=${vmMs}`);
      return { outcome: "done", vmMs, added: result.stats.files };
    } finally {
      await disposeDopplerFigureSet(set);
    }
  } finally {
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

function keyOf(sourceKey: string, bucket: string): string {
  const prefix = `s3://${bucket}/`;
  return sourceKey.startsWith(prefix) ? sourceKey.slice(prefix.length) : sourceKey;
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
  skippedTruncated: number; dryRun: { audit: boolean; gc: boolean };
}

interface AuditDoc {
  document_id: string; org_id: string; project_id: string; run_id: string | null; assets_current: boolean; doc_status: string;
  expired: boolean; manifest_key: string | null;
}

/**
 * One pass over up to `limit` documents with figure rows or objects, oldest audited first (`audited_at`). Per document:
 *   - adopt pending rows older than the grace period (no VM; M3);
 *   - list its folders whole (a truncated listing skips the document: never "absent" read as "missing", H2);
 *   - collect objects no row vouches for (page files only), or every object of an expired document (failed or cancelled
 *     past FIGURE_FAILED_RETENTION_MS, or a level no longer current past the grace period; M11), each re-checked under the
 *     document's ledger lock right before its delete (H2);
 *   - confirm each current stored row with HEAD: a 404 or another size turns it into a resumable `aborted` image (queued,
 *     never clearing an `attempts` block).
 * The ledger writes need DOCSLURP_FIGURE_AUDIT and the deletes DOCSLURP_FIGURE_GC_DELETE; otherwise logged and measured
 * only (M7).
 */
export async function auditFigureStorage(deps: { sql: Client; storage: FigureResumeStorage; limit?: number; now?: Date; env?: Record<string, string | undefined> }): Promise<FigureAuditResult> {
  const env = deps.env ?? process.env;
  const writes = figureAuditWrites(env);
  const deletes = figureGcDeletes(env);
  const result: FigureAuditResult = {
    documents: 0, orphans: 0, orphanBytes: 0, expiredFiles: 0, missing: 0, sizeMismatch: 0, adopted: 0, skippedTruncated: 0,
    dryRun: { audit: !writes, gc: !deletes },
  };
  if (!deps.storage.listKeys) return result;
  const now = deps.now ?? new Date();
  const documents = await deps.sql<AuditDoc[]>`
    select l.document_id, l.org_id, l.project_id, l.run_id, l.assets_current, d.status as doc_status, l.manifest_key,
      ((d.status in ('failed', 'cancelled') and d.updated_at < ${now}::timestamptz - ${`${FIGURE_FAILED_RETENTION_MS} milliseconds`}::interval)
        or (not l.assets_current and l.updated_at < ${now}::timestamptz - ${`${FIGURE_ORPHAN_GRACE_MS} milliseconds`}::interval)) as expired
    from document_extraction_levels l
    join documents d on d.id = l.document_id and d.org_id = l.org_id
    where l.asset_bytes > 0 or l.assets_pending > 0 or not l.assets_current
      or exists (select 1 from document_assets a where a.document_id = l.document_id and a.org_id = l.org_id and a.storage_key is not null)
    order by l.audited_at nulls first, l.document_id
    limit ${Math.min(Math.max(deps.limit ?? 50, 1), 500)}`;
  for (const doc of documents) {
    result.documents += 1;
    await deps.sql`update document_extraction_levels set audited_at = now() where document_id = ${doc.document_id} and org_id = ${doc.org_id}`;
    await auditDocument(deps, doc, now, writes, deletes, result).catch((error) => {
      console.warn(`[figure-audit] doc=${doc.document_id} failed error=${error instanceof Error ? error.name : typeof error}`);
    });
  }
  recordFigureTelemetry("gc.orphan_files", result.orphans, { mode: deletes ? "delete" : "dry-run" });
  recordFigureTelemetry("gc.orphan_bytes", result.orphanBytes, { mode: deletes ? "delete" : "dry-run" }, "counter", "By");
  recordFigureTelemetry("gc.expired_files", result.expiredFiles, { mode: deletes ? "delete" : "dry-run" });
  recordFigureTelemetry("audit.ledger_storage_drift", result.missing + result.sizeMismatch, { mode: writes ? "write" : "dry-run" });
  recordFigureTelemetry("audit.adopted_files", result.adopted);
  recordFigureTelemetry("audit.skipped_truncated", result.skippedTruncated);
  return result;
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
  const rows = await deps.sql<Array<{ asset_id: string; storage_key: string; bytes: number; storage_state: string; run_id: string | null }>>`
    select asset_id, storage_key, bytes, storage_state, run_id from document_assets
    where document_id = ${doc.document_id} and org_id = ${doc.org_id} and storage_key is not null`;
  // 2. The document's folders (every root its rows or its level use), each strictly this document's own.
  const marker = `/${DOPPLER_STORE_LAYOUT.folder}/${doc.document_id}/`;
  const folders = new Set<string>();
  for (const key of [...rows.map((row) => row.storage_key), ...(doc.manifest_key ? [doc.manifest_key] : [])]) {
    const at = key.indexOf(marker);
    if (at > 0) folders.add(key.slice(0, at + marker.length));
  }
  const vouched = new Set(rows.map((row) => row.storage_key));
  let truncated = false;
  for (const folder of folders) {
    const listed = await deps.storage.listKeys!({ prefix: folder, maxKeys: AUDIT_LIST_MAX });
    if (listed.truncated) { truncated = true; break; }
    for (const key of listed.keys) {
      const relative = key.slice(folder.length + DOPPLER_STORE_LAYOUT.imagesFolder.length);
      const figureFile = key.startsWith(`${folder}${DOPPLER_STORE_LAYOUT.imagesFolder}`) && FIGURE_FILE.test(relative);
      // Unexpired: only page files no row vouches for. Expired: every object of the document's folder.
      if (!doc.expired && (!figureFile || vouched.has(key))) continue;
      const head = deps.storage.headObject ? await deps.storage.headObject(key).catch(() => null) : null;
      if (!head || !head.lastModified || now.getTime() - head.lastModified.getTime() < FIGURE_ORPHAN_GRACE_MS) continue;
      if (await collectUnderLock(deps, doc, key, deletes)) {
        if (doc.expired) result.expiredFiles += 1;
        else { result.orphans += 1; result.orphanBytes += head.size; }
      }
    }
  }
  if (truncated) {
    result.skippedTruncated += 1;
    console.warn(`[figure-audit] doc=${doc.document_id} listing truncated: skipped (no GC, no loss verdict)`);
    return;
  }
  if (doc.expired) {
    // The rows of an expired document no longer vouch: removed once its objects are gone (deletes on only).
    if (deletes && rows.length > 0) {
      await deps.sql.begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext(${`document-assets:${doc.document_id}`}))`;
        await tx`delete from document_assets where document_id = ${doc.document_id} and org_id = ${doc.org_id}`;
        await tx`update document_extraction_levels set assets_current = false, asset_bytes = 0, folder_bytes = 0, resume_after = null
          where document_id = ${doc.document_id} and org_id = ${doc.org_id}`;
      });
    }
    console.log(`[figure-audit] doc=${doc.document_id} expired status=${doc.doc_status} current=${doc.assets_current} files=${result.expiredFiles} mode=${deletes ? "delete" : "dry-run"}`);
    return;
  }
  // 3. Current stored rows: HEAD each (bounded); only a confirmed 404 or another size is a loss.
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
 * Delete one object under the document's ledger lock (the lock every ledger writer takes), re-checking right before the
 * delete that no row vouches for it now (an adopt or a same-run retry may have just accepted it) or, for an expired
 * document, that it is still expired. True when collected (or would be, in a dry run).
 */
async function collectUnderLock(deps: { sql: Client; storage: FigureResumeStorage }, doc: AuditDoc, key: string, deletes: boolean): Promise<boolean> {
  return await deps.sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`document-assets:${doc.document_id}`}))`;
    if (doc.expired) {
      const [still] = await tx<{ ok: boolean }[]>`
        select (d.status in ('failed', 'cancelled') or not l.assets_current) as ok
        from document_extraction_levels l join documents d on d.id = l.document_id and d.org_id = l.org_id
        where l.document_id = ${doc.document_id} and l.org_id = ${doc.org_id}`;
      if (!still?.ok) return false;
    } else {
      const [vouch] = await tx`select 1 from document_assets where document_id = ${doc.document_id} and org_id = ${doc.org_id} and storage_key = ${key} limit 1`;
      if (vouch) return false;
    }
    if (deletes) await deps.storage.deleteKeys?.([key]);
    return true;
  });
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

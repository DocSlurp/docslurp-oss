/*
 * The figure resume runner (docs/extraction/doppler-figures.md, "Resuming partial figures"): finishes the images a figure
 * pass left resumable, and keeps storage and the ledger in agreement (orphan GC and audit).
 *
 * Claim: one document at a time per worker (`for update skip locked` on document_extraction_levels, migration 0144), at
 * most one per organization, only while DOCSLURP_FIGURE_RESUME is on, the project's `figureResume` is not `off` and its
 * figures are on, and the organization may spend (a resume adds billable stored bytes). Then, per resumable unit (the
 * document, or each resumable shard):
 *   1. adopt pending uploads a crashed attempt left (streamed SHA-256, no VM);
 *   2. if still resumable: the unit's stored manifest only (manifest-only resume: no figure goes back into the VM), the
 *      provider's `figures.resume` in a fresh VM, the folder validated whole (resume mode: stored images keep their
 *      digest), new files stored pending → stored with conditional creates, the ledger written as a resume (only adds,
 *      counted against the host's cap of 3), the new files' slots added to the document's run;
 *   3. the VM time recorded as a cost-only event (never a customer charge: the failure was ours).
 * Backoff 2 min, 15 min, 2 h; blocked after 3 resumes. The ledger's stale-write rule turns a resume that a reprocess
 * overtook into a no-op; the source and settings digests bind it to the same PDF and settings.
 *
 * Nothing here deletes a figure except the orphan GC: objects under a document's images folder that no ledger row of any
 * run vouches for, 24 hours after their last write. The audit turns a stored row whose object is missing or the wrong size
 * into a resumable `aborted` image and queues a resume.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Sql } from "postgres";
import {
  DOPPLER_STORE_LAYOUT, dopplerFigureSlot, dopplerImageLimits, dopplerShardFolder, figureResumeBackoffMs, figureResumeDeployEnabled,
  projectFigureResumeMode, FIGURE_RESUME_LIMITS,
} from "@docslurp/shared";

import {
  adoptPendingAssets, figureLedgerHooks, isMissingObject, ledgerWriteForStoredFigures, markAssetsLost, markAssetsPending, markAssetsStored,
  writeDocumentAssetLedger, DocumentAssetLedgerError, type DocumentAssetLedgerScope, type FigureObjectReader,
} from "../db/document-asset-ledger.js";
import { persistScopedUsageEvents } from "../db/usage-event-store.js";
import { spendBlockCode, spendCheckConfig } from "../db/spend-check.js";
import {
  DopplerFigureRejection, disposeDopplerFigureSet, downloadDopplerImagesDir, readDopplerFigureDir, storeDopplerFigures,
  type DopplerFigureStorage, type DopplerFolderReader,
} from "../extractors/doppler-figures.js";
import { parseSandboxedPdfFigureOutcome, type FigureResumeJob } from "../extractors/plugins.js";
import { pushPerfMetric } from "../lib/perf-context.js";
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
  /** Lease length (default 2 × the provider's budget for the document, at least 10 min). */
  leaseMs?: number;
  signal?: AbortSignal;
}

export const FIGURE_RESUME_METRIC = "doppler-figures-resume-vm";

interface ClaimedLevel {
  document_id: string; org_id: string; project_id: string; run_id: string; user_id: string; page_count: number; source_key: string;
  source_sha256: string | null; shards: number; resumes: number; manifest_sha256: string | null; storage_prefix: string | null;
  pipeline: unknown; artifact_root: string | null;
}

/**
 * Claim the next queued document, or null. One transaction: the candidate row locked (`skip locked`), then a per-org
 * advisory lock and a check that the org holds no live lease (at most one resume per organization), then the lease.
 * Documents whose project turned resume or figures off are blocked instead of claimed.
 */
export async function claimFigureResume(sql: Client, workerId: string, leaseMs: number): Promise<ClaimedLevel | null> {
  return await sql.begin(async (tx) => {
    const candidates = await tx<ClaimedLevel[]>`
      select l.document_id, l.org_id, l.project_id, l.run_id, d.user_id, d.page_count, d.source_key, l.source_sha256, l.shards, l.resumes,
        l.manifest_sha256, r.storage_prefix, p.pipeline, null::text as artifact_root
      from document_extraction_levels l
      join documents d on d.id = l.document_id and d.org_id = l.org_id and d.project_id = l.project_id and d.run_id = l.run_id
      join projects p on p.id = l.project_id and p.org_id = l.org_id
      join organizations o on o.id = l.org_id and o.deleted_at is null
      left join project_runs r on r.id = l.run_id
      where l.resume_after is not null and l.resume_after <= now() and l.resume_blocked is null
        and l.images_status = 'resumable' and l.assets_current
        and (l.resume_lease_until is null or l.resume_lease_until < now())
        and d.superseded_at is null and d.archived_at is null and d.purged_at is null
      order by l.resume_after, l.document_id
      limit 8
      for update of l skip locked`;
    for (const row of candidates) {
      if (projectFigureResumeMode(row.pipeline) === "off") {
        await tx`update document_extraction_levels set resume_after = null, resume_blocked = 'resume-off' where document_id = ${row.document_id} and org_id = ${row.org_id}`;
        continue;
      }
      const [locked] = await tx<{ ok: boolean }[]>`select pg_try_advisory_xact_lock(hashtext(${`figure-resume-org:${row.org_id}`})) as ok`;
      if (!locked?.ok) continue;
      const [busy] = await tx<{ n: number }[]>`
        select count(*)::int as n from document_extraction_levels
        where org_id = ${row.org_id} and resume_lease_until > now() and document_id <> ${row.document_id}`;
      if ((busy?.n ?? 0) > 0) continue;
      // A resume adds billable stored bytes: never for an organization that may not spend now (re-queued later).
      const [spend] = await tx<Array<{ funded: boolean | null; available: string | number; project_budget_paused: boolean; org_budget_paused: boolean; project_in_org: boolean }>>`
        select funded, available, project_budget_paused, org_budget_paused, project_in_org from org_spend_status(${row.org_id}, ${row.project_id}::text, 0)`;
      if (spendCheckConfig().enabled && spendBlockCode(spend ? { ...spend, org_id: row.org_id } : spend)) {
        await tx`update document_extraction_levels set resume_after = now() + interval '1 hour' where document_id = ${row.document_id} and org_id = ${row.org_id}`;
        console.log(`[doppler-figures] resume capped doc=${row.document_id} reason=spend-paused`);
        pushPerfMetric({ metric: "figures.resume.capped", value: 1, unit: "count", tags: ["doppler-figures", "spend-paused"], metadata: { documentId: row.document_id } });
        continue;
      }
      await tx`
        update document_extraction_levels set resume_lease_until = now() + ${`${Math.max(60_000, Math.round(leaseMs))} milliseconds`}::interval,
          resume_lease_owner = ${workerId.slice(0, 128)}
        where document_id = ${row.document_id} and org_id = ${row.org_id}`;
      return row;
    }
    return null;
  });
}

/** Release a lease: requeue with backoff, finish (nothing left), or block. */
async function release(sql: Client, row: ClaimedLevel, outcome: "done" | "retry" | "blocked", blocked?: string): Promise<void> {
  const [level] = await sql<{ resumes: number; images_status: string; resume_failures: number }[]>`
    select resumes, images_status, resume_failures from document_extraction_levels where document_id = ${row.document_id} and org_id = ${row.org_id}`;
  const failures = (level?.resume_failures ?? 0) + (outcome === "retry" ? 1 : 0);
  const resumes = Math.max(level?.resumes ?? row.resumes, failures);
  const spent = resumes >= FIGURE_RESUME_LIMITS.maxAttempts;
  const nextBlocked = outcome === "blocked" ? blocked ?? "refused" : outcome === "retry" && spent ? "attempts" : null;
  const after = outcome === "done" && level?.images_status !== "resumable" ? null
    : nextBlocked ? null
    : new Date(Date.now() + figureResumeBackoffMs(resumes)).toISOString();
  await sql`
    update document_extraction_levels set resume_lease_until = null, resume_lease_owner = null, resume_failures = ${failures},
      resume_after = ${after}::timestamptz, resume_blocked = coalesce(${nextBlocked}, resume_blocked)
    where document_id = ${row.document_id} and org_id = ${row.org_id} and resume_lease_owner is not null`;
  if (nextBlocked) console.log(`[doppler-figures] resume capped doc=${row.document_id} reason=${nextBlocked}`);
}

/** The resumable units of a claimed document: each resumable shard, or the document itself. */
async function units(sql: Client, row: ClaimedLevel): Promise<Array<{ shard: { first: number; last: number } | null; manifestSha256: string; resumes: number }>> {
  if (row.shards === 0) return row.manifest_sha256 && row.resumes < FIGURE_RESUME_LIMITS.maxAttempts ? [{ shard: null, manifestSha256: row.manifest_sha256, resumes: row.resumes }] : [];
  const shards = await sql<Array<{ first_page: number; last_page: number; manifest_sha256: string; resumes: number }>>`
    select first_page, last_page, manifest_sha256, resumes from document_extraction_shards
    where document_id = ${row.document_id} and org_id = ${row.org_id} and project_id = ${row.project_id} and run_id = ${row.run_id}
      and images_status = 'resumable' and resumes < ${FIGURE_RESUME_LIMITS.maxAttempts}
    order by first_page`;
  return shards.map((shard) => ({ shard: { first: shard.first_page, last: shard.last_page }, manifestSha256: shard.manifest_sha256, resumes: shard.resumes }));
}

/**
 * Claim and resume queued documents until none is due (or `max`). Returns how many were processed. A no-op while
 * DOCSLURP_FIGURE_RESUME is off or the provider cannot resume (requests stay queued; nothing is lost).
 */
export async function runFigureResumes(deps: FigureResumeDeps, max = 4): Promise<number> {
  if (!figureResumeDeployEnabled(deps.env ?? process.env) || !deps.provider) return 0;
  let processed = 0;
  for (; processed < max; processed += 1) {
    deps.signal?.throwIfAborted();
    const leaseMs = deps.leaseMs ?? Math.max(10 * 60_000, 2 * deps.provider.timeoutMs(1000));
    const row = await claimFigureResume(deps.sql, deps.workerId, leaseMs);
    if (!row) break;
    await resumeClaimed(deps, row);
  }
  return processed;
}

async function resumeClaimed(deps: FigureResumeDeps, row: ClaimedLevel): Promise<void> {
  const scope: DocumentAssetLedgerScope = { orgId: row.org_id, projectId: row.project_id, documentId: row.document_id, runId: row.run_id };
  const document = { id: row.document_id, userId: row.user_id, runId: row.run_id, artifactRoot: row.storage_prefix };
  const started = Date.now();
  let vmMs = 0;
  let outcome: "done" | "retry" | "blocked" = "done";
  let blocked: string | undefined;
  try {
    const adopted = await adoptPendingAssets(deps.sql, deps.storage, { scope, signal: deps.signal });
    const todo = await units(deps.sql, row);
    console.log(`[doppler-figures] resume claim doc=${row.document_id} org=${row.org_id} attempt=${row.resumes + 1} units=${todo.length} adopt=${adopted.adopted} lost=${adopted.lost}`);
    pushPerfMetric({ metric: "figures.resume.claimed", value: 1, unit: "count", tags: ["doppler-figures"], metadata: { documentId: row.document_id } });
    if (adopted.adopted > 0) pushPerfMetric({ metric: "figures.adopted_files", value: adopted.adopted, unit: "count", tags: ["doppler-figures"], metadata: { documentId: row.document_id } });
    for (const unit of todo) {
      deps.signal?.throwIfAborted();
      const result = await resumeUnit(deps, row, scope, document, unit);
      vmMs += result.vmMs;
      if (result.outcome !== "done") outcome = result.outcome;
      if (result.blocked) blocked = result.blocked;
      if (outcome === "blocked") break;
    }
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    // A ledger refusal inside the upload step arrives wrapped (DopplerFigureStoreError's cause).
    const cause = (error as { cause?: unknown } | null)?.cause;
    const ruled = error instanceof DocumentAssetLedgerError || error instanceof DopplerFigureRejection ? error
      : cause instanceof DocumentAssetLedgerError || cause instanceof DopplerFigureRejection ? cause : null;
    const rule = ruled ? ruled.rule : error instanceof Error ? error.name : "error";
    // A reprocess or a newer run overtook this resume: a no-op, never a mix.
    if (rule === "stale-write" || rule === "scope-mismatch") { outcome = "blocked"; blocked = "stale"; }
    else outcome = "retry";
    console.warn(`[doppler-figures] resume ${outcome === "blocked" ? "stale" : "failed"} doc=${row.document_id} rule=${rule}`);
    pushPerfMetric({ metric: outcome === "blocked" ? "figures.resume.stale" : "figures.resume.failed", value: 1, unit: "count", tags: ["doppler-figures"], metadata: { documentId: row.document_id, rule } });
  } finally {
    await release(deps.sql, row, outcome, blocked).catch((error) => console.warn(`[doppler-figures] resume release-failed doc=${row.document_id} error=${error instanceof Error ? error.name : typeof error}`));
    if (vmMs > 0) await recordResumeVmTime(deps.sql, row, vmMs).catch(() => undefined);
  }
  const [level] = await deps.sql<{ images_status: string }[]>`select images_status from document_extraction_levels where document_id = ${row.document_id} and org_id = ${row.org_id}`;
  console.log(`[doppler-figures] resume done doc=${row.document_id} outcome=${level?.images_status ?? "none"} vmMs=${vmMs} ms=${Date.now() - started}`);
  pushPerfMetric({ metric: level?.images_status === "resumable" ? "figures.resume.partial" : "figures.resume.completed", value: 1, unit: "count", tags: ["doppler-figures"], metadata: { documentId: row.document_id } });
}

/** Resume VM time is ours (the failure was ours): a cost-only event through the usage ledger, never a customer charge. */
async function recordResumeVmTime(sql: Client, row: ClaimedLevel, wallTimeMs: number): Promise<void> {
  const profile = resolveWorkerDeploymentProfile();
  const event = buildLocalComputeUsageEvent({
    metric: FIGURE_RESUME_METRIC, profile, observation: buildAllocatedResourceObservation({ profile, wallTimeMs: Math.max(0, wallTimeMs) }),
    costRollup: "included",
    metadata: { stage: "figure-resume", scope: "document", documentId: row.document_id, measurement: "allocated-capacity", billable: false },
  });
  await persistScopedUsageEvents({ client: sql, userId: row.user_id, scope: { orgId: row.org_id, projectId: row.project_id }, usageEvents: [{ ...event, costCents: 0 } as typeof event] });
}

async function resumeUnit(
  deps: FigureResumeDeps, row: ClaimedLevel, scope: DocumentAssetLedgerScope, document: { id: string; userId: string; runId: string; artifactRoot: string | null },
  unit: { shard: { first: number; last: number } | null; manifestSha256: string; resumes: number },
): Promise<{ outcome: "done" | "retry" | "blocked"; blocked?: string; vmMs: number }> {
  const work = await mkdtemp(path.join(tmpdir(), "figure-resume-"));
  let source: string | null = null;
  try {
    // 1. The stored manifest only.
    const manifestDir = path.join(work, "in");
    await downloadDopplerImagesDir({
      storage: deps.storage, document, runId: row.run_id, manifestSha256: unit.manifestSha256, pageCount: row.page_count, dir: manifestDir,
      ...(unit.shard ? { shard: unit.shard } : {}), signal: deps.signal,
    });
    // 2. The source (the provider stages it into its VM; the host never parses it) and a fresh VM.
    if (!row.source_sha256) return { outcome: "blocked", blocked: "refused", vmMs: 0 };
    const sourceKey = deps.storage.bucket ? keyOf(row.source_key, deps.storage.bucket) : row.source_key;
    source = await deps.storage.downloadToTempFile(sourceKey, "figure-resume-source-*.pdf");
    const outDir = path.join(work, "out");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(outDir, { mode: 0o700 });
    const pages = unit.shard ? unit.shard.last - unit.shard.first + 1 : row.page_count;
    const timeoutMs = deps.provider!.timeoutMs(pages);
    const vmStarted = Date.now();
    const raw = await deps.provider!.resume({
      input: source, sourceSha256: row.source_sha256, manifest: path.join(manifestDir, "manifest.jsonl"),
      pages: unit.shard ? [unit.shard.first, unit.shard.last] : null, dir: outDir, limits: dopplerImageLimits(row.page_count), timeoutMs,
    }, deps.signal);
    const vmMs = Date.now() - vmStarted;
    const outcome = parseSandboxedPdfFigureOutcome(raw, 500, row.page_count);
    if (outcome.status === "failed") {
      console.warn(`[doppler-figures] resume failed doc=${row.document_id} pages=${unit.shard ? `${unit.shard.first}-${unit.shard.last}` : "all"} reason=${JSON.stringify(outcome.reason)}`);
      return { outcome: "retry", vmMs };
    }
    // 3. Validated whole; stored images keep their digest and are never uploaded again.
    const stored = new Map((await deps.sql<{ asset_id: string; sha256: string }[]>`
      select asset_id, sha256 from document_assets where org_id = ${row.org_id} and project_id = ${row.project_id} and document_id = ${row.document_id}
        and run_id = ${row.run_id} and storage_state = 'stored'`).map((r) => [r.asset_id, r.sha256]));
    const set = await readDopplerFigureDir(unit.shard ? outDir : outDir, {
      pageCount: row.page_count, signal: deps.signal, expect: outcome.status === "partial" ? "partial" : "complete", sourceSha256: row.source_sha256,
      resume: { stored },
    });
    try {
      const ledger = figureLedgerHooks({ store: { markAssetsPending: (args) => markAssetsPending(deps.sql, args), markAssetsStored: (args) => markAssetsStored(deps.sql, args) }, run: { id: row.run_id, orgId: row.org_id, projectId: row.project_id } }, row.document_id);
      const result = await storeDopplerFigures({ storage: deps.storage, document, runId: row.run_id, figures: set, markdown: "", ...(ledger ? { ledger } : {}), signal: deps.signal });
      const pending = ledgerWriteForStoredFigures({ set, stored: result, outcome });
      await writeDocumentAssetLedger(deps.sql, {
        scope, level: { ...pending.level, markdownComplete: true }, assets: pending.assets,
        resume: unit.shard ? unit.shard : true, ...(pending.shards ? { shards: unit.shard ? pending.shards.filter((s) => s.first === unit.shard!.first) : pending.shards } : {}),
      });
      // The new files are served: their slots join the document's run (scoped by its organization and project).
      const slots: Record<string, string> = {};
      for (const { slot, uri } of result.slots) if (slot.startsWith("doppler-figure:") || slot === "doppler-figures") slots[`${row.document_id}:${slot}`] = uri;
      if (Object.keys(slots).length > 0) {
        await deps.sql`update project_runs set artifacts = coalesce(artifacts, '{}'::jsonb) || ${deps.sql.json(slots)}::jsonb
          where id = ${row.run_id} and org_id = ${row.org_id} and project_id = ${row.project_id}`;
      }
      console.log(`[doppler-figures] resume unit doc=${row.document_id} pages=${unit.shard ? `${unit.shard.first}-${unit.shard.last}` : "all"} added=${result.stats.files} bytes=${result.stats.bytes} vmMs=${vmMs}`);
    } finally {
      await disposeDopplerFigureSet(set);
    }
    return { outcome: "done", vmMs };
  } finally {
    if (source) await rm(source, { force: true }).catch(() => undefined);
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

function keyOf(sourceKey: string, bucket: string): string {
  const prefix = `s3://${bucket}/`;
  return sourceKey.startsWith(prefix) ? sourceKey.slice(prefix.length) : sourceKey;
}

// ---- Orphan GC and audit ----

/** Objects younger than this are never collected (an upload in flight writes its pending row first, but be generous). */
export const FIGURE_ORPHAN_GRACE_MS = 24 * 3600_000;

export interface FigureAuditResult { documents: number; orphans: number; orphanBytes: number; missing: number; sizeMismatch: number }

/**
 * One pass over up to `limit` documents with figure rows (oldest audited first): list each images folder under the
 * roots its rows use, delete objects no row of any run vouches for once they are past the grace period (the only figure
 * deleter besides document, run and tenant purges), and turn a current stored row whose object is missing or of another
 * size into a resumable `aborted` image, queueing a resume. Fixed folder files (manifests, page facts) are never collected.
 */
export async function auditFigureStorage(deps: { sql: Client; storage: FigureResumeStorage; limit?: number; now?: Date }): Promise<FigureAuditResult> {
  const result: FigureAuditResult = { documents: 0, orphans: 0, orphanBytes: 0, missing: 0, sizeMismatch: 0 };
  if (!deps.storage.listKeys) return result;
  const now = deps.now ?? new Date();
  const documents = await deps.sql<Array<{ document_id: string; org_id: string; project_id: string; run_id: string | null }>>`
    select l.document_id, l.org_id, l.project_id, l.run_id from document_extraction_levels l
    where exists (select 1 from document_assets a where a.document_id = l.document_id and a.org_id = l.org_id and a.storage_key is not null)
    order by random()
    limit ${Math.min(Math.max(deps.limit ?? 50, 1), 500)}`;
  for (const doc of documents) {
    result.documents += 1;
    const rows = await deps.sql<Array<{ asset_id: string; storage_key: string; bytes: number; storage_state: string; run_id: string | null }>>`
      select asset_id, storage_key, bytes, storage_state, run_id from document_assets
      where document_id = ${doc.document_id} and org_id = ${doc.org_id} and storage_key is not null`;
    const vouched = new Set(rows.map((row) => row.storage_key));
    // The images folders the rows use (per run root), each strictly this document's own.
    const folders = new Set<string>();
    for (const row of rows) {
      const at = row.storage_key.indexOf(`/${DOPPLER_STORE_LAYOUT.folder}/${doc.document_id}/${DOPPLER_STORE_LAYOUT.imagesFolder}`);
      if (at > 0) folders.add(row.storage_key.slice(0, at + `/${DOPPLER_STORE_LAYOUT.folder}/${doc.document_id}/${DOPPLER_STORE_LAYOUT.imagesFolder}`.length));
    }
    const present = new Set<string>();
    for (const folder of folders) {
      const listed = await deps.storage.listKeys({ prefix: folder, maxKeys: 20_000 });
      for (const key of listed.keys) {
        present.add(key);
        const relative = key.slice(folder.length);
        // Only page files are figures; manifests, page facts and shard manifests are the folder's own.
        if (!/^page-[0-9]{4,10}\/(?:image|figure)-[0-9]{3,7}\.(?:webp|svg|png|jpg)$/.test(relative) || vouched.has(key)) continue;
        const head = deps.storage.headObject ? await deps.storage.headObject(key).catch(() => null) : null;
        if (!head || !head.lastModified || now.getTime() - head.lastModified.getTime() < FIGURE_ORPHAN_GRACE_MS) continue;
        await deps.storage.deleteKeys?.([key]);
        result.orphans += 1;
        result.orphanBytes += head.size;
      }
    }
    // Audit: current stored rows whose object is gone or of another size.
    if (!doc.run_id) continue;
    const lost: string[] = [];
    for (const row of rows) {
      if (row.storage_state !== "stored" || row.run_id !== doc.run_id) continue;
      if (!present.has(row.storage_key)) { lost.push(row.asset_id); result.missing += 1; continue; }
      if (deps.storage.headObject) {
        const head = await deps.storage.headObject(row.storage_key).catch((error) => (isMissingObject(error) ? null : undefined));
        if (head === null) { lost.push(row.asset_id); result.missing += 1; }
        else if (head && head.size !== row.bytes) { lost.push(row.asset_id); result.sizeMismatch += 1; }
      }
    }
    if (lost.length > 0) {
      const scope = { orgId: doc.org_id, projectId: doc.project_id, documentId: doc.document_id, runId: doc.run_id };
      try {
        await markAssetsLost(deps.sql, { scope, ids: lost });
        await deps.sql`update document_extraction_levels set resume_after = coalesce(resume_after, now()), resume_blocked = null
          where document_id = ${doc.document_id} and org_id = ${doc.org_id} and images_status = 'resumable'`;
      } catch (error) {
        if (!(error instanceof DocumentAssetLedgerError)) throw error;
      }
    }
    if (result.orphans > 0 || lost.length > 0) {
      console.log(`[figure-audit] doc=${doc.document_id} orphans=${result.orphans} orphanBytes=${result.orphanBytes} missing=${result.missing} sizeMismatch=${result.sizeMismatch}`);
    }
  }
  if (result.orphanBytes > 0) pushPerfMetric({ metric: "figures.orphan_bytes", value: result.orphanBytes, unit: "bytes", tags: ["figure-audit"], metadata: {} });
  if (result.missing + result.sizeMismatch > 0) pushPerfMetric({ metric: "figures.ledger_storage_drift", value: result.missing + result.sizeMismatch, unit: "count", tags: ["figure-audit"], metadata: {} });
  return result;
}

/** Backlog gauges for SigNoz: queued documents and the oldest one's age. */
export async function figureResumeBacklog(sql: Client): Promise<{ queued: number; oldestAgeS: number }> {
  const [row] = await sql<{ queued: number; oldest: number | null }[]>`
    select count(*)::int as queued, extract(epoch from now() - min(resume_after))::float8 as oldest
    from document_extraction_levels where resume_after is not null and resume_blocked is null and images_status = 'resumable'`;
  return { queued: row?.queued ?? 0, oldestAgeS: Math.max(0, Math.round(row?.oldest ?? 0)) };
}

export { dopplerFigureSlot, dopplerShardFolder };

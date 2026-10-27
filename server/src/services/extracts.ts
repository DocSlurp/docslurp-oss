/**
 * Extract mode: an upload whose source files and every derived asset (page
 * images, Markdown, chunks, vectors, exports) live under
 * `extracts/<org>/<extract>/` and are deleted when the retention window ends.
 *
 * - `createExtract` records the durable expiry row before any byte is stored,
 *   after checking the retention cap and, for a paid window, spend.
 * - Intake (workspace-intake.ts) stores sources under the extract prefix and
 *   run creation stamps the run with `extract_id` and `storage_prefix`, so the
 *   worker writes every artifact there.
 * - `sweepExtracts` (maintenance sweep) settles finished extracts (stored
 *   size, extended-retention charge, run-scoped zip export, completion
 *   email) and deletes expired ones: cancel the run, delete its documents and
 *   run rows (whose BEFORE DELETE triggers queue vector, graph and artifact
 *   cleanup, migration 0035), then empty the storage prefix. Every step is
 *   idempotent, so a crashed or partial pass is resumed by the next one.
 *
 * Every read is tenant-scoped: an extract is visible only to a user who can
 * read its workspace, and to an API key bound to its organization and
 * allowed that workspace. See docs/extract.md.
 */
import { randomUUID } from "node:crypto";

import {
  EXTRACT_FREE_RETENTION_HOURS,
  EXTRACT_MAX_RETENTION_DAYS,
  EXTRACT_PRODUCT,
  EXTRACT_RETENTION_METRIC,
  EXTRACT_RETENTION_STORAGE_MULTIPLIER,
  PRICE_CARD,
  UNIT_CHARGE_PROVIDER,
  documentExportFolderNames,
  extractRetentionCredits,
  extractStoragePrefix,
  isBillingExemptOrg,
  unitChargeMetadata,
  type DocumentExportContent,
  type ExtractOptions,
  type ExtractRecord,
  type ExtractStatus,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { recordCostEvent } from "../lib/ai-usage.js";
import { apiKeyCanUseWorkspace, type RequestActor } from "../lib/request-actor.js";
import { deleteObjectsUnderPrefix, deleteUploadedObject, signDownloadGet } from "../lib/storage.js";
import { signalPipelineCancel, startDocumentExportWorkflow } from "../lib/temporal.js";
import { notifySearchEligibilityChanged } from "../search/eligibility-hint.js";
import { ESTIMATED_ARTIFACT_BYTES_PER_PAGE, ESTIMATED_INDEX_BYTES_PER_PAGE } from "./billing/overview.js";
import { debitOrgCredits } from "./billing/credits.js";
import { assertCanSpend, loadSpendStatus, spendGuardsSkipped, SpendBlockedError } from "./billing/spend-guard.js";
import { isStorageBillingEnabled } from "./billing/storage-meter.js";
import { formatExportBytes } from "./document-exports.js";
import { isNotificationEnabled, sendExtractReadyEmail } from "./notifications.js";
import { listAccessibleWorkspaceIds } from "./organizations.js";
import type { IntakeExtract } from "./workspace-intake.js";

// ---------------------------------------------------------------------------
// Policy

export interface ExtractRetentionPolicy {
  /** Hours every extract is kept for free. */
  freeHours: number;
  /** Longest retention a request may ask for, in days. */
  maxDays: number;
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  console.warn(`[extract] ignoring invalid ${name}=${JSON.stringify(raw)}; using ${fallback}`);
  return fallback;
}

/** DOCSLURP_EXTRACT_FREE_RETENTION_HOURS (default 48) and DOCSLURP_EXTRACT_MAX_RETENTION_DAYS (default 30). */
export function extractRetentionPolicy(source: NodeJS.ProcessEnv = process.env): ExtractRetentionPolicy {
  const freeHours = positiveInteger(source.DOCSLURP_EXTRACT_FREE_RETENTION_HOURS, EXTRACT_FREE_RETENTION_HOURS, "DOCSLURP_EXTRACT_FREE_RETENTION_HOURS");
  const maxDays = positiveInteger(source.DOCSLURP_EXTRACT_MAX_RETENTION_DAYS, EXTRACT_MAX_RETENTION_DAYS, "DOCSLURP_EXTRACT_MAX_RETENTION_DAYS");
  // The cap never falls below the free window.
  return { freeHours, maxDays: Math.max(maxDays, Math.ceil(freeHours / 24)) };
}

export type ExtractErrorCode =
  | "retention_exceeds_cap"
  | "extract_not_found"
  | "extract_expired"
  | "download_not_ready"
  | "download_failed";

/** A reviewed public error for extract requests. */
export class ExtractError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 410,
    readonly code: ExtractErrorCode,
    message: string,
    readonly details?: Record<string, number>,
  ) {
    super(message);
    this.name = "ExtractError";
  }
}

export const EXTRACT_EXPIRED_MESSAGE = "This extract has expired and its files and outputs were deleted. Run the extract again to get new results.";

/** The window a request asks for: the free one when omitted, refused past the cap. */
export function resolveExtractRetention(options: Pick<ExtractOptions, "retentionDays">, policy: ExtractRetentionPolicy = extractRetentionPolicy()): { retentionHours: number; paid: boolean } {
  if (options.retentionDays === undefined) return { retentionHours: policy.freeHours, paid: false };
  if (options.retentionDays > policy.maxDays) {
    throw new ExtractError(400, "retention_exceeds_cap", `retentionDays may be at most ${policy.maxDays}.`, { maxRetentionDays: policy.maxDays });
  }
  const retentionHours = options.retentionDays * 24;
  return { retentionHours, paid: retentionHours > policy.freeHours };
}

/** Stored bytes the storage price applies to: sources plus estimated artifacts and indexes (same model as the daily meter). */
export function estimatedExtractStoredBytes(args: { sourceBytes: number; pages: number }): number {
  return Math.max(0, args.sourceBytes) + Math.max(0, args.pages) * (ESTIMATED_ARTIFACT_BYTES_PER_PAGE + ESTIMATED_INDEX_BYTES_PER_PAGE);
}

/** About one page per 75 KB, for a pre-flight estimate when page counts are unknown. */
const ESTIMATED_SOURCE_BYTES_PER_PAGE = 75 * 1024;

// ---------------------------------------------------------------------------
// Records

interface ExtractRow {
  id: string;
  org_id: string;
  workspace_id: string;
  user_id: string;
  api_key_id: string | null;
  run_id: string | null;
  storage_prefix: string;
  state: "active" | "deleting" | "deleted";
  retention_hours: number;
  paid_retention: boolean;
  expires_at: string;
  notify_email: boolean;
  download_content: DocumentExportContent;
  completed_at: string | null;
  run_status: string | null;
  pages: number | null;
  stored_bytes: string | number | null;
  retention_credits: string | number | null;
  charged_at: string | null;
  export_id: string | null;
  export_skipped: boolean;
  created_at: string;
  deleted_at: string | null;
  /** Joined: the run's live status. */
  live_run_status?: string | null;
  /** Joined: the download export's state. */
  export_status?: string | null;
  export_expires_at?: string | null;
  expired?: boolean;
}

const selectExtract = sql`
  select e.id, e.org_id, e.workspace_id, e.user_id, e.api_key_id, e.run_id, e.storage_prefix, e.state,
    e.retention_hours, e.paid_retention, e.expires_at::text, e.notify_email, e.download_content,
    e.completed_at::text, e.run_status, e.pages, e.stored_bytes, e.retention_credits, e.charged_at::text,
    e.export_id, e.export_skipped, e.created_at::text, e.deleted_at::text,
    r.status as live_run_status, x.status as export_status, x.expires_at::text as export_expires_at,
    (e.state <> 'active' or e.expires_at <= now()) as expired
  from extracts e
  left join workspace_runs r on r.id = e.run_id and r.extract_id = e.id
  left join document_exports x on x.id = e.export_id and x.org_id = e.org_id
`;

function extractStatus(row: ExtractRow): ExtractStatus {
  if (row.expired) return "expired";
  if (!row.run_id) return "pending";
  const run = row.run_status ?? row.live_run_status;
  if (run === "completed") return "completed";
  if (run === "failed") return "failed";
  return "processing";
}

export function extractDownloadPath(id: string): string {
  return `/v1/extracts/${encodeURIComponent(id)}/download`;
}

export function describeExtract(row: ExtractRow): ExtractRecord {
  const status = extractStatus(row);
  const exportLive = row.export_status === "ready" && row.export_expires_at !== null && row.export_expires_at !== undefined
    && new Date(row.export_expires_at).getTime() > Date.now();
  const download: ExtractRecord["download"]["status"] = status === "expired"
    ? "expired"
    : row.export_skipped || row.export_status === "failed"
      ? "failed"
      : exportLive
        ? "ready"
        : row.export_status === "queued" || row.export_status === "running"
          ? "preparing"
          : row.export_status === "ready" || row.export_status === "expired"
            ? "expired"
            : "pending";
  return {
    id: row.id,
    status,
    workspaceId: row.workspace_id,
    runId: row.run_id,
    retentionHours: row.retention_hours,
    paidRetention: row.paid_retention,
    expiresAt: new Date(row.expires_at).toISOString(),
    retentionCredits: row.retention_credits === null ? null : Number(row.retention_credits),
    notifyEmail: row.notify_email,
    download: { content: row.download_content, status: download, url: download === "ready" ? extractDownloadPath(row.id) : null },
    pages: row.pages,
    storedBytes: row.stored_bytes === null ? null : Number(row.stored_bytes),
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at ? new Date(row.completed_at).toISOString() : null,
    deletedAt: row.deleted_at ? new Date(row.deleted_at).toISOString() : null,
  };
}

/**
 * Records a new extract before anything is stored. A paid window first checks
 * the organization may spend and holds enough credits for the estimated
 * charge (when the source size is known); the charge itself is made once the
 * stored size is measured.
 */
export async function createExtract(args: {
  userId: string;
  orgId: string;
  workspaceId: string;
  apiKeyId?: string | null;
  options: ExtractOptions;
  /** Source bytes known up front (bulk files, declared direct-upload sizes), for the spend pre-check. */
  estimatedSourceBytes?: number;
  policy?: ExtractRetentionPolicy;
}): Promise<IntakeExtract> {
  const policy = args.policy ?? extractRetentionPolicy();
  const { retentionHours, paid } = resolveExtractRetention(args.options, policy);
  if (paid) await assertCanAffordRetention({ orgId: args.orgId, workspaceId: args.workspaceId, retentionHours, freeHours: policy.freeHours, sourceBytes: args.estimatedSourceBytes ?? 0 });
  const id = `ext_${randomUUID().replace(/-/g, "")}`;
  const storagePrefix = extractStoragePrefix({ orgId: args.orgId, extractId: id });
  await sql`
    insert into extracts (
      id, org_id, workspace_id, user_id, api_key_id, storage_prefix, retention_hours, paid_retention,
      expires_at, notify_email, download_content
    ) values (
      ${id}, ${args.orgId}, ${args.workspaceId}, ${args.userId}, ${args.apiKeyId ?? null}, ${storagePrefix},
      ${retentionHours}, ${paid}, now() + make_interval(hours => ${retentionHours}),
      ${args.options.notifyEmail ?? true}, ${args.options.download ?? "markdown"}
    )
  `;
  console.log(`[extract] created extract=${id} org=${args.orgId} workspace=${args.workspaceId} retention_hours=${retentionHours} paid=${paid}`);
  return { id, storagePrefix };
}

/**
 * A paid window needs an organization that may spend now (assertCanSpend) and,
 * when billing is enforced, available credits for the estimated retention charge.
 */
async function assertCanAffordRetention(args: { orgId: string; workspaceId: string; retentionHours: number; freeHours: number; sourceBytes: number }): Promise<void> {
  await assertCanSpend(args.orgId, args.workspaceId);
  if (spendGuardsSkipped() || isBillingExemptOrg(args.orgId) || !isStorageBillingEnabled()) return;
  const estimate = extractRetentionCredits({
    bytes: estimatedExtractStoredBytes({ sourceBytes: args.sourceBytes, pages: Math.ceil(args.sourceBytes / ESTIMATED_SOURCE_BYTES_PER_PAGE) }),
    retentionHours: args.retentionHours,
    freeHours: args.freeHours,
  });
  const status = await loadSpendStatus(args.orgId, args.workspaceId);
  if (!status || status.available < estimate) {
    throw new SpendBlockedError(
      `Extended retention needs about ${estimate.toFixed(2)} credits; add credits or use the free ${args.freeHours}-hour window.`,
      "credit_exhausted",
      status?.autoTopUpOn === true,
      { requiredCredits: Number(estimate.toFixed(4)) },
    );
  }
}

/** Links the run intake created; the run row already carries extract_id. */
export async function attachExtractRun(extractId: string, runId: string): Promise<void> {
  await sql`
    update extracts set run_id = ${runId}, updated_at = now()
    where id = ${extractId} and (run_id is null or run_id = ${runId})
      and exists (select 1 from workspace_runs r where r.id = ${runId} and r.extract_id = ${extractId})
  `;
}

/** The record a request that just created this extract returns. */
export async function describeExtractById(id: string): Promise<ExtractRecord | null> {
  const [row] = await sql<ExtractRow[]>`${selectExtract} where e.id = ${id}`;
  return row ? describeExtract(row) : null;
}

/** Intake failed before any run existed: expire now, so the sweep empties whatever reached the prefix. */
export async function abandonExtract(extractId: string): Promise<void> {
  await sql`update extracts set expires_at = least(expires_at, now()), updated_at = now() where id = ${extractId} and run_id is null`;
}

/** The extract a direct upload session was created for, while it may still take files. */
export async function loadIntakeExtract(extractId: string, userId: string): Promise<IntakeExtract | null> {
  const [row] = await sql<{ id: string; storage_prefix: string }[]>`
    select id, storage_prefix from extracts
    where id = ${extractId} and user_id = ${userId} and state = 'active' and expires_at > now()
  `;
  return row ? { id: row.id, storagePrefix: row.storage_prefix } : null;
}

/** May this actor see an extract in `workspaceId` of `orgId`? */
async function actorMaySee(actor: RequestActor, row: Pick<ExtractRow, "workspace_id" | "org_id">): Promise<boolean> {
  if (actor.type === "apiKey" && !apiKeyCanUseWorkspace(actor.apiKey, { id: row.workspace_id, orgId: row.org_id })) return false;
  const workspaceIds = await listAccessibleWorkspaceIds(actor.userId);
  return workspaceIds.includes(row.workspace_id);
}

/**
 * One extract the actor may see: a reader of its workspace, through an API key
 * bound to its organization and allowed that workspace. Null (404) otherwise,
 * so another tenant cannot learn whether an ID exists.
 */
export async function getExtractForActor(id: string, actor: RequestActor): Promise<ExtractRow | null> {
  if (!/^ext_[0-9a-f]{32}$/.test(id)) return null;
  const orgScope = actor.type === "apiKey" ? sql`and e.org_id = ${actor.apiKey.orgId ?? ""}` : sql``;
  const [row] = await sql<ExtractRow[]>`${selectExtract} where e.id = ${id} ${orgScope}`;
  if (!row) return null;
  return (await actorMaySee(actor, row)) ? row : null;
}

export async function listExtractsForActor(actor: RequestActor, limit = 20): Promise<ExtractRecord[]> {
  const workspaceIds = await listAccessibleWorkspaceIds(actor.userId);
  if (workspaceIds.length === 0) return [];
  const orgScope = actor.type === "apiKey" ? sql`and e.org_id = ${actor.apiKey.orgId ?? ""}` : sql``;
  const rows = await sql<ExtractRow[]>`
    ${selectExtract}
    where e.workspace_id = any(${sql.array(workspaceIds)}) ${orgScope}
    order by e.created_at desc limit ${Math.max(1, Math.min(limit, 100))}
  `;
  return rows
    .filter((row) => actor.type !== "apiKey" || apiKeyCanUseWorkspace(actor.apiKey, { id: row.workspace_id, orgId: row.org_id }))
    .map(describeExtract);
}

/**
 * A two-minute signed GET for the extract's zip, minted only after the caller
 * was authorized for this extract and only for its own export object, which
 * must sit inside the extract's prefix. Throws a reviewed ExtractError when
 * there is nothing to sign.
 */
export async function signExtractDownload(row: ExtractRow): Promise<string> {
  if (row.expired) throw new ExtractError(410, "extract_expired", EXTRACT_EXPIRED_MESSAGE);
  if (!row.export_id) {
    if (row.export_skipped) throw new ExtractError(409, "download_failed", "This extract produced no documents to download.");
    throw new ExtractError(409, "download_not_ready", "This extract is still processing. Try again when it completes.");
  }
  const [target] = await sql<{ object_key: string; filename: string }[]>`
    select x.object_key, x.filename from document_exports x
    join extracts e on e.id = ${row.id} and e.export_id = x.id
    where x.id = ${row.export_id} and x.org_id = ${row.org_id} and x.workspace_id = ${row.workspace_id}
      and x.run_id = ${row.run_id} and x.status = 'ready' and x.expires_at > now()
      and e.state = 'active' and e.expires_at > now()
  `;
  if (!target) {
    if (row.export_status === "failed") throw new ExtractError(409, "download_failed", "The download could not be built. Contact support if this keeps happening.");
    throw new ExtractError(409, "download_not_ready", "The download is still being prepared. Try again in a moment.");
  }
  // Defense in depth: only an object inside this extract's prefix is ever signed.
  if (!target.object_key.startsWith(`${row.storage_prefix}/`) || target.object_key.endsWith("/")) {
    console.error(`[extract] refusing to sign an object outside the extract prefix extract=${row.id}`);
    throw new ExtractError(409, "download_failed", "The download could not be built. Contact support if this keeps happening.");
  }
  return await signDownloadGet({ key: target.object_key, filename: target.filename, expiresInSeconds: 120 });
}

/** Delete now: the extract expires immediately and the next sweep removes everything. */
export async function expireExtractNow(row: ExtractRow): Promise<void> {
  await sql`update extracts set expires_at = least(expires_at, now()), updated_at = now() where id = ${row.id} and org_id = ${row.org_id}`;
}

// ---------------------------------------------------------------------------
// Sweep: settle finished extracts, email, delete expired ones.

const SETTLE_BATCH = 50;
const DELETE_BATCH = 10;
const DOCUMENT_DELETE_BATCH = 500;
/** Object pages (1,000 keys each) deleted per extract per pass; the next pass continues. */
const OBJECT_PAGES_PER_PASS = 20;
/** A run still in flight at cancel time may write late artifacts; wait before listing its prefix. */
const IN_FLIGHT_GRACE_MINUTES = 15;
const LEASE_MINUTES = 10;
const MAX_EMAIL_ATTEMPTS = 5;
const ACTIVE_RUN_STATUSES = ["queued", "blocked", "processing"];

export interface ExtractSweepResult {
  settled: number;
  charged: number;
  exportsQueued: number;
  emailed: number;
  deleted: number;
  deletedObjects: number;
  deletedBytes: number;
  /** Largest delay between an extract's expiry and its last object being deleted in this pass, in seconds. */
  maxLagSeconds: number;
  failed: number;
}

export async function sweepExtracts(): Promise<ExtractSweepResult> {
  const result: ExtractSweepResult = { settled: 0, charged: 0, exportsQueued: 0, emailed: 0, deleted: 0, deletedObjects: 0, deletedBytes: 0, maxLagSeconds: 0, failed: 0 };
  await settleFinishedExtracts(result);
  await chargeExtendedRetention(result);
  await queueExtractDownloads(result);
  await sendDueExtractEmails(result);
  await deleteExpiredExtracts(result);
  if (result.settled || result.charged || result.exportsQueued || result.emailed || result.deleted || result.deletedObjects || result.failed) {
    console.log(`[extract-retention] settled=${result.settled} charged=${result.charged} exports=${result.exportsQueued} emailed=${result.emailed} deleted=${result.deleted} deleted_objects=${result.deletedObjects} deleted_bytes=${result.deletedBytes} max_lag_s=${result.maxLagSeconds} failed=${result.failed}`);
  }
  return result;
}

/** A run reached completed or failed: record its pages and stored size once. */
async function settleFinishedExtracts(result: ExtractSweepResult): Promise<void> {
  const settled = await sql<{ id: string }[]>`
    with finished as (
      select e.id, r.status,
        coalesce(sum(d.page_count), 0)::int as pages,
        coalesce(sum(d.file_size), 0)::bigint as source_bytes
      from extracts e
      join workspace_runs r on r.id = e.run_id and r.extract_id = e.id
      left join documents d on d.run_id = r.id and d.workspace_id = e.workspace_id and d.purged_at is null
      where e.state = 'active' and e.completed_at is null and e.expires_at > now()
        and r.status in ('completed', 'failed')
      group by e.id, r.status
      order by min(e.created_at)
      limit ${SETTLE_BATCH}
    )
    update extracts e
    set completed_at = now(), run_status = finished.status, updated_at = now(),
      pages = finished.pages,
      stored_bytes = finished.source_bytes + finished.pages * ${ESTIMATED_ARTIFACT_BYTES_PER_PAGE + ESTIMATED_INDEX_BYTES_PER_PAGE},
      next_email_at = case when e.notify_email then now() else null end
    from finished
    where e.id = finished.id and e.completed_at is null
    returning e.id
  `;
  result.settled += settled.length;
}

/**
 * Extended retention is charged once, on the measured stored size, as a
 * billable unit event (idempotent by its ID) plus the matching credit debit.
 */
async function chargeExtendedRetention(result: ExtractSweepResult): Promise<void> {
  const due = await sql<Array<Pick<ExtractRow, "id" | "org_id" | "workspace_id" | "user_id" | "api_key_id" | "run_id" | "retention_hours" | "stored_bytes" | "pages">>>`
    select id, org_id, workspace_id, user_id, api_key_id, run_id, retention_hours, stored_bytes, pages from extracts
    where state = 'active' and paid_retention and completed_at is not null and charged_at is null
    order by completed_at limit ${SETTLE_BATCH}
  `;
  const policy = extractRetentionPolicy();
  for (const row of due) {
    const bytes = Number(row.stored_bytes ?? 0);
    const credits = isStorageBillingEnabled() ? extractRetentionCredits({ bytes, retentionHours: row.retention_hours, freeHours: policy.freeHours }) : 0;
    try {
      await sql.begin(async (tx) => {
        const client = tx as unknown as typeof sql;
        if (credits > 0) {
          const eventId = `extract-retention:${row.id}`;
          const recorded = await recordCostEvent({
            userId: row.user_id,
            scope: { orgId: row.org_id, workspaceId: row.workspace_id, runId: row.run_id ?? undefined, apiKeyId: row.api_key_id },
            client,
            event: {
              id: eventId,
              provider: UNIT_CHARGE_PROVIDER,
              model: "extract-retention",
              metric: EXTRACT_RETENTION_METRIC,
              amount: bytes / 1024 ** 3,
              unit: "gb-retention",
              costCents: credits,
              metadata: unitChargeMetadata({
                product: EXTRACT_PRODUCT,
                extractId: row.id,
                retentionHours: row.retention_hours,
                freeHours: policy.freeHours,
                storageGbMonth: PRICE_CARD.storageGbMonth,
                multiplier: EXTRACT_RETENTION_STORAGE_MULTIPLIER,
                storedBytes: bytes,
                pages: row.pages ?? 0,
                // Artifact and index bytes are estimated from page counts, as in the daily meter.
                estimate: true,
              }),
            },
          });
          if (recorded) {
            await debitOrgCredits(client, {
              orgId: row.org_id,
              credits,
              userId: row.user_id,
              reason: "storage",
              metadata: { extractId: row.id, usageEventId: eventId },
            });
          }
        }
        await client`update extracts set retention_credits = ${credits}, charged_at = now(), updated_at = now() where id = ${row.id} and charged_at is null`;
      });
      result.charged += 1;
    } catch (error) {
      result.failed += 1;
      console.error(`[extract-retention] charge failed extract=${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * The download: a zip export scoped to the extract's run, written under the
 * extract prefix and never outliving the extract (max_expires_at). Not
 * emailed by the export sweep: the extract email covers it.
 */
async function queueExtractDownloads(result: ExtractSweepResult): Promise<void> {
  const due = await sql<Array<Pick<ExtractRow, "id" | "org_id" | "workspace_id" | "user_id" | "run_id" | "storage_prefix" | "download_content" | "expires_at"> & { documents: number; filename: string | null; workspace_name: string | null }>>`
    select e.id, e.org_id, e.workspace_id, e.user_id, e.run_id, e.storage_prefix, e.download_content, e.expires_at::text,
      (select count(*)::int from documents d where d.run_id = e.run_id and d.workspace_id = e.workspace_id and d.status = 'completed' and d.purged_at is null) as documents,
      (select min(d.filename) from documents d where d.run_id = e.run_id and d.workspace_id = e.workspace_id and d.status = 'completed') as filename,
      (select w.name from workspaces w where w.id = e.workspace_id) as workspace_name
    from extracts e
    where e.state = 'active' and e.expires_at > now() and e.completed_at is not null
      and e.export_id is null and not e.export_skipped
    order by e.completed_at limit ${SETTLE_BATCH}
  `;
  for (const row of due) {
    if (row.documents === 0) {
      await sql`update extracts set export_skipped = true, updated_at = now() where id = ${row.id} and export_id is null`;
      continue;
    }
    const exportId = `exp_${randomUUID().replace(/-/g, "")}`;
    const base = row.documents === 1 && row.filename ? documentExportFolderNames([row.filename])[0]! : `extract-${row.id.slice(4, 12)}`;
    try {
      const claimed = await sql.begin(async (tx) => {
        const client = tx as unknown as typeof sql;
        const [claim] = await client<{ id: string }[]>`
          update extracts set export_id = ${exportId}, updated_at = now()
          where id = ${row.id} and export_id is null and state = 'active' returning id
        `;
        if (!claim) return false;
        await client`
          insert into document_exports (
            id, org_id, workspace_id, user_id, document_id, run_id, content, filename, object_key,
            document_count, estimated_bytes, notify_email, expires_at, max_expires_at
          ) values (
            ${exportId}, ${row.org_id}, ${row.workspace_id}, ${row.user_id}, null, ${row.run_id}, ${row.download_content},
            ${`${base}.zip`}, ${`${row.storage_prefix}/exports/${exportId}/`},
            ${row.documents}, 0, false, ${row.expires_at}::timestamptz, ${row.expires_at}::timestamptz
          )
        `;
        return true;
      });
      if (!claimed) continue;
      try {
        await startDocumentExportWorkflow({ exportId }, { large: false });
        result.exportsQueued += 1;
      } catch (error) {
        await sql`update document_exports set status = 'failed', completed_at = now(), error = 'The download could not be started.' where id = ${exportId}`;
        throw error;
      }
    } catch (error) {
      result.failed += 1;
      console.error(`[extract] download export failed extract=${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** Completion email: once the download is ready (or could not be built), to the requester, if they still can read the workspace. */
async function sendDueExtractEmails(result: ExtractSweepResult): Promise<void> {
  const due = await sql<Array<ExtractRow & { email: string; email_attempts: number; workspace_name: string | null }>>`
    update extracts e
    set emailed_at = now(), email_attempts = e.email_attempts + 1, updated_at = now()
    from "user" u
    where u.id = e.user_id and u.deleted_at is null
      and e.notify_email and e.emailed_at is null and e.completed_at is not null
      and e.state = 'active' and e.expires_at > now()
      and e.email_attempts < ${MAX_EMAIL_ATTEMPTS} and (e.next_email_at is null or e.next_email_at <= now())
      and (e.export_skipped or exists (
        select 1 from document_exports x where x.id = e.export_id and x.status in ('ready', 'failed')
      ))
    returning e.id, e.org_id, e.workspace_id, e.user_id, e.run_id, e.storage_prefix, e.retention_hours, e.expires_at::text,
      e.export_id, e.export_skipped, e.pages, u.email, e.email_attempts,
      (select x.status from document_exports x where x.id = e.export_id) as export_status,
      (select w.name from workspaces w where w.id = e.workspace_id) as workspace_name
  `;
  for (const row of due) {
    const access = await listAccessibleWorkspaceIds(row.user_id);
    if (!access.includes(row.workspace_id)) continue;
    const ready = row.export_status === "ready";
    // The user's run notification settings apply: completed for a ready download, failed otherwise.
    if (!await isNotificationEnabled(row.user_id, ready ? "run.completed" : "run.failed").catch(() => true)) continue;
    try {
      await sendExtractReadyEmail({
        userId: row.user_id,
        recipientEmail: row.email,
        orgId: row.org_id,
        workspaceId: row.workspace_id,
        extractId: row.id,
        ready,
        pages: row.pages ?? 0,
        expiresAt: new Date(row.expires_at),
        // The app signs the user in first, then downloads through the authenticated export route.
        url: ready && row.export_id ? extractAppUrl(row.export_id) : extractAppUrl(null),
      });
      result.emailed += 1;
    } catch (error) {
      const giveUp = row.email_attempts >= MAX_EMAIL_ATTEMPTS;
      console.error(`[extract] email failed extract=${row.id} attempt=${row.email_attempts}${giveUp ? " giving up" : ""}: ${error instanceof Error ? error.message : String(error)}`);
      if (!giveUp) {
        await sql`update extracts set emailed_at = null, next_email_at = now() + make_interval(mins => ${2 ** (row.email_attempts - 1)}) where id = ${row.id}`.catch(() => undefined);
      }
    }
  }
}

/**
 * The emailed link: the app's signed-in download page for the extract's
 * export. It names the export, it is not a credential: the app requires
 * sign-in, the export route checks the requester and workspace access, and
 * only then redirects to a two-minute signed URL for that one object.
 */
export function extractAppUrl(exportId: string | null): string {
  const base = (process.env.APP_URL ?? "http://localhost:4321").replace(/\/$/, "");
  return exportId ? `${base}/app?export=${encodeURIComponent(exportId)}` : `${base}/app`;
}

interface DeletionClaim {
  id: string;
  org_id: string;
  workspace_id: string;
  storage_prefix: string;
  expires_at: string;
  purge_after: string | null;
  deleted_objects: string | number;
  deleted_bytes: string | number;
}

async function deleteExpiredExtracts(result: ExtractSweepResult): Promise<void> {
  const claimed = await sql<DeletionClaim[]>`
    update extracts e
    set state = 'deleting', deletion_started_at = coalesce(e.deletion_started_at, now()),
      deletion_attempts = e.deletion_attempts + 1, lease_expires_at = now() + make_interval(mins => ${LEASE_MINUTES}),
      updated_at = now()
    where e.id in (
      select id from extracts
      where state <> 'deleted' and expires_at <= now()
        and (lease_expires_at is null or lease_expires_at <= now())
        and (purge_after is null or purge_after <= now() or state = 'active')
      order by expires_at limit ${DELETE_BATCH}
      for update skip locked
    )
    returning e.id, e.org_id, e.workspace_id, e.storage_prefix, e.expires_at::text, e.purge_after::text, e.deleted_objects, e.deleted_bytes
  `;
  for (const row of claimed) {
    try {
      const outcome = await deleteExtract(row);
      result.deletedObjects += outcome.objects;
      result.deletedBytes += outcome.bytes;
      if (outcome.done) {
        result.deleted += 1;
        result.maxLagSeconds = Math.max(result.maxLagSeconds, outcome.lagSeconds);
      }
    } catch (error) {
      result.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[extract-retention] delete failed extract=${row.id}: ${message}`);
      // Raw detail stays internal (telemetry and this column); public reads never return it.
      await sql`update extracts set last_error = ${message.slice(0, 1000)}, lease_expires_at = now() + interval '1 minute', updated_at = now() where id = ${row.id}`.catch(() => undefined);
    }
  }
}

/**
 * One deletion pass for an expired extract. Rows go first (the triggers queue
 * the vector, graph and artifact cleanup the worker drains), then the prefix
 * is emptied a bounded number of pages at a time. Done once the prefix lists
 * empty and no run of the extract is left.
 */
export async function deleteExtract(row: DeletionClaim): Promise<{ objects: number; bytes: number; done: boolean; lagSeconds: number }> {
  // Every run of this extract (normally one; also one a racing confirm created).
  const runs = await sql<{ id: string; status: string }[]>`
    select id, status from workspace_runs where extract_id = ${row.id} and org_id = ${row.org_id}
  `;
  let inFlight = false;
  for (const run of runs.filter((candidate) => ACTIVE_RUN_STATUSES.includes(candidate.status))) {
    inFlight = true;
    await signalPipelineCancel(run.id).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!/not found/i.test(message)) console.warn(`[extract-retention] could not cancel workflow run=${run.id}: ${message}`);
    });
    await sql`
      update workspace_runs
      set status = 'failed', control_state = 'cancelled', control_requested_at = now(),
          error = 'The extract expired.', lease_expires_at = now(), updated_at = now()
      where id = ${run.id} and status = any(${sql.array(ACTIVE_RUN_STATUSES)})
    `;
  }
  if (inFlight) {
    await sql`update extracts set purge_after = greatest(coalesce(purge_after, now()), now() + make_interval(mins => ${IN_FLIGHT_GRACE_MINUTES})) where id = ${row.id}`;
  }
  await sql`
    update upload_sessions set status = 'aborted', updated_at = now()
    where extract_id = ${row.id} and status in ('initializing', 'pending', 'uploading')
  `;

  const runIds = runs.map((run) => run.id);
  if (runIds.length > 0) {
    // Withdraw any zip holding the extract's documents (its own download, and
    // workspace exports that included them) before the documents go.
    const exported = await sql<{ id: string; object_key: string }[]>`
      select x.id, x.object_key from document_exports x
      where x.org_id = ${row.org_id} and (
        x.run_id = any(${sql.array(runIds)})
        or x.document_ids && array(select d.id from documents d where d.run_id = any(${sql.array(runIds)}))
        or x.document_id in (select d.id from documents d where d.run_id = any(${sql.array(runIds)}))
      )
    `;
    for (const item of exported) {
      if (!item.object_key.endsWith("/") && !item.object_key.startsWith(`${row.storage_prefix}/`)) await deleteUploadedObject(item.object_key);
      await sql`delete from document_exports where id = ${item.id}`;
    }
    for (;;) {
      const deleted = await sql<{ id: string }[]>`
        delete from documents where id in (
          select id from documents where run_id = any(${sql.array(runIds)}) and org_id = ${row.org_id}
          order by id limit ${DOCUMENT_DELETE_BATCH}
        ) returning id
      `;
      if (deleted.length < DOCUMENT_DELETE_BATCH) break;
    }
    await sql`delete from workspace_runs where id = any(${sql.array(runIds)}) and extract_id = ${row.id}`;
    await notifySearchEligibilityChanged(sql, [row.workspace_id]).catch(() => undefined);
  }

  const [timing] = await sql<{ purge_due: boolean }[]>`
    select (purge_after is null or purge_after <= now()) as purge_due from extracts where id = ${row.id}
  `;
  if (!timing?.purge_due) {
    // Late writes of the cancelled run are still possible; list the prefix after the grace period.
    await sql`update extracts set lease_expires_at = null, updated_at = now() where id = ${row.id}`;
    return { objects: 0, bytes: 0, done: false, lagSeconds: 0 };
  }

  let objects = 0;
  let bytes = 0;
  let done = false;
  for (let page = 0; page < OBJECT_PAGES_PER_PASS; page += 1) {
    const pass = await deleteObjectsUnderPrefix(`${row.storage_prefix}/`);
    objects += pass.objects;
    bytes += pass.bytes;
    if (pass.done) { done = true; break; }
  }
  if (!done) {
    await sql`update extracts set deleted_objects = deleted_objects + ${objects}, deleted_bytes = deleted_bytes + ${bytes},
      lease_expires_at = null, updated_at = now() where id = ${row.id}`;
    return { objects, bytes, done: false, lagSeconds: 0 };
  }
  const [finished] = await sql<{ lag_seconds: number; total_objects: string; total_bytes: string }[]>`
    update extracts
    set state = 'deleted', deleted_at = now(), deleted_objects = deleted_objects + ${objects},
      deleted_bytes = deleted_bytes + ${bytes}, lease_expires_at = null, last_error = null, updated_at = now()
    where id = ${row.id}
      and not exists (select 1 from workspace_runs r where r.extract_id = ${row.id})
    returning extract(epoch from now() - expires_at)::int as lag_seconds, deleted_objects::text as total_objects, deleted_bytes::text as total_bytes
  `;
  if (!finished) {
    // A run appeared meanwhile (a confirm raced the expiry): the next pass deletes it too.
    await sql`update extracts set deleted_objects = deleted_objects + ${objects}, deleted_bytes = deleted_bytes + ${bytes}, lease_expires_at = null where id = ${row.id}`;
    return { objects, bytes, done: false, lagSeconds: 0 };
  }
  console.log(`[extract-retention] deleted extract=${row.id} org=${row.org_id} objects=${finished.total_objects} bytes=${finished.total_bytes} lag_s=${finished.lag_seconds} size=${formatExportBytes(Number(finished.total_bytes))}`);
  return { objects, bytes, done: true, lagSeconds: finished.lag_seconds };
}

import { randomUUID } from "node:crypto";

import {
  DOCUMENT_EXPORT_EMAIL_THRESHOLD_BYTES,
  DOCUMENT_EXPORT_MAX_BYTES,
  DOCUMENT_EXPORT_MAX_DOCUMENTS,
  DOCUMENT_EXPORT_TTL_DAYS,
  documentExportFolderNames,
  documentExportObjectKey,
  safeExportName,
  type DocumentExport,
  type DocumentExportContent,
  type DocumentExportStatus,
} from "@docslurp/shared";

import { env } from "../config.js";
import { sql } from "../db.js";
import { fileUrlForArtifact } from "../lib/file-urls.js";
import { deleteUploadedObject } from "../lib/storage.js";
import { startDocumentExportWorkflow } from "../lib/temporal.js";
import { sendExportReadyEmail } from "./notifications.js";
import { listAccessibleWorkspaceIds } from "./organizations.js";

/**
 * Zip exports. The server checks access, estimates the size, records the export
 * and queues the worker (worker/src/exports); it never builds archives itself.
 * Large exports are emailed when ready. Every link lives DOCUMENT_EXPORT_TTL_DAYS;
 * the maintenance sweep deletes expired objects.
 */

/** Unfinished exports one user may have at once. */
const MAX_ACTIVE_EXPORTS_PER_USER = 3;
/** Rendered page images average about this much; only for the size estimate. */
const ESTIMATED_PAGE_IMAGE_BYTES = 300 * 1024;
/**
 * An export still unfinished this long after it was queued is reported failed.
 * Longer than the worker's whole retry budget (4 attempts of up to 2 hours,
 * inside a 9-hour workflow), so a slow but healthy build is never failed early.
 */
const STALLED_EXPORT_HOURS = 10;

export class DocumentExportError extends Error {
  constructor(readonly status: 404 | 413 | 429, readonly code: "not_found" | "payload_too_large" | "rate_limited", message: string) {
    super(message);
  }
}

interface ExportRecordRow {
  id: string;
  org_id: string;
  workspace_id: string;
  user_id: string;
  document_id: string | null;
  content: DocumentExportContent;
  status: DocumentExportStatus;
  filename: string;
  object_key: string;
  document_count: number;
  estimated_bytes: string | number;
  size_bytes: string | number | null;
  skipped_count: number | null;
  notify_email: boolean;
  error: string | null;
  created_at: string;
  completed_at: string | null;
  expires_at: string;
}

const recordColumns = sql`
  id, org_id, workspace_id, user_id, document_id, content, status, filename, object_key, document_count,
  estimated_bytes, size_bytes, skipped_count, notify_email, error,
  created_at::text, completed_at::text, expires_at::text
`;

function downloadPath(id: string): string {
  return `/v1/exports/${encodeURIComponent(id)}/download`;
}

function toExport(row: ExportRecordRow): DocumentExport {
  const live = row.status === "ready" && new Date(row.expires_at).getTime() > Date.now();
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    documentId: row.document_id,
    content: row.content,
    status: row.status === "ready" && !live ? "expired" : row.status,
    filename: row.filename,
    documentCount: row.document_count,
    estimatedBytes: Number(row.estimated_bytes),
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    skippedCount: row.skipped_count,
    notifyEmail: row.notify_email,
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    downloadUrl: live ? downloadPath(row.id) : null,
  };
}

/** Bytes, MB and GB as a person reads them. */
export function formatExportBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Size estimate from stored counters: extracted text (whole-document and
 * per-page Markdown), plus originals and rendered page images for "all".
 */
async function estimateExport(args: { workspaceId: string; documentId: string | null; content: DocumentExportContent }) {
  // The same documents, in the same order and up to the same cap, as the worker exports.
  const [row] = await sql<{ documents: number; text_bytes: string; file_bytes: string; page_images: string }[]>`
    with target as (
      select d.id, d.run_id, d.stored_page_text_bytes, d.file_size
      from documents d
      where d.workspace_id = ${args.workspaceId}
        and d.purged_at is null
        and ${args.documentId
          ? sql`d.id = ${args.documentId}`
          : sql`d.superseded_at is null and d.archived_at is null
              and not exists (select 1 from documents newer where newer.previous_version_id = d.id)`}
      order by lower(d.filename), d.created_at
      limit ${DOCUMENT_EXPORT_MAX_DOCUMENTS}
    ),
    -- Each run's artifact map is scanned once, however many of its documents are exported.
    images as (
      select count(*)::bigint as n
      from (select distinct run_id from target where run_id is not null) runs
      join workspace_runs r on r.id = runs.run_id
      cross join lateral jsonb_object_keys(coalesce(r.artifacts, '{}'::jsonb)) as slot
      where slot ~ '^[^:]+:page-[0-9]+$' and split_part(slot, ':', 1) in (select id from target)
    )
    select
      (select count(*)::int from target) as documents,
      (select coalesce(sum(stored_page_text_bytes), 0)::bigint from target) as text_bytes,
      (select coalesce(sum(file_size), 0)::bigint from target) as file_bytes,
      (select n from images) as page_images
  `;
  const documents = row?.documents ?? 0;
  const text = Number(row?.text_bytes ?? 0);
  const estimated = 2 * text + 8 * 1024 * Math.max(documents, 1)
    + (args.content === "all" ? Number(row?.file_bytes ?? 0) + Number(row?.page_images ?? 0) * ESTIMATED_PAGE_IMAGE_BYTES + text : 0);
  return { documents, estimatedBytes: estimated };
}

/** A live document the user can read, with what an export needs to name and scope it. */
export async function findExportableDocument(documentId: string, userId: string): Promise<{ id: string; filename: string; workspaceId: string; orgId: string } | null> {
  const workspaceIds = await listAccessibleWorkspaceIds(userId);
  if (workspaceIds.length === 0) return null;
  const [row] = await sql<{ id: string; filename: string; workspace_id: string; org_id: string }[]>`
    select id, filename, workspace_id, org_id from documents
    where id = ${documentId} and workspace_id = any(${sql.array(workspaceIds)}) and purged_at is null
  `;
  return row ? { id: row.id, filename: row.filename, workspaceId: row.workspace_id, orgId: row.org_id } : null;
}

export async function requestDocumentExport(args: {
  userId: string;
  content: DocumentExportContent;
  /** Exactly one of document or workspace, already authorized by the caller. */
  document?: { id: string; filename: string; workspaceId: string; orgId: string } | null;
  workspace?: { id: string; name: string; orgId: string } | null;
}): Promise<DocumentExport> {
  const target = args.document
    ? { workspaceId: args.document.workspaceId, orgId: args.document.orgId, documentId: args.document.id, name: documentExportFolderNames([args.document.filename])[0]! }
    : args.workspace
      ? { workspaceId: args.workspace.id, orgId: args.workspace.orgId, documentId: null, name: safeExportName(args.workspace.name, "workspace") }
      : null;
  if (!target) throw new DocumentExportError(404, "not_found", "Document or workspace not found");

  const { documents, estimatedBytes } = await estimateExport({ workspaceId: target.workspaceId, documentId: target.documentId, content: args.content });
  if (documents === 0) throw new DocumentExportError(404, "not_found", "There are no documents to export yet.");
  if (estimatedBytes > DOCUMENT_EXPORT_MAX_BYTES) {
    throw new DocumentExportError(
      413,
      "payload_too_large",
      `This export would be about ${formatExportBytes(estimatedBytes)}, over the ${formatExportBytes(DOCUMENT_EXPORT_MAX_BYTES)} limit. Export Markdown only, or export documents one at a time.`,
    );
  }

  const [active] = await sql<{ count: number }[]>`
    select count(*)::int as count from document_exports
    where user_id = ${args.userId} and status in ('queued', 'running') and created_at > now() - make_interval(hours => ${STALLED_EXPORT_HOURS})
  `;
  if ((active?.count ?? 0) >= MAX_ACTIVE_EXPORTS_PER_USER) {
    throw new DocumentExportError(429, "rate_limited", "You already have exports in progress. Try again when one finishes.");
  }

  const id = `exp_${randomUUID().replace(/-/g, "")}`;
  const [row] = await sql<ExportRecordRow[]>`
    insert into document_exports (
      id, org_id, workspace_id, user_id, document_id, content, filename, object_key,
      document_count, estimated_bytes, notify_email, expires_at
    ) values (
      ${id}, ${target.orgId}, ${target.workspaceId}, ${args.userId}, ${target.documentId}, ${args.content},
      ${`${target.name}.zip`}, ${documentExportObjectKey({ orgId: target.orgId, workspaceId: target.workspaceId, exportId: id })},
      ${documents}, ${estimatedBytes}, ${estimatedBytes > DOCUMENT_EXPORT_EMAIL_THRESHOLD_BYTES},
      now() + make_interval(days => ${DOCUMENT_EXPORT_TTL_DAYS})
    )
    returning ${recordColumns}
  `;
  try {
    await startDocumentExportWorkflow({ exportId: id });
  } catch (error) {
    await sql`update document_exports set status = 'failed', completed_at = now(), error = 'The export could not be started. Try again in a moment.' where id = ${id}`;
    throw error;
  }
  return toExport(row!);
}

/** An export the user requested, while they can still read its workspace. */
export async function getDocumentExport(id: string, userId: string): Promise<(DocumentExport & { orgId: string }) | null> {
  const workspaceIds = await listAccessibleWorkspaceIds(userId);
  if (workspaceIds.length === 0) return null;
  const [row] = await sql<ExportRecordRow[]>`
    select ${recordColumns} from document_exports
    where id = ${id} and user_id = ${userId} and workspace_id = any(${sql.array(workspaceIds)})
  `;
  return row ? { ...toExport(row), orgId: row.org_id } : null;
}

export async function listDocumentExports(
  userId: string,
  options: { limit?: number; allowWorkspace?: (workspace: { id: string; orgId: string }) => boolean } = {},
): Promise<DocumentExport[]> {
  const workspaceIds = await listAccessibleWorkspaceIds(userId);
  if (workspaceIds.length === 0) return [];
  const rows = await sql<ExportRecordRow[]>`
    select ${recordColumns} from document_exports
    where user_id = ${userId} and workspace_id = any(${sql.array(workspaceIds)})
    order by created_at desc limit ${Math.max(1, Math.min(options.limit ?? 20, 100))}
  `;
  return rows
    .filter((row) => options.allowWorkspace?.({ id: row.workspace_id, orgId: row.org_id }) ?? true)
    .map(toExport);
}

/**
 * A file-proxy URL (routes/files.ts) for a ready, unexpired export, bound to the
 * caller's session or key. The proxy re-checks the export on every read
 * (userCanAccessArtifactUri), so expiry and lost access apply to issued links.
 * Must run inside the authenticated request.
 */
export async function documentExportFileUrl(id: string, userId: string): Promise<string | null> {
  const workspaceIds = await listAccessibleWorkspaceIds(userId);
  if (workspaceIds.length === 0) return null;
  const [row] = await sql<Pick<ExportRecordRow, "object_key" | "filename">[]>`
    select object_key, filename from document_exports
    where id = ${id} and user_id = ${userId} and workspace_id = any(${sql.array(workspaceIds)})
      and status = 'ready' and expires_at > now()
  `;
  return row ? fileUrlForArtifact(`s3://${env.s3Bucket}/${row.object_key}`, row.filename).url : null;
}

/** The page in the app that downloads an export after sign-in. */
export function exportAppUrl(id: string): string {
  return `${env.appUrl.replace(/\/$/, "")}/app?export=${encodeURIComponent(id)}`;
}

/**
 * Maintenance sweep: email finished large exports, delete expired objects, and
 * report exports that stalled. Each step claims rows with a conditional update,
 * so concurrent API instances never email or delete twice.
 */
export async function sweepDocumentExports(): Promise<void> {
  const due = await sql<(ExportRecordRow & { email: string | null })[]>`
    update document_exports e set emailed_at = now()
    from "user" u
    where u.id = e.user_id and u.deleted_at is null and e.notify_email and e.emailed_at is null and e.status in ('ready', 'failed')
    returning ${sql`e.id, e.org_id, e.workspace_id, e.user_id, e.document_id, e.content, e.status, e.filename, e.object_key,
      e.document_count, e.estimated_bytes, e.size_bytes, e.skipped_count, e.notify_email, e.error,
      e.created_at::text, e.completed_at::text, e.expires_at::text, u.email`}
  `;
  for (const row of due) {
    if (!row.email) continue;
    await sendExportReadyEmail({
      userId: row.user_id,
      recipientEmail: row.email,
      orgId: row.org_id,
      workspaceId: row.workspace_id,
      filename: row.filename,
      ready: row.status === "ready",
      sizeLabel: row.size_bytes === null ? null : formatExportBytes(Number(row.size_bytes)),
      expiresAt: new Date(row.expires_at),
      url: exportAppUrl(row.id),
    }).catch(async (error) => {
      console.error(`[document-export] email failed export=${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      // Release the claim so the next sweep retries.
      await sql`update document_exports set emailed_at = null where id = ${row.id}`.catch(() => undefined);
    });
  }

  await sql`
    update document_exports
    set status = 'failed', completed_at = now(), error = 'The export took too long and was stopped. Try again, or export fewer documents.'
    where status in ('queued', 'running') and created_at < now() - make_interval(hours => ${STALLED_EXPORT_HOURS})
  `;

  // Expired exports, and exports whose document, workspace or requester is gone
  // (deleted, purged, or the organization offboarded). The object is deleted
  // first, so a failed delete is retried by the next sweep rather than leaving
  // an orphan; deleting a missing key succeeds. An orphan's row is then removed,
  // since it names a document or workspace that no longer exists.
  const removable = await sql<{ id: string; object_key: string; status: string; orphaned: boolean }[]>`
    select id, object_key, status, orphaned from (
      select e.id, e.object_key, e.status, e.expires_at, (
        not exists (select 1 from workspaces w where w.id = e.workspace_id)
        or not exists (select 1 from "user" u where u.id = e.user_id and u.deleted_at is null)
        or (e.document_id is not null and not exists (
          select 1 from documents d where d.id = e.document_id and d.purged_at is null))
      ) as orphaned
      from document_exports e
    ) candidates
    where (status <> 'expired' and expires_at <= now()) or orphaned
    order by expires_at
    limit 200
  `;
  for (const row of removable) {
    try {
      if (row.status !== "expired") await deleteUploadedObject(row.object_key);
      if (row.orphaned) await sql`delete from document_exports where id = ${row.id}`;
      else await sql`update document_exports set status = 'expired' where id = ${row.id} and status <> 'expired'`;
    } catch (error) {
      console.error(`[document-export] delete failed export=${row.id} key=${row.object_key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (removable.length > 0) console.log(`[document-export] expired=${removable.length}`);
  // Expired rows stay a month so the app can say a link expired, then go.
  await sql`delete from document_exports where status = 'expired' and expires_at < now() - interval '30 days'`;
}
